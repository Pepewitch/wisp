//! Two synthetic Wisp daemons and one proxy under test.
//!
//! The daemons are deliberately *not* real `wispd` processes: this suite is
//! about the native hop, so each mock answers the shape of the routes the hop
//! has to handle (authenticated JSON, SSE, attachment bytes, a WebSocket
//! terminal, a redirect, a `Set-Cookie`) and records exactly what arrived. Every
//! identifier in here is synthetic.

#![allow(dead_code)]

use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{Path, Request, State, WebSocketUpgrade};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::StreamExt;
use http::StatusCode;
use serde_json::json;
use tokio::net::TcpListener;
use url::Url;

use wisp_desktop::capability::Capability;
use wisp_desktop::local::LocalProfile;
use wisp_desktop::proxy::{self, ProxyHandle, ProxyState};
use wisp_desktop::registry::Registry;
use wisp_desktop::secrets::MemorySecretStore;
use wisp_desktop::urls::normalize_daemon_url;

fn synthetic_instance_id(value: &str) -> String {
    if wisp_desktop::probe::is_instance_id(value) {
        return value.to_string();
    }
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut hash = DefaultHasher::new();
    value.hash(&mut hash);
    format!(
        "00000000-0000-4000-8000-{:012x}",
        hash.finish() & 0xffffffffffff
    )
}

/// The one task ID both daemons are seeded with, so a routing mistake shows up
/// as the wrong *content* rather than a 404.
pub const SHARED_TASK_ID: &str = "t-000000000001";

/// Synthetic attachment bytes: a PNG magic number and a per-daemon marker.
pub fn attachment_bytes(label: &str) -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    bytes.extend_from_slice(label.as_bytes());
    bytes
}

#[derive(Debug, Clone)]
pub struct SeenRequest {
    pub method: String,
    pub path: String,
    pub query: Option<String>,
    pub authorization: Option<String>,
    pub cookie: Option<String>,
    pub headers: Vec<(String, String)>,
}

struct DaemonState {
    label: String,
    token: Mutex<String>,
    token_after_capabilities: Mutex<Option<String>>,
    instance_id: Mutex<String>,
    protocol_version: Mutex<u32>,
    update_protocol_version: Mutex<u32>,
    seen: Mutex<Vec<SeenRequest>>,
    /// Where `/api/redirect` points. A hit on that server is a test failure.
    redirect_to: Mutex<String>,
}

/// A synthetic daemon on loopback.
pub struct MockDaemon {
    pub label: String,
    pub token: String,
    pub port: u16,
    state: Arc<DaemonState>,
    _shutdown: tokio::sync::oneshot::Sender<()>,
}

impl MockDaemon {
    pub async fn start(label: &str, token: &str, instance_id: &str) -> Self {
        let state = Arc::new(DaemonState {
            label: label.to_string(),
            token: Mutex::new(token.to_string()),
            token_after_capabilities: Mutex::new(None),
            instance_id: Mutex::new(synthetic_instance_id(instance_id)),
            protocol_version: Mutex::new(1),
            update_protocol_version: Mutex::new(1),
            seen: Mutex::new(Vec::new()),
            redirect_to: Mutex::new("https://redirect-target.invalid/api/tasks".to_string()),
        });
        let app = Router::new()
            .route("/api/health", get(health))
            .route("/api/capabilities", get(capabilities))
            .route("/api/whoami", get(whoami))
            .route("/api/tasks/{id}", get(task))
            .route("/api/tasks/{id}/action", post(action))
            .route("/api/tasks/{id}/attachments/{name}", get(attachment))
            .route("/api/tasks/{id}/terminal", get(terminal))
            .route("/api/events", get(events))
            .route("/api/redirect", get(redirect))
            .route("/api/cookie", get(cookie))
            .route("/api/update", get(update_status).post(start_update))
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                record_and_authenticate,
            ))
            .with_state(state.clone());

        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .await
            .expect("bind mock daemon");
        let port = listener.local_addr().expect("addr").port();
        let (shutdown, wait) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = wait.await;
                })
                .await;
        });
        Self {
            label: label.to_string(),
            token: token.to_string(),
            port,
            state,
            _shutdown: shutdown,
        }
    }

    pub fn url(&self) -> Url {
        normalize_daemon_url(&format!("http://127.0.0.1:{}", self.port)).expect("loopback URL")
    }

    pub fn seen(&self) -> Vec<SeenRequest> {
        self.state.seen.lock().expect("seen").clone()
    }

    pub fn seen_paths(&self) -> Vec<String> {
        self.seen().into_iter().map(|r| r.path).collect()
    }

    pub fn instance_id(&self) -> String {
        self.state.instance_id.lock().expect("instance").clone()
    }

    /// Stand a different daemon up behind the same address.
    pub fn become_a_different_daemon(&self, instance_id: &str) {
        *self.state.instance_id.lock().expect("instance") = synthetic_instance_id(instance_id);
    }

    pub fn use_raw_instance_id(&self, instance_id: &str) {
        *self.state.instance_id.lock().expect("instance") = instance_id.to_string();
    }

    pub fn use_protocol(&self, version: u32) {
        *self.state.protocol_version.lock().expect("protocol") = version;
    }

    pub fn use_update_protocol(&self, version: u32) {
        *self
            .state
            .update_protocol_version
            .lock()
            .expect("update protocol") = version;
    }

    pub fn rotate_token(&self, token: &str) {
        *self.state.token.lock().expect("token") = token.to_string();
    }

    pub fn rotate_token_after_next_capabilities(&self, token: &str) {
        *self
            .state
            .token_after_capabilities
            .lock()
            .expect("deferred token") = Some(token.to_string());
    }

    pub fn point_redirect_at(&self, url: &str) {
        *self.state.redirect_to.lock().expect("redirect") = url.to_string();
    }
}

