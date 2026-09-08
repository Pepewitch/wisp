//! The native loopback proxy: the only path from the webview to any daemon.
//!
//! Route shape, and why it looks like this:
//!
//! ```text
//! http://127.0.0.1:<ephemeral>/<capability>/connections/<id>/<revision>/api/...
//! ```
//!
//! * The **capability** is in the path because `EventSource`, `WebSocket`, and
//!   `<img src>` cannot set a header, and every one of those is load-bearing in
//!   this UI. It authorizes talking to the proxy; it is never a daemon
//!   credential, and it dies with the process.
//! * The **connection ID and route revision** are the whole addressing scheme.
//!   A request names a saved connection generation, never a URL. There is no
//!   code path from a frontend string to an upstream host, and an old Local
//!   transport cannot follow the stable `local` ID onto a replacement daemon.
//! * Everything after `/api` is forwarded verbatim, still percent-encoded, so
//!   attachment filenames and query strings survive the hop unaltered.
//!
//! Credentials are attached here and only here: client `Authorization` and
//! `Cookie` are dropped before the upstream request is built, the native token
//! is *set* (never appended) afterwards, redirects are never followed, and
//! upstream `Set-Cookie` never reaches the webview.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{FromRequestParts, Request, State};
use axum::response::{IntoResponse, Response};
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use http::header::{
    ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
    ACCESS_CONTROL_EXPOSE_HEADERS, ACCESS_CONTROL_REQUEST_HEADERS, ACCESS_CONTROL_REQUEST_METHOD,
    AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE, ORIGIN, SEC_WEBSOCKET_PROTOCOL, TRANSFER_ENCODING,
    UPGRADE, VARY,
};
use http::{HeaderMap, HeaderValue, StatusCode};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite;
use url::Url;

use crate::capability::Capability;
use crate::registry::{ConnectionKind, Identity, Registry, RegistryError, Target};
use crate::urls::{join_upstream, to_websocket_url};

/// Origins the packaged macOS webview actually uses. An `Origin` header is
/// forgeable by any local process, so this only ever *supplements* the
/// capability check — it is never the thing standing between a caller and a
/// daemon.
pub fn packaged_app_origins() -> Vec<String> {
    vec![
        "tauri://localhost".to_string(),
        "http://tauri.localhost".to_string(),
        "https://tauri.localhost".to_string(),
    ]
}

/// Client headers that must never reach a daemon.
///
/// `authorization` and `cookie` are the security-relevant two: the frontend
/// does not get to choose, or contribute to, what authenticates upstream. The
/// rest are hop-by-hop or connection-scoped and would be wrong to copy.
const REQUEST_HEADER_DENYLIST: &[&str] = &[
    "authorization",
    "cookie",
    "host",
    "origin",
    "referer",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
];

