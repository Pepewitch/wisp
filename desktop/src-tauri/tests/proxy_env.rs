//! Loopback daemon traffic never goes through an HTTP proxy; remote HTTPS
//! traffic still does.
//!
//! A separate test binary because it sets process-wide proxy variables, which
//! must not leak into the other suites running in parallel. Plain HTTP is
//! allowed only to loopback, so a proxy on that path would receive every
//! daemon bearer token in cleartext; on macOS, system proxy settings are also
//! read without their bypass list, so loopback is not exempt there either.
//! A network with a mandatory proxy must still reach an HTTPS remote, where
//! the proxy only ever sees a CONNECT tunnel. System settings and the
//! environment feed the same client switch, which the environment exercises.

mod support;

use std::sync::{Arc, Mutex};

use support::{Harness, MockDaemon, SHARED_TASK_ID};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use wisp_desktop::core::DesktopCore;
use wisp_desktop::proxy::packaged_app_origins;
use wisp_desktop::secrets::MemorySecretStore;
use wisp_desktop::urls::normalize_daemon_url;

const LOCAL_TOKEN: &str = "synthetic-local-token-proxyenv-0";
const REMOTE_TOKEN: &str = "synthetic-remote-token-proxyenv-1";
const HTTPS_REMOTE: &str = "https://wisp-remote.invalid";

/// A stand-in HTTP proxy: records each request line it receives and refuses
/// it, so nothing is ever forwarded anywhere.
struct CaptureProxy {
    port: u16,
    seen: Arc<Mutex<Vec<String>>>,
}

impl CaptureProxy {
    async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("bind capture proxy");
        let port = listener.local_addr().expect("address").port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let record = record.clone();
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") && head.len() < 16 * 1024 {
                        match socket.read(&mut byte).await {
                            Ok(1) => head.push(byte[0]),
                            _ => break,
                        }
                    }
                    let text = String::from_utf8_lossy(&head);
                    let line = text.lines().next().unwrap_or_default().to_string();
                    record.lock().expect("seen").push(line);
                    let _ = socket
                        .write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
                        .await;
                });
            }
        });
        Self { port, seen }
    }

    fn seen(&self) -> Vec<String> {
        self.seen.lock().expect("seen").clone()
    }
}

#[tokio::test]
async fn loopback_bypasses_the_http_proxy_and_https_remotes_use_it() {
    let capture = CaptureProxy::start().await;
    let proxy_url = format!("http://127.0.0.1:{}", capture.port);
    // Set before any client below is built: reqwest reads these at build time.
    for name in [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        std::env::set_var(name, &proxy_url);
    }
    for name in ["NO_PROXY", "no_proxy", "REQUEST_METHOD"] {
        std::env::remove_var(name);
    }

    let local = MockDaemon::start("alpha", LOCAL_TOKEN, "wisp-instance-alpha").await;
    let remote = MockDaemon::start("bravo", REMOTE_TOKEN, "wisp-instance-bravo").await;
    let (harness, ids) = Harness::start(Some(&local), &[&remote]).await;

    // A read, and a write that first re-proves the daemon identity.
    for connection in ["local", ids[0].as_str()] {
        let read = harness
            .client
            .get(harness.route(connection, &format!("api/tasks/{SHARED_TASK_ID}")))
            .send()
            .await
            .expect("read");
        assert!(
            read.status().is_success(),
            "{connection}: {}",
            read.status()
        );
        let write = harness
            .client
            .post(harness.route(connection, &format!("api/tasks/{SHARED_TASK_ID}/action")))
            .json(&serde_json::json!({ "action": "synthetic" }))
            .send()
            .await
            .expect("write");
        assert!(
            write.status().is_success(),
            "{connection}: {}",
            write.status()
        );
    }

    // The add-remote preview and save probes use the same client.
    let dir = tempfile::tempdir().expect("tempdir");
    let core = DesktopCore::start(
        dir.path().join("connections.json"),
        Arc::new(MemorySecretStore::new()),
        dir.path().join("wisp-home"),
        packaged_app_origins(),
    )
    .await
    .expect("core starts");
    core.probe_remote(remote.url().as_str(), REMOTE_TOKEN)
        .await
        .expect("probe");
    core.add_remote("Studio", remote.url().as_str(), REMOTE_TOKEN)
        .await
        .expect("add");

    assert_eq!(
        capture.seen(),
        Vec::<String>::new(),
        "a loopback request went through the HTTP proxy"
    );
    assert!(local.seen().iter().all(|seen| seen.authorization.as_deref()
        == Some(&format!("Bearer {LOCAL_TOKEN}"))
        || seen.path == "/api/health"));
    assert!(remote
        .seen_paths()
        .iter()
        .any(|path| path.ends_with("/action")));

    // An HTTPS remote still honours the configured proxy — through a CONNECT
    // tunnel, which carries no credential — for both the add-remote probe and
    // the proxied identity check of a saved remote.
    assert!(core.probe_remote(HTTPS_REMOTE, REMOTE_TOKEN).await.is_err());
    let saved = harness
        .registry
        .add_remote(
            "Remote over HTTPS",
            &normalize_daemon_url(HTTPS_REMOTE).expect("https remote"),
            REMOTE_TOKEN,
            "00000000-0000-4000-8000-00000000abcd",
        )
        .expect("saved");
    let proxied = harness
        .client
        .get(harness.route(&saved.id, &format!("api/tasks/{SHARED_TASK_ID}")))
        .send()
        .await
        .expect("proxied request");
    assert_eq!(proxied.status().as_u16(), 502);
    let seen = capture.seen();
    assert_eq!(seen.len(), 2, "{seen:?}");
    for line in &seen {
        assert!(
            line.starts_with("CONNECT wisp-remote.invalid:443 "),
            "{line}"
        );
        assert!(!line.contains(REMOTE_TOKEN), "{line}");
    }
}