async fn record_and_authenticate(
    State(state): State<Arc<DaemonState>>,
    request: Request,
    next: Next,
) -> Response {
    let headers = request.headers();
    let seen = SeenRequest {
        method: request.method().to_string(),
        path: request.uri().path().to_string(),
        query: request.uri().query().map(str::to_string),
        authorization: header_value(headers, "authorization"),
        cookie: header_value(headers, "cookie"),
        headers: headers
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_string(),
                    value.to_str().unwrap_or_default().to_string(),
                )
            })
            .collect(),
    };
    let path = seen.path.clone();
    let authorization = seen.authorization.clone();
    state.seen.lock().expect("seen").push(seen);

    if path == "/api/health" {
        return next.run(request).await;
    }
    let expected = format!("Bearer {}", state.token.lock().expect("token"));
    if authorization.as_deref() != Some(expected.as_str()) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "unauthorized" })),
        )
            .into_response();
    }
    next.run(request).await
}

fn header_value(headers: &http::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

async fn health() -> impl IntoResponse {
    Json(json!({ "ok": true }))
}

async fn capabilities(State(state): State<Arc<DaemonState>>) -> impl IntoResponse {
    let response = Json(json!({
        "apiProtocolVersion": *state.protocol_version.lock().expect("protocol"),
        "instanceId": *state.instance_id.lock().expect("instance"),
        "version": "0.0.0-synthetic",
        "commit": "0000000",
        "dirty": false,
        "capabilities": { "terminal": true, "attachments": true },
    }));
    if let Some(token) = state
        .token_after_capabilities
        .lock()
        .expect("deferred token")
        .take()
    {
        *state.token.lock().expect("token") = token;
    }
    response
}

async fn update_status(State(state): State<Arc<DaemonState>>) -> impl IntoResponse {
    Json(json!({
        "currentVersion": "0.0.0-synthetic",
        "latestVersion": "0.0.1-synthetic",
        "currentApiProtocolVersion": *state.protocol_version.lock().expect("protocol"),
        "latestApiProtocolVersion": *state.update_protocol_version.lock().expect("update protocol"),
        "state": "available",
        "installMethod": "homebrew",
        "canAutoUpdate": true,
        "message": null,
        "checkedAt": null,
    }))
}

async fn start_update() -> impl IntoResponse {
    Json(json!({ "ok": true }))
}

/// Echoes back exactly what arrived, so a test can assert on the *upstream*
/// side of the hop rather than trusting the proxy's own account of itself.
async fn whoami(State(state): State<Arc<DaemonState>>) -> impl IntoResponse {
    let last = state
        .seen
        .lock()
        .expect("seen")
        .last()
        .cloned()
        .expect("a request was just recorded");
    Json(json!({
        "daemon": state.label,
        "authorization": last.authorization,
        "cookie": last.cookie,
        "headers": last.headers,
    }))
}

async fn task(State(state): State<Arc<DaemonState>>, Path(id): Path<String>) -> impl IntoResponse {
    Json(json!({
        "id": id,
        "title": format!("task on {}", state.label),
        "daemon": state.label,
    }))
}

async fn action(
    State(state): State<Arc<DaemonState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    Json(json!({ "ok": true, "id": id, "daemon": state.label }))
}

async fn attachment(
    State(state): State<Arc<DaemonState>>,
    Path((_id, name)): Path<(String, String)>,
) -> impl IntoResponse {
    let mut response = (
        [
            (http::header::CONTENT_TYPE, "image/png"),
            (http::header::CACHE_CONTROL, "private, max-age=60"),
        ],
        Bytes::from(attachment_bytes(&state.label)),
    )
        .into_response();
    // The decoded name proves the suffix survived the hop unaltered.
    if let Ok(value) = http::HeaderValue::from_str(&name) {
        response
            .headers_mut()
            .insert(http::HeaderName::from_static("x-attachment-name"), value);
    }
    response
}

/// Three frames with a gap between them, so a buffering proxy is measurable.
async fn events(State(state): State<Arc<DaemonState>>) -> impl IntoResponse {
    let label = state.label.clone();
    let stream = futures_util::stream::unfold(0usize, move |index| {
        let label = label.clone();
        async move {
            if index >= 3 {
                return None;
            }
            if index > 0 {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            let frame = format!("event: tick\ndata: {{\"daemon\":\"{label}\",\"n\":{index}}}\n\n");
            Some((Ok::<Bytes, std::io::Error>(Bytes::from(frame)), index + 1))
        }
    });
    Response::builder()
        .status(StatusCode::OK)
        .header(http::header::CONTENT_TYPE, "text/event-stream")
        .header(http::header::CACHE_CONTROL, "no-store")
        .body(Body::from_stream(stream))
        .expect("sse response")
}

async fn redirect(State(state): State<Arc<DaemonState>>) -> impl IntoResponse {
    let target = state.redirect_to.lock().expect("redirect").clone();
    Response::builder()
        .status(StatusCode::FOUND)
        .header(http::header::LOCATION, target)
        .body(Body::from("moved"))
        .expect("redirect response")
}

async fn cookie() -> impl IntoResponse {
    Response::builder()
        .status(StatusCode::OK)
        .header(
            http::header::SET_COOKIE,
            "wisp_token=synthetic-cookie-value; Path=/; HttpOnly",
        )
        .header("x-wisp-proxy-error", "identity-changed")
        .header("x-wisp-proxy-redirect", "blocked")
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"ok":true}"#))
        .expect("cookie response")
}

/// Echo terminal: every text frame comes back prefixed with the daemon label.
async fn terminal(
    State(state): State<Arc<DaemonState>>,
    upgrade: WebSocketUpgrade,
) -> impl IntoResponse {
    let label = state.label.clone();
    upgrade.on_upgrade(move |mut socket| async move {
        let hello = format!("hello from {label}");
        if socket
            .send(axum::extract::ws::Message::Text(hello.into()))
            .await
            .is_err()
        {
            return;
        }
        while let Some(Ok(message)) = socket.next().await {
            match message {
                axum::extract::ws::Message::Text(text) => {
                    let echo = format!("{label}:{text}");
                    if socket
                        .send(axum::extract::ws::Message::Text(echo.into()))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                axum::extract::ws::Message::Binary(bytes) => {
                    if socket
                        .send(axum::extract::ws::Message::Binary(bytes))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                axum::extract::ws::Message::Close(_) => return,
                _ => {}
            }
        }
    })
}

/// A server that must never be contacted. Used as a redirect target.
pub struct Tripwire {
    pub port: u16,
    hits: Arc<Mutex<usize>>,
    _shutdown: tokio::sync::oneshot::Sender<()>,
}

impl Tripwire {
    pub async fn start() -> Self {
        let hits = Arc::new(Mutex::new(0usize));
        let counter = hits.clone();
        let app = Router::new().fallback(axum::routing::any(move || {
            let counter = counter.clone();
            async move {
                *counter.lock().expect("hits") += 1;
                Json(json!({ "reached": true }))
            }
        }));
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .await
            .expect("bind tripwire");
        let port = listener.local_addr().expect("addr").port();
        let (shutdown, wait) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = wait.await;
                })
                .await;
        });
        Self {
            port,
            hits,
            _shutdown: shutdown,
        }
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/api/tasks", self.port)
    }

    pub fn hits(&self) -> usize {
        *self.hits.lock().expect("hits")
    }
}