/// Upstream headers that must never reach the webview.
///
/// `set-cookie`: the desktop does not use the daemon's browser-session
/// exchange, and a daemon cookie in the shared webview would be ambient
/// authority for every connection at once.
/// `location`: a redirect must not be able to select a new target.
const RESPONSE_HEADER_DENYLIST: &[&str] = &[
    "set-cookie",
    "location",
    "x-wisp-proxy-error",
    "x-wisp-proxy-redirect",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// Marks a response this proxy generated rather than relayed, so a frontend
/// bug report can tell a daemon refusal from a transport refusal.
const PROXY_ERROR_HEADER: &str = "x-wisp-proxy-error";
/// Set when a 3xx was relayed with its `Location` removed.
const PROXY_REDIRECT_HEADER: &str = "x-wisp-proxy-redirect";

/// TLS handshake and TCP connect budget. Deliberately *not* a whole-request
/// timeout: `/api/events` and the task log stream are long-lived by design.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Budget for receiving ordinary HTTP response headers or completing an
/// upstream WebSocket handshake. This wraps only the future that establishes
/// the response/socket: once headers arrive, response bodies and WebSocket
/// frames may stream for as long as their callers keep them open.
const UPSTREAM_HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// Ten 5 MiB attachments expand under base64 plus JSON framing. Keeping one
/// bounded copy makes a Local request safely replayable after token rotation.
const MAX_REPLAYABLE_REQUEST_BODY: usize = 80 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum ProxyStartError {
    #[error("could not build the upstream HTTP client: {0}")]
    Client(#[from] reqwest::Error),
    #[error("could not bind the loopback proxy: {0}")]
    Bind(#[from] std::io::Error),
}

pub struct ProxyState {
    capability: Capability,
    registry: Arc<Registry>,
    client: reqwest::Client,
    allowed_origins: Vec<String>,
    upstream_handshake_timeout: std::time::Duration,
}

impl ProxyState {
    pub fn new(
        capability: Capability,
        registry: Arc<Registry>,
        allowed_origins: Vec<String>,
    ) -> Result<Self, ProxyStartError> {
        let client = reqwest::Client::builder()
            // No redirect is ever followed, so no redirect can receive the
            // Authorization header or choose a new upstream.
            .redirect(reqwest::redirect::Policy::none())
            .referer(false)
            .connect_timeout(CONNECT_TIMEOUT)
            .user_agent(concat!("wisp-desktop/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self {
            capability,
            registry,
            client,
            allowed_origins,
            upstream_handshake_timeout: UPSTREAM_HANDSHAKE_TIMEOUT,
        })
    }

    /// Override the response-header/WebSocket-handshake budget.
    ///
    /// Production callers use the default. Keeping the budget in proxy state
    /// lets integration tests cover a stalled peer without sleeping for the
    /// full production interval.
    #[doc(hidden)]
    pub fn with_upstream_handshake_timeout(mut self, timeout: std::time::Duration) -> Self {
        assert!(!timeout.is_zero(), "the upstream timeout must be positive");
        self.upstream_handshake_timeout = timeout;
        self
    }

    pub fn registry(&self) -> &Arc<Registry> {
        &self.registry
    }

    /// The one upstream HTTP client: no redirects, no cookie jar, system trust
    /// roots. Handshakes and health probes share it so they cannot accidentally
    /// be built with weaker settings than the proxy itself.
    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }

    fn cors_origin(&self, headers: &HeaderMap) -> Result<Option<HeaderValue>, ()> {
        match headers.get(ORIGIN) {
            // Absent is normal: `<img>` and same-document subresource loads
            // send no Origin at all.
            None => Ok(None),
            Some(value)
                if value.to_str().is_ok_and(|origin| {
                    self.allowed_origins.iter().any(|allowed| allowed == origin)
                }) =>
            {
                Ok(Some(value.clone()))
            }
            Some(_) => Err(()),
        }
    }
}

/// A running proxy. Dropping it shuts the listener down.
pub struct ProxyHandle {
    port: u16,
    base: String,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

impl ProxyHandle {
    /// The unguessable per-launch base handed to the webview. Everything the
    /// frontend builds is this string plus
    /// `/connections/<id>/<revision>/api/...`.
    pub fn base(&self) -> &str {
        &self.base
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

impl Drop for ProxyHandle {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

/// Bind the proxy to the literal IPv4 loopback address on an ephemeral port.
pub async fn start(state: Arc<ProxyState>) -> Result<ProxyHandle, ProxyStartError> {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await?;
    let port = listener.local_addr()?.port();
    let base = format!("http://127.0.0.1:{port}/{}", state.capability.expose());
    // One fallback rather than declared routes: the path is parsed by hand so
    // the suffix keeps its original percent-encoding.
    let app = Router::new().fallback(handle).with_state(state);
    let (shutdown, wait) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = wait.await;
            })
            .await;
    });
    Ok(ProxyHandle {
        port,
        base,
        shutdown: Some(shutdown),
    })
}

struct ProxyRoute<'a> {
    capability: &'a str,
    connection_id: &'a str,
    route_revision: u32,
    /// `api/...`, exactly as it appeared on the request line.
    rest: &'a str,
}

impl<'a> ProxyRoute<'a> {
    fn parse(path: &'a str) -> Option<Self> {
        let rest = path.strip_prefix('/')?;
        let (capability, rest) = rest.split_once('/')?;
        let rest = rest.strip_prefix("connections/")?;
        let (connection_id, rest) = rest.split_once('/')?;
        if !crate::registry::is_valid_connection_id(connection_id) {
            return None;
        }
        let (raw_revision, rest) = rest.split_once('/')?;
        let route_revision = raw_revision.parse::<u32>().ok()?;
        if route_revision.to_string() != raw_revision {
            return None;
        }
        // Only the daemon API is reachable. There is no proxy route to a
        // daemon's web bundle, and no route that is not a daemon route.
        if rest != "api" && !rest.starts_with("api/") {
            return None;
        }
        Some(Self {
            capability,
            connection_id,
            route_revision,
            rest,
        })
    }
}

fn refuse(status: StatusCode, code: &'static str, message: impl Into<String>) -> Response {
    let body = serde_json::json!({ "error": message.into() });
    let mut response = (status, axum::Json(body)).into_response();
    response
        .headers_mut()
        .insert(PROXY_ERROR_HEADER, HeaderValue::from_static(code));
    response
}

async fn handle(State(state): State<Arc<ProxyState>>, request: Request) -> Response {
    let origin = match state.cors_origin(request.headers()) {
        Ok(origin) => origin,
        Err(()) => {
            return refuse(
                StatusCode::FORBIDDEN,
                "origin",
                "this proxy only serves the packaged Wisp application",
            )
        }
    };
    let response = handle_trusted(state, request).await;
    with_cors(response, origin.as_ref())
}

fn with_cors(mut response: Response, origin: Option<&HeaderValue>) -> Response {
    if let Some(origin) = origin {
        response
            .headers_mut()
            .insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin.clone());
        response
            .headers_mut()
            .append(VARY, HeaderValue::from_static("Origin"));
        response.headers_mut().insert(
            ACCESS_CONTROL_EXPOSE_HEADERS,
            HeaderValue::from_static("x-wisp-proxy-error, x-wisp-proxy-redirect"),
        );
    }
    response
}

