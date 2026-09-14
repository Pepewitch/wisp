//! HTTP request replay, upload streaming, and response relay.

use axum::body::Body;
use axum::response::Response;
use http::header::{CONTENT_LENGTH, TRANSFER_ENCODING};
use http::{HeaderMap, HeaderValue, StatusCode};
use url::Url;

use crate::registry::{ConnectionKind, RegistryError, Target};

use super::header_policy::{
    refuse, upstream_request, PROXY_REDIRECT_HEADER, RESPONSE_HEADER_DENYLIST,
};
use super::{stale_route, ProxyState};

/// A raw 50 MiB upload may cross a slow tunnel. Keep it bounded without
/// treating request-body transmission as an ordinary response-header wait.
const ATTACHMENT_UPLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);
/// Ordinary JSON writes remain safely replayable after Local token rotation.
/// Raw attachment uploads take a separate streaming path below and never enter
/// this buffer.
const MAX_REPLAYABLE_REQUEST_BODY: usize = 80 * 1024 * 1024;

pub(super) fn is_streaming_upload(path: &str, method: &http::Method) -> bool {
    *method == http::Method::POST && path == "api/attachments"
}

pub(super) async fn proxy_http(
    state: &ProxyState,
    target: &Target,
    credential: String,
    upstream: Url,
    parts: http::request::Parts,
    body: Body,
    streaming_upload: bool,
) -> Response {
    if !state.registry.route_is_current(target) {
        return stale_route();
    }
    if streaming_upload {
        // A browser File is already a replayable source at the caller. Relay
        // it chunk by chunk instead of creating an 80 MiB native copy too.
        // Identity was freshly checked immediately before this call; if the
        // credential rotates in this narrow window, the UI can retry by
        // uploading the same File again with a new one-shot reference.
        let stream = body.into_data_stream();
        let builder = upstream_request(state, &parts, upstream, &credential)
            .body(reqwest::Body::wrap_stream(stream));
        return match send_upstream_with_timeout(
            builder,
            ATTACHMENT_UPLOAD_TIMEOUT,
            "the attachment upload did not complete in time",
        )
        .await
        {
            Ok(response) => relay_http_response(response),
            Err(response) => response,
        };
    }
    let request_has_body = has_request_body(&parts.headers);
    let buffered_body = if request_has_body {
        match axum::body::to_bytes(body, MAX_REPLAYABLE_REQUEST_BODY).await {
            Ok(bytes) => Some(bytes),
            Err(_) => {
                return refuse(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "request-too-large",
                    "the desktop proxy accepts request bodies up to 80 MiB",
                )
            }
        }
    } else {
        None
    };
    // Body buffering is an await point controlled by the webview. A Local
    // retarget or remote removal that happened while bytes were arriving must
    // revoke this request before the first upstream byte can be sent.
    if !state.registry.route_is_current(target) {
        return stale_route();
    }
    let mut builder = upstream_request(state, &parts, upstream.clone(), &credential);
    if let Some(bytes) = &buffered_body {
        builder = builder.body(bytes.clone());
    }

    let mut upstream_response = match send_upstream(state, builder).await {
        Ok(response) => response,
        Err(response) => return response,
    };

    if matches!(
        upstream_response.status(),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    ) && target.kind == ConnectionKind::Local
    {
        match state.registry.reload_local_credential(target) {
            Ok(refreshed) if refreshed != credential => {
                if !state.registry.route_is_current(target) {
                    return stale_route();
                }
                let mut retry = upstream_request(state, &parts, upstream, &refreshed);
                if let Some(bytes) = &buffered_body {
                    retry = retry.body(bytes.clone());
                }
                upstream_response = match send_upstream(state, retry).await {
                    Ok(response) => response,
                    Err(response) => return response,
                };
            }
            Ok(_) => {}
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

    relay_http_response(upstream_response)
}

pub(super) async fn send_upstream(
    state: &ProxyState,
    builder: reqwest::RequestBuilder,
) -> Result<reqwest::Response, Response> {
    send_upstream_with_timeout(
        builder,
        state.upstream_handshake_timeout,
        "the daemon did not send response headers in time",
    )
    .await
}

async fn send_upstream_with_timeout(
    builder: reqwest::RequestBuilder,
    timeout: std::time::Duration,
    timeout_message: &'static str,
) -> Result<reqwest::Response, Response> {
    match tokio::time::timeout(timeout, builder.send()).await {
        Ok(Ok(response)) => Ok(response),
        Ok(Err(error)) => Err(refuse(
            StatusCode::BAD_GATEWAY,
            "upstream",
            describe_upstream_failure(&error),
        )),
        Err(_) => Err(refuse(
            StatusCode::GATEWAY_TIMEOUT,
            "upstream-timeout",
            timeout_message,
        )),
    }
}

fn relay_http_response(upstream_response: reqwest::Response) -> Response {
    let status = upstream_response.status();
    let mut response = Response::builder().status(status);
    if let Some(headers) = response.headers_mut() {
        for (name, value) in upstream_response.headers() {
            if RESPONSE_HEADER_DENYLIST.contains(&name.as_str()) {
                continue;
            }
            headers.append(name.clone(), value.clone());
        }
        if status.is_redirection() {
            headers.insert(PROXY_REDIRECT_HEADER, HeaderValue::from_static("blocked"));
        }
    }
    // from_stream, not bytes(): `/api/events` and the task log stream must
    // reach the webview as they are produced, never at completion.
    response
        .body(Body::from_stream(upstream_response.bytes_stream()))
        .unwrap_or_else(|_| {
            refuse(
                StatusCode::BAD_GATEWAY,
                "upstream",
                "the daemon's response could not be relayed",
            )
        })
}

/// TLS failures are connection-scoped facts the user has to see, not something
/// to retry without verification.
fn describe_upstream_failure(error: &reqwest::Error) -> String {
    if error.is_connect() {
        format!("could not reach the daemon: {error}")
    } else if error.is_timeout() {
        "the daemon did not answer in time".to_string()
    } else {
        format!("the daemon request failed: {error}")
    }
}

pub(super) fn has_request_body(headers: &HeaderMap) -> bool {
    if headers.contains_key(TRANSFER_ENCODING) {
        return true;
    }
    headers
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > 0)
}