/// The proxy under test, wired to a registry the test controls.
pub struct Harness {
    pub registry: Arc<Registry>,
    pub secrets: Arc<MemorySecretStore>,
    pub capability: String,
    pub proxy: ProxyHandle,
    pub client: reqwest::Client,
    local: Option<(Url, String, String)>,
    dir: tempfile::TempDir,
}

impl Harness {
    /// `local` becomes the built-in Local connection; every entry in `remotes`
    /// is saved as an ordinary remote with its own credential.
    pub async fn start(local: Option<&MockDaemon>, remotes: &[&MockDaemon]) -> (Self, Vec<String>) {
        let dir = tempfile::tempdir().expect("tempdir");
        let secrets = Arc::new(MemorySecretStore::new());
        let local_parts =
            local.map(|daemon| (daemon.url(), daemon.token.clone(), daemon.instance_id()));
        if let Some((url, token, instance_id)) = &local_parts {
            let home = dir.path().join("wisp-home");
            std::fs::create_dir_all(&home).expect("local home");
            std::fs::write(
                home.join("config.json"),
                serde_json::to_vec(&json!({
                    "host": url.host_str().expect("local host"),
                    "port": url.port().expect("local port"),
                    "token": token,
                    "instanceId": instance_id,
                }))
                .expect("local config json"),
            )
            .expect("local config");
        }
        let registry = Arc::new(
            Registry::open(
                dir.path().join("connections.json"),
                secrets.clone(),
                dir.path().join("wisp-home"),
                local_profile(&local_parts, dir.path()),
            )
            .expect("registry opens"),
        );
        let mut ids = Vec::new();
        for daemon in remotes {
            let info = registry
                .add_remote(
                    &format!("Daemon {}", daemon.label),
                    &daemon.url(),
                    &daemon.token,
                    &daemon.instance_id(),
                )
                .expect("saved");
            ids.push(info.id);
        }

        let capability = Capability::generate();
        let exposed = capability.expose().to_string();
        let state = Arc::new(
            ProxyState::new(capability, registry.clone(), proxy::packaged_app_origins())
                .expect("proxy state"),
        );
        let proxy = proxy::start(state).await.expect("proxy binds");
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("test client");
        (
            Self {
                registry,
                secrets,
                capability: exposed,
                proxy,
                client,
                local: local_parts,
                dir,
            },
            ids,
        )
    }