fn preflight(headers: &HeaderMap, method: &http::Method) -> Option<Response> {
    if method != http::Method::OPTIONS || !headers.contains_key(ACCESS_CONTROL_REQUEST_METHOD) {
        return None;
    }
    let requested_method = match headers
        .get(ACCESS_CONTROL_REQUEST_METHOD)
        .and_then(|value| value.to_str().ok())
    {
        Some(method) => method,
        None => {
            return Some(refuse(
                StatusCode::FORBIDDEN,
                "cors-method",
                "the requested method is not valid",
            ))
        }
    };
    if !matches!(
        requested_method,
        "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
    ) {
        return Some(refuse(
            StatusCode::FORBIDDEN,
            "cors-method",
            "that method is not allowed by the desktop proxy",
        ));
    }
    if let Some(requested) = headers.get(ACCESS_CONTROL_REQUEST_HEADERS) {
        let valid = requested.to_str().is_ok_and(|headers| {
            headers
                .split(',')
                .all(|header| header.trim().eq_ignore_ascii_case("content-type"))
        });
        if !valid {
            return Some(refuse(
                StatusCode::FORBIDDEN,
                "cors-headers",
                "only Content-Type may be requested from the webview",
            ));
        }
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"),
    );
    response.headers_mut().insert(
        ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Content-Type"),
    );
    if headers
        .get("access-control-request-private-network")
        .is_some_and(|value| value == "true")
    {
        response.headers_mut().insert(
            "access-control-allow-private-network",
            HeaderValue::from_static("true"),
        );
    }
    Some(response)
}

