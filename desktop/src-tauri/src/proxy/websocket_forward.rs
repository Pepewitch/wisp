//! WebSocket handshake policy and bidirectional frame relay.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::FromRequestParts;
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use http::header::{AUTHORIZATION, CONTENT_TYPE, SEC_WEBSOCKET_PROTOCOL, UPGRADE};
use http::{HeaderMap, HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite;
use url::Url;

use crate::registry::{ConnectionKind, RegistryError, Target};
use crate::urls::to_websocket_url;

use super::header_policy::{bearer, refuse, PROXY_ERROR_HEADER, RESPONSE_HEADER_DENYLIST};
use super::{stale_route, ProxyState};

pub(super) fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    headers
        .get(UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
}

pub(super) async fn proxy_websocket(
    state: Arc<ProxyState>,
    target: Target,
    mut credential: String,
    upstream: Url,
    parts: &mut http::request::Parts,
) -> Response {
    use tungstenite::client::IntoClientRequest;

    if !state.registry.route_is_current(&target) {
        return stale_route();
    }

    let socket_url = to_websocket_url(&upstream);
    // Only the subprotocol crosses over. Everything else in a handshake is
    // connection-scoped and is generated fresh by the client library.
    let requested_protocol = parts.headers.get(SEC_WEBSOCKET_PROTOCOL).cloned();
    let mut retried_local_credential = false;
    let (upstream_socket, handshake) = loop {
        let mut request = match socket_url.as_str().into_client_request() {
            Ok(request) => request,
            Err(error) => {
                return refuse(
                    StatusCode::BAD_REQUEST,
                    "path",
                    format!("that terminal address is not usable: {error}"),
                )
            }
        };
        if let Some(protocol) = &requested_protocol {
            request
                .headers_mut()
                .insert(SEC_WEBSOCKET_PROTOCOL, protocol.clone());
        }
        request
            .headers_mut()
            .insert(AUTHORIZATION, bearer(&credential));

        let connected = match tokio::time::timeout(
            state.upstream_handshake_timeout,
            tokio_tungstenite::connect_async_tls_with_config(request, None, false, None),
        )
        .await
        {
            Ok(connected) => connected,
            Err(_) => {
                return refuse(
                    StatusCode::GATEWAY_TIMEOUT,
                    "upstream-timeout",
                    "the daemon did not complete the terminal handshake in time",
                )
            }
        };
        match connected {
            Ok(pair) => break pair,
            Err(tungstenite::Error::Http(rejection))
                if target.kind == ConnectionKind::Local
                    && !retried_local_credential
                    && matches!(
                        rejection.status(),
                        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
                    ) =>
            {
                match state.registry.reload_local_credential(&target) {
                    Ok(refreshed) if refreshed != credential => {
                        credential = refreshed;
                        retried_local_credential = true;
                    }
                    Ok(_) => return forward_upgrade_rejection(*rejection),
                    Err(RegistryError::LocalProfileChanged) => {
                        return refuse(
                            StatusCode::CONFLICT,
                            "local-profile-changed",
                            RegistryError::LocalProfileChanged.to_string(),
                        )
                    }
                    Err(error) => {
                        return refuse(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "local-credential-unavailable",
                            error.to_string(),
                        )
                    }
                }
            }
            // The daemon's refusal is the answer; do not turn it into a
            // generic proxy failure. A Local credential is retried only once.
            Err(tungstenite::Error::Http(rejection)) => {
                return forward_upgrade_rejection(*rejection)
            }
            Err(error) => {
                return refuse(
                    StatusCode::BAD_GATEWAY,
                    "upstream",
                    format!("could not open the terminal socket: {error}"),
                )
            }
        }
    };

    let negotiated = handshake
        .headers()
        .get(SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    let mut upgrade = match WebSocketUpgrade::from_request_parts(parts, &()).await {
        Ok(upgrade) => upgrade,
        Err(rejection) => return rejection.into_response(),
    };
    if let Some(protocol) = negotiated {
        upgrade = upgrade.protocols([protocol]);
    }
    if !state.registry.route_is_current(&target) {
        return stale_route();
    }
    upgrade.on_upgrade(move |client| relay(client, upstream_socket, state, target))
}

fn forward_upgrade_rejection(rejection: http::Response<Option<Vec<u8>>>) -> Response {
    let status = rejection.status();
    let (parts, body) = rejection.into_parts();
    let mut response = Response::builder().status(status);
    if let Some(headers) = response.headers_mut() {
        for (name, value) in parts.headers.iter() {
            if RESPONSE_HEADER_DENYLIST.contains(&name.as_str()) {
                continue;
            }
            headers.append(name.clone(), value.clone());
        }
        headers.insert(
            PROXY_ERROR_HEADER,
            HeaderValue::from_static("upstream-upgrade"),
        );
        if !headers.contains_key(CONTENT_TYPE) {
            headers.insert(
                CONTENT_TYPE,
                HeaderValue::from_static("application/json; charset=utf-8"),
            );
        }
    }
    response
        .body(Body::from(body.unwrap_or_default()))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
}

/// Pump both directions until either side closes. Neither frame contents nor
/// close codes are inspected: a terminal is opaque bytes with backpressure,
/// which `SinkExt::send` gives us for free.
async fn relay(
    client: axum::extract::ws::WebSocket,
    upstream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    state: Arc<ProxyState>,
    target: Target,
) {
    let (mut client_tx, mut client_rx) = client.split();
    let (mut upstream_tx, mut upstream_rx) = upstream.split();

    let input_state = state.clone();
    let input_target = target.clone();
    let to_upstream = async {
        while let Some(Ok(message)) = client_rx.next().await {
            let Some(message) = client_message_to_upstream(message) else {
                continue;
            };
            if !input_state.registry.route_is_current(&input_target) {
                break;
            }
            if upstream_tx.send(message).await.is_err() {
                break;
            }
        }
        let _ = upstream_tx.close().await;
    };
    let to_client = async {
        while let Some(Ok(message)) = upstream_rx.next().await {
            let Some(message) = upstream_message_to_client(message) else {
                continue;
            };
            if client_tx.send(message).await.is_err() {
                break;
            }
        }
        let _ = client_tx.close().await;
    };
    let revoked = async {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            if !state.registry.route_is_current(&target) {
                break;
            }
        }
    };

    tokio::select! {
        _ = to_upstream => {}
        _ = to_client => {}
        _ = revoked => {}
    }
}

fn client_message_to_upstream(message: axum::extract::ws::Message) -> Option<tungstenite::Message> {
    use axum::extract::ws::Message as Down;
    use tungstenite::Message as Up;
    Some(match message {
        Down::Text(text) => Up::Text(text.as_str().into()),
        Down::Binary(bytes) => Up::Binary(bytes),
        Down::Ping(bytes) => Up::Ping(bytes),
        Down::Pong(bytes) => Up::Pong(bytes),
        Down::Close(frame) => Up::Close(frame.map(|frame| tungstenite::protocol::CloseFrame {
            code: frame.code.into(),
            reason: frame.reason.as_str().into(),
        })),
    })
}

fn upstream_message_to_client(message: tungstenite::Message) -> Option<axum::extract::ws::Message> {
    use axum::extract::ws::Message as Down;
    use tungstenite::Message as Up;
    Some(match message {
        Up::Text(text) => Down::Text(text.as_str().into()),
        Up::Binary(bytes) => Down::Binary(bytes),
        Up::Ping(bytes) => Down::Ping(bytes),
        Up::Pong(bytes) => Down::Pong(bytes),
        Up::Close(frame) => Down::Close(frame.map(|frame| axum::extract::ws::CloseFrame {
            code: frame.code.into(),
            reason: frame.reason.as_str().into(),
        })),
        // Raw frames never appear on a read stream.
        Up::Frame(_) => return None,
    })
}