    /// Quit and relaunch the app: same registry file, same credential service,
    /// fresh capability, fresh proxy, and — the point of the exercise — no
    /// in-memory identity or credential state carried over.
    pub async fn relaunch(&mut self) {
        let registry = Arc::new(
            Registry::open(
                self.dir.path().join("connections.json"),
                self.secrets.clone(),
                self.dir.path().join("wisp-home"),
                local_profile(&self.local, self.dir.path()),
            )
            .expect("registry reopens"),
        );
        let capability = Capability::generate();
        self.capability = capability.expose().to_string();
        let state = Arc::new(
            ProxyState::new(capability, registry.clone(), proxy::packaged_app_origins())
                .expect("proxy state"),
        );
        self.proxy = proxy::start(state).await.expect("proxy binds");
        self.registry = registry;
    }

    pub fn base(&self) -> &str {
        self.proxy.base()
    }

    /// `<proxy base>/connections/<id>/<path>`.
    pub fn route(&self, connection_id: &str, path: &str) -> String {
        format!("{}/connections/{connection_id}/{path}", self.proxy.base())
    }

    /// The same route under a capability the caller was never given.
    pub fn route_with_wrong_capability(&self, connection_id: &str, path: &str) -> String {
        let forged = "f".repeat(self.capability.len());
        format!(
            "http://127.0.0.1:{}/{forged}/connections/{connection_id}/{path}",
            self.proxy.port()
        )
    }

    pub fn websocket_route(&self, connection_id: &str, path: &str) -> String {
        self.route(connection_id, path)
            .replacen("http://", "ws://", 1)
    }

    pub fn wisp_home(&self) -> PathBuf {
        self.dir.path().join("wisp-home")
    }

    pub fn set_local_profile_token(&self, token: &str) {
        let path = self.wisp_home().join("config.json");
        let mut config: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).expect("read local config"))
                .expect("local config json");
        config["token"] = serde_json::Value::String(token.to_string());
        std::fs::write(
            path,
            serde_json::to_vec(&config).expect("updated local config json"),
        )
        .expect("update local config");
    }
}

fn local_profile(
    parts: &Option<(Url, String, String)>,
    dir: &std::path::Path,
) -> Result<LocalProfile, wisp_desktop::local::LocalError> {
    match parts {
        Some((url, token, instance)) => Ok(LocalProfile::new(
            url.clone(),
            token.clone(),
            instance.clone(),
            dir.join("wisp-home/config.json"),
        )),
        None => Err(wisp_desktop::local::LocalError::NoProfile(
            dir.join("wisp-home/config.json"),
        )),
    }
}