async fn handle_trusted(state: Arc<ProxyState>, request: Request) -> Response {
    let (mut parts, body) = request.into_parts();

    let path = parts.uri.path().to_string();
    let Some(route) = ProxyRoute::parse(&path) else {
        return refuse(StatusCode::NOT_FOUND, "route", "not a Wisp desktop route");
    };
    // Constant-time, and the same refusal an unknown path gets: a caller
    // without the capability learns nothing about which part was wrong.
    if !state.capability.matches(route.capability) {
        return refuse(StatusCode::NOT_FOUND, "route", "not a Wisp desktop route");
    }

    // The only source of an upstream target. A removed or tombstoned
    // connection resolves to nothing, which is what makes removal a revocation.
    let target = match state
        .registry
        .resolve_route(route.connection_id, route.route_revision)
    {
        Ok(target) => target,
        Err(RegistryError::StaleRoute) => return stale_route(),
        Err(RegistryError::UnknownConnection(_)) => {
            return refuse(
                StatusCode::NOT_FOUND,
                "unknown-connection",
                "that connection is not available",
            )
        }
        Err(error) => {
            return refuse(
                StatusCode::SERVICE_UNAVAILABLE,
                "connection-unavailable",
                error.to_string(),
            )
        }
    };

    // Webview JSON writes cross from the Tauri document origin to loopback.
    // Answer their browser preflight locally: it carries no daemon credential
    // and must never consume an upstream route or stream slot.
    if let Some(response) = preflight(&parts.headers, &parts.method) {
        return response;
    }

    // The application-global Updates surface owns the built-in Local daemon.
    // Keep that policy at the trusted hop too: a stale or compromised webview
    // must not turn the same bundled UI into a remote package-manager control.
    if target.kind == ConnectionKind::Remote
        && route.rest == "api/update"
        && parts.method == http::Method::POST
    {
        return refuse(
            StatusCode::FORBIDDEN,
            "remote-daemon-update",
            "Wisp Desktop updates only the Local daemon; update this remote daemon on its host",
        );
    }

    let mut credential = match state.registry.credential(&target) {
        Ok(credential) => credential,
        Err(RegistryError::StaleRoute) => return stale_route(),
        Err(RegistryError::MissingCredential) => {
            return refuse(
                StatusCode::SERVICE_UNAVAILABLE,
                "no-credential",
                "no stored credential for this connection — reconnect to enter its token",
            )
        }
        Err(error) => {
            return refuse(
                StatusCode::SERVICE_UNAVAILABLE,
                "credential-unavailable",
                error.to_string(),
            )
        }
    };

    let upstream = match join_upstream(&target.base, route.rest, parts.uri.query()) {
        Ok(url) => url,
        Err(error) => return refuse(StatusCode::BAD_REQUEST, "path", error.to_string()),
    };

    let websocket = is_websocket_upgrade(&parts.headers);
    // A terminal upgrade is command execution even though its handshake is a
    // GET. It must prove the pinned daemon identity just like an HTTP write.
    // The first read after launch proves identity too, and a known mismatch
    // blocks every later route so read-only data cannot cross daemon scope.
    let identity = match state.registry.identity(&target) {
        Ok(identity) => identity,
        Err(RegistryError::StaleRoute) => return stale_route(),
        Err(error) => {
            return refuse(
                StatusCode::SERVICE_UNAVAILABLE,
                "connection-unavailable",
                error.to_string(),
            )
        }
    };
    if identity == Identity::Mismatch {
        return identity_mismatch();
    }
    if websocket || is_write(&parts.method) || identity == Identity::Unchecked {
        match ensure_pinned_identity(&state, &target, &credential).await {
            Ok(checked_credential) => credential = checked_credential,
            Err(response) => return *response,
        }
    }

    if route.rest == "api/update" && parts.method == http::Method::POST {
        match ensure_compatible_daemon_update(&state, &target, &credential).await {
            Ok(checked_credential) => credential = checked_credential,
            Err(response) => return *response,
        }
    }

    if websocket {
        return proxy_websocket(state, target, credential, upstream, &mut parts).await;
    }

    proxy_http(&state, &target, credential, upstream, parts, body).await
}

/// Anything that is not a read. The daemon's own refusals still apply; this is
/// only about which requests must first prove they are talking to the daemon
/// the connection was saved against.
fn is_write(method: &http::Method) -> bool {
    !matches!(
        *method,
        http::Method::GET | http::Method::HEAD | http::Method::OPTIONS
    )
}

