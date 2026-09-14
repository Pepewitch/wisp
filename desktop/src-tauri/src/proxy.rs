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

mod header_policy;
mod http_forward;
mod route;
mod websocket_forward;

pub use header_policy::packaged_app_origins;

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::response::Response;
use axum::Router;
use http::header::AUTHORIZATION;
use http::StatusCode;
use tokio::net::TcpListener;

use crate::capability::Capability;
use crate::registry::{ConnectionKind, Identity, Registry, RegistryError, Target};
use crate::urls::join_upstream;

use header_policy::{bearer, preflight, refuse, with_cors};
use http_forward::{is_streaming_upload, proxy_http, send_upstream};
use route::ProxyRoute;
use websocket_forward::{is_websocket_upgrade, proxy_websocket};

/// TLS handshake and TCP connect budget. Deliberately *not* a whole-request
/// timeout: `/api/events` and the task log stream are long-lived by design.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Budget for receiving ordinary HTTP response headers or completing an
/// upstream WebSocket handshake. This wraps only the future that establishes
/// the response/socket: once headers arrive, response bodies and WebSocket
/// frames may stream for as long as their callers keep them open.
const UPSTREAM_HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
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

    let streaming_upload = is_streaming_upload(route.rest, &parts.method);
    proxy_http(
        &state,
        &target,
        credential,
        upstream,
        parts,
        body,
        streaming_upload,
    )
    .await
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

#[cfg(test)]
mod tests;
