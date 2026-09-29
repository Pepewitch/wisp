//! The native hop never goes through an HTTP proxy.
//!
//! A separate test binary because it sets process-wide proxy variables, which
//! must not leak into the other suites running in parallel. Plain HTTP is
//! allowed only to loopback, so a proxy on that path would receive every
//! daemon bearer token in cleartext; on macOS, system proxy settings are also
//! read without their bypass list, so loopback is not exempt there either.
//! Both come from the same client switch, which the environment exercises.

mod support;

use std::sync::Arc;

use support::{Harness, MockDaemon, Tripwire, SHARED_TASK_ID};
use wisp_desktop::core::DesktopCore;
use wisp_desktop::proxy::packaged_app_origins;
use wisp_desktop::secrets::MemorySecretStore;

const LOCAL_TOKEN: &str = "synthetic-local-token-proxyenv-0";
const REMOTE_TOKEN: &str = "synthetic-remote-token-proxyenv-1";

#[tokio::test]
async fn no_daemon_request_or_identity_probe_goes_through_an_http_proxy() {
    let capture = Tripwire::start().await;
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

    assert_eq!(capture.hits(), 0, "a request went through the HTTP proxy");
    assert!(local.seen().iter().all(|seen| seen.authorization.as_deref()
        == Some(&format!("Bearer {LOCAL_TOKEN}"))
        || seen.path == "/api/health"));
    assert!(remote
        .seen_paths()
        .iter()
        .any(|path| path.ends_with("/action")));
}