/// Confirm immediately before a consequential operation that the daemon behind
/// a saved URL is still the daemon that URL was saved against.
///
/// A hostname can be repointed and a tunnel can be re-terminated; without this,
/// the first thing a user would notice is a mutation landing on the wrong
/// machine. Every write and terminal handshake pays for a fresh authenticated
/// probe. A launch-wide success cache would reopen that race after the first
/// mutation, and serializing probes would still leave later operations stale.
async fn ensure_pinned_identity(
    state: &ProxyState,
    target: &Target,
    credential: &str,
) -> Result<String, Box<Response>> {
    let url = join_upstream(&target.base, "api/capabilities", None)
        .map_err(|error| Box::new(refuse(StatusCode::BAD_REQUEST, "path", error.to_string())))?;
    let mut checked_credential = credential.to_string();
    let mut response = send_upstream(
        state,
        state
            .client
            .get(url)
            .header(AUTHORIZATION, bearer(&checked_credential)),
    )
    .await
    .map_err(Box::new)?;
    if matches!(
        response.status(),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    ) && target.kind == ConnectionKind::Local
    {
        checked_credential = state
            .registry
            .reload_local_credential(target)
            .map_err(|error| {
                Box::new(refuse(
                    StatusCode::CONFLICT,
                    "local-profile-changed",
                    error.to_string(),
                ))
            })?;
        let retry_url = join_upstream(&target.base, "api/capabilities", None).map_err(|error| {
            Box::new(refuse(StatusCode::BAD_REQUEST, "path", error.to_string()))
        })?;
        response = send_upstream(
            state,
            state
                .client
                .get(retry_url)
                .header(AUTHORIZATION, bearer(&checked_credential)),
        )
        .await
        .map_err(Box::new)?;
    }
    if !response.status().is_success() {
        if matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) {
            return Err(Box::new(refuse(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "the daemon rejected its stored credential — reconnect this connection",
            )));
        }
        return Err(Box::new(refuse(
            StatusCode::BAD_GATEWAY,
            "identity-unreachable",
            format!(
                "the daemon refused the identity check with status {}",
                response.status().as_u16()
            ),
        )));
    }
    let body: serde_json::Value = response.json().await.map_err(|error| {
        Box::new(refuse(
            StatusCode::BAD_GATEWAY,
            "identity-unreadable",
            format!("could not read the daemon's identity: {error}"),
        ))
    })?;
    let seen_protocol = body
        .get("apiProtocolVersion")
        .and_then(serde_json::Value::as_u64);
    if !seen_protocol.is_some_and(|version| {
        u32::try_from(version).is_ok_and(crate::probe::supports_api_protocol)
    }) {
        return Err(Box::new(refuse(
            StatusCode::CONFLICT,
            "incompatible-protocol",
            format!(
                "this Wisp Desktop supports daemon API protocol(s) {}, but the daemon reported {}; update Desktop for a newer daemon, or update the daemon out of band for an older one",
                crate::probe::SUPPORTED_API_PROTOCOL_VERSIONS
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(", "),
                seen_protocol.map_or_else(|| "unknown".to_string(), |value| value.to_string())
            ),
        )));
    }
    let seen = body
        .get("instanceId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let observed = if seen == target.instance_id {
        Identity::Verified
    } else {
        Identity::Mismatch
    };
    match state.registry.record_probe_identity(target, observed) {
        Ok(Identity::Verified) => Ok(checked_credential),
        Ok(Identity::Mismatch | Identity::Unchecked) => Err(Box::new(identity_mismatch())),
        Err(RegistryError::StaleRoute) => Err(Box::new(stale_route())),
        Err(error) => Err(Box::new(refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "connection-unavailable",
            error.to_string(),
        ))),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCompatibility {
    current_api_protocol_version: u32,
    latest_api_protocol_version: Option<u32>,
}

/// The web bundle can reload with a daemon update; the native proxy cannot.
/// Enforce the compiled protocol at the trusted hop as well as in the button.
async fn ensure_compatible_daemon_update(
    state: &ProxyState,
    target: &Target,
    credential: &str,
) -> Result<String, Box<Response>> {
    let url = join_upstream(&target.base, "api/update", None)
        .map_err(|error| Box::new(refuse(StatusCode::BAD_REQUEST, "path", error.to_string())))?;
    let mut checked_credential = credential.to_string();
    let mut response = state
        .client
        .get(url)
        .header(AUTHORIZATION, bearer(&checked_credential))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|error| {
            Box::new(refuse(
                StatusCode::BAD_GATEWAY,
                "update-check-unreachable",
                format!("could not verify update compatibility: {error}"),
            ))
        })?;
    if matches!(
        response.status(),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    ) && target.kind == ConnectionKind::Local
    {
        checked_credential = state
            .registry
            .reload_local_credential(target)
            .map_err(|error| {
                Box::new(refuse(
                    StatusCode::CONFLICT,
                    "local-profile-changed",
                    error.to_string(),
                ))
            })?;
        let retry_url = join_upstream(&target.base, "api/update", None).map_err(|error| {
            Box::new(refuse(StatusCode::BAD_REQUEST, "path", error.to_string()))
        })?;
        response = state
            .client
            .get(retry_url)
            .header(AUTHORIZATION, bearer(&checked_credential))
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
            .map_err(|error| {
                Box::new(refuse(
                    StatusCode::BAD_GATEWAY,
                    "update-check-unreachable",
                    format!("could not verify update compatibility: {error}"),
                ))
            })?;
    }
    if !response.status().is_success() {
        if matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) {
            return Err(Box::new(refuse(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "the daemon rejected its stored credential — reconnect this connection",
            )));
        }
        return Err(Box::new(refuse(
            StatusCode::BAD_GATEWAY,
            "update-check-refused",
            format!(
                "the daemon refused the update compatibility check with status {}",
                response.status().as_u16()
            ),
        )));
    }
    let compatibility: UpdateCompatibility = response.json().await.map_err(|error| {
        Box::new(refuse(
            StatusCode::BAD_GATEWAY,
            "update-check-unreadable",
            format!("could not read update compatibility: {error}"),
        ))
    })?;
    if !crate::probe::supports_api_protocol(compatibility.current_api_protocol_version)
        || !compatibility
            .latest_api_protocol_version
            .is_some_and(crate::probe::supports_api_protocol)
    {
        return Err(Box::new(refuse(
            StatusCode::CONFLICT,
            "incompatible-update",
            format!(
                "this Desktop supports daemon API protocol(s) {}; the requested update targets protocol {}",
                crate::probe::SUPPORTED_API_PROTOCOL_VERSIONS
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(", "),
                compatibility
                    .latest_api_protocol_version
                    .map_or_else(|| "unknown".to_string(), |value| value.to_string())
            ),
        )));
    }
    Ok(checked_credential)
}

fn identity_mismatch() -> Response {
    refuse(
        StatusCode::CONFLICT,
        "identity-changed",
        "a different Wisp daemon now answers at this address — reconnect this connection before making changes",
    )
}

fn stale_route() -> Response {
    refuse(
        StatusCode::CONFLICT,
        "stale-route",
        "this connection changed; retry from its current tab",
    )
}

fn bearer(credential: &str) -> HeaderValue {
    let mut value = HeaderValue::from_str(&format!("Bearer {credential}"))
        .unwrap_or_else(|_| HeaderValue::from_static("Bearer"));
    // Belt and braces: a credential is never a thing to print in a debug dump.
    value.set_sensitive(true);
    value
}

async fn proxy_http(
    state: &ProxyState,
    target: &Target,
    credential: String,
    upstream: Url,
    parts: http::request::Parts,
    body: Body,
) -> Response {
    if !state.registry.route_is_current(target) {
        return stale_route();
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

fn upstream_request(
    state: &ProxyState,
    parts: &http::request::Parts,
    upstream: Url,
    credential: &str,
) -> reqwest::RequestBuilder {
    let mut builder = state.client.request(parts.method.clone(), upstream);
    for (name, value) in parts.headers.iter() {
        if REQUEST_HEADER_DENYLIST.contains(&name.as_str()) {
            continue;
        }
        builder = builder.header(name.clone(), value.clone());
    }
    // Set, never append: whatever the caller sent is already gone, and exactly
    // one Authorization header leaves this process.
    builder.header(AUTHORIZATION, bearer(credential))
}

async fn send_upstream(
    state: &ProxyState,
    builder: reqwest::RequestBuilder,
) -> Result<reqwest::Response, Response> {
    match tokio::time::timeout(state.upstream_handshake_timeout, builder.send()).await {
        Ok(Ok(response)) => Ok(response),
        Ok(Err(error)) => Err(refuse(
            StatusCode::BAD_GATEWAY,
            "upstream",
            describe_upstream_failure(&error),
        )),
        Err(_) => Err(refuse(
            StatusCode::GATEWAY_TIMEOUT,
            "upstream-timeout",
            "the daemon did not send response headers in time",
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

fn has_request_body(headers: &HeaderMap) -> bool {
    if headers.contains_key(TRANSFER_ENCODING) {
        return true;
    }
    headers
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > 0)
}

fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    headers
        .get(UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
}

async fn proxy_websocket(
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

#[cfg(test)]
mod tests {
    use super::{has_request_body, is_websocket_upgrade, is_write, ProxyRoute};
    use http::header::{CONTENT_LENGTH, TRANSFER_ENCODING, UPGRADE};
    use http::{HeaderMap, HeaderValue, Method};

    #[test]
    fn a_route_needs_a_capability_a_connection_and_an_api_path() {
        let route = ProxyRoute::parse("/CAP/connections/c-abc/7/api/tasks").expect("valid route");
        assert_eq!(route.capability, "CAP");
        assert_eq!(route.connection_id, "c-abc");
        assert_eq!(route.route_revision, 7);
        assert_eq!(route.rest, "api/tasks");

        assert!(ProxyRoute::parse("/CAP/connections/local/0/api").is_some());
        assert!(ProxyRoute::parse("/api/tasks").is_none());
        assert!(ProxyRoute::parse("/CAP/connections/c-abc").is_none());
        assert!(ProxyRoute::parse("/CAP/c-abc/api/tasks").is_none());
        assert!(ProxyRoute::parse("/CAP/connections/c-abc/nope/api/tasks").is_none());
        assert!(ProxyRoute::parse("/CAP/connections/c-abc/00/api/tasks").is_none());
        // Nothing but the daemon API is reachable through this proxy.
        assert!(ProxyRoute::parse("/CAP/connections/c-abc/0/index.html").is_none());
        assert!(ProxyRoute::parse("/CAP/connections/c-abc/0/apiary").is_none());
        // An ID that is not a clean path segment never becomes a lookup.
        assert!(ProxyRoute::parse("/CAP/connections/c%2Fabc/0/api/tasks").is_none());
        assert!(ProxyRoute::parse("/CAP/connections/../0/api/tasks").is_none());
    }

    #[test]
    fn the_suffix_keeps_its_original_encoding() {
        let route =
            ProxyRoute::parse("/CAP/connections/local/4/api/tasks/t-1/attachments/a%20b.png")
                .expect("valid route");
        assert_eq!(route.rest, "api/tasks/t-1/attachments/a%20b.png");
    }

    #[test]
    fn writes_are_everything_that_is_not_a_read() {
        assert!(!is_write(&Method::GET));
        assert!(!is_write(&Method::HEAD));
        assert!(!is_write(&Method::OPTIONS));
        assert!(is_write(&Method::POST));
        assert!(is_write(&Method::PATCH));
        assert!(is_write(&Method::PUT));
        assert!(is_write(&Method::DELETE));
    }

    #[test]
    fn a_body_is_forwarded_only_when_one_was_announced() {
        let mut headers = HeaderMap::new();
        assert!(!has_request_body(&headers));
        headers.insert(CONTENT_LENGTH, HeaderValue::from_static("0"));
        assert!(!has_request_body(&headers));
        headers.insert(CONTENT_LENGTH, HeaderValue::from_static("12"));
        assert!(has_request_body(&headers));
        let mut chunked = HeaderMap::new();
        chunked.insert(TRANSFER_ENCODING, HeaderValue::from_static("chunked"));
        assert!(has_request_body(&chunked));
    }

    #[test]
    fn websocket_upgrades_are_detected_case_insensitively() {
        let mut headers = HeaderMap::new();
        assert!(!is_websocket_upgrade(&headers));
        headers.insert(UPGRADE, HeaderValue::from_static("WebSocket"));
        assert!(is_websocket_upgrade(&headers));
        headers.insert(UPGRADE, HeaderValue::from_static("h2c"));
        assert!(!is_websocket_upgrade(&headers));
    }

    #[test]
    fn the_injected_credential_is_marked_sensitive_so_it_cannot_be_logged() {
        let value = super::bearer("synthetic-daemon-token");
        assert!(value.is_sensitive());
        let mut headers = HeaderMap::new();
        headers.insert(http::header::AUTHORIZATION, value);
        // `http` renders a sensitive value as `Sensitive`, so any Debug print of
        // a request's headers — a panic, a trace, a bug report — omits it.
        let rendered = format!("{headers:?}");
        assert!(!rendered.contains("synthetic-daemon-token"), "{rendered}");
    }

    #[test]
    fn the_denylists_cover_the_credential_carrying_headers() {
        assert!(super::REQUEST_HEADER_DENYLIST.contains(&"authorization"));
        assert!(super::REQUEST_HEADER_DENYLIST.contains(&"cookie"));
        assert!(super::RESPONSE_HEADER_DENYLIST.contains(&"set-cookie"));
        assert!(super::RESPONSE_HEADER_DENYLIST.contains(&"location"));
        assert!(super::RESPONSE_HEADER_DENYLIST.contains(&"x-wisp-proxy-error"));
        assert!(super::RESPONSE_HEADER_DENYLIST.contains(&"x-wisp-proxy-redirect"));
    }
}
