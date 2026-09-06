//! Acceptance tests for the command surface the React shell invokes.
//!
//! These drive `DesktopCore` rather than Tauri itself: the commands in
//! `commands.rs` are one-line adapters over these methods, so testing here
//! covers the behavior without needing a running application and a webview.

mod support;

use std::sync::Arc;

use support::MockDaemon;
use wisp_desktop::core::DesktopCore;
use wisp_desktop::proxy::packaged_app_origins;
use wisp_desktop::secrets::{MemorySecretStore, SecretStore};

const LOCAL_TOKEN: &str = "synthetic-local-token-000000";
const REMOTE_TOKEN: &str = "synthetic-remote-token-11111";

struct App {
    core: DesktopCore,
    secrets: Arc<MemorySecretStore>,
    _dir: tempfile::TempDir,
}

/// Boot a core against a synthetic local daemon and a standard Wisp profile.
async fn app(local: Option<&MockDaemon>) -> App {
    let dir = tempfile::tempdir().expect("tempdir");
    let wisp_home = dir.path().join("wisp-home");
    std::fs::create_dir_all(&wisp_home).expect("home");
    if let Some(daemon) = local {
        std::fs::write(
            wisp_home.join("config.json"),
            serde_json::json!({
                "instanceId": daemon.instance_id(),
                "port": daemon.port,
                "host": "127.0.0.1",
                "token": daemon.token,
            })
            .to_string(),
        )
        .expect("config.json");
    }
    let secrets = Arc::new(MemorySecretStore::new());
    let core = DesktopCore::start(
        dir.path().join("connections.json"),
        secrets.clone(),
        wisp_home,
        packaged_app_origins(),
    )
    .await
    .expect("core starts");
    App {
        core,
        secrets,
        _dir: dir,
    }
}

#[tokio::test]
async fn bootstrap_returns_an_unguessable_base_and_only_non_secret_metadata() {
    let local = MockDaemon::start("alpha", LOCAL_TOKEN, "wisp-instance-alpha").await;
    let app = app(Some(&local)).await;

    let bootstrap = app.core.bootstrap();
    let json = serde_json::to_string(&bootstrap).expect("serializes");

    // The base is loopback, on an ephemeral port, with a per-launch secret in it.
    assert!(bootstrap.proxy_base_url.starts_with("http://127.0.0.1:"));
    let capability = bootstrap
        .proxy_base_url
        .rsplit('/')
        .next()
        .expect("capability segment");
    assert_eq!(capability.len(), 64);
    assert!(capability.chars().all(|c| c.is_ascii_hexdigit()));

    assert_eq!(bootstrap.active_connection_id, "local");
    assert_eq!(bootstrap.connections.len(), 1);
    assert_eq!(bootstrap.connections[0].id, "local");
    assert!(bootstrap.local.available);
    assert!(bootstrap.local.has_token);
    assert!(json.contains("\"proxyBaseUrl\""));
    assert!(json.contains("\"activeConnectionId\":\"local\""));
    assert!(json.contains("\"name\":\"Local\""));
    assert!(!json.contains("\"label\""));

    // The daemon token is not in the payload under any name.
    assert!(!json.contains(LOCAL_TOKEN));
    assert!(!json.contains("\"token\""));
}

#[tokio::test]
async fn a_missing_local_profile_is_reported_rather_than_fatal() {
    let app = app(None).await;
    let bootstrap = app.core.bootstrap();
    assert_eq!(bootstrap.connections.len(), 1);
    assert_eq!(bootstrap.connections[0].id, "local");
    assert!(!bootstrap.connections[0].ready);
    assert!(!bootstrap.local.available);
    assert!(bootstrap.local.reason.is_some());
    // The proxy is still up; a remote-only user is a supported user.
    assert!(bootstrap.proxy_base_url.starts_with("http://127.0.0.1:"));
}

#[tokio::test]
async fn a_remote_is_saved_only_after_an_authenticated_capability_check() {
    let local = MockDaemon::start("alpha", LOCAL_TOKEN, "wisp-instance-alpha").await;
    let remote = MockDaemon::start("bravo", REMOTE_TOKEN, "wisp-instance-bravo").await;
    let app = app(Some(&local)).await;

    let refused = app
        .core
        .add_remote("Studio", remote.url().as_str(), "a-token-it-will-reject")
        .await;
    assert!(refused.is_err());
    assert!(refused.unwrap_err().to_string().contains("token"));
    // Nothing was written, and no credential was banked on a failed check.
    assert_eq!(app.core.bootstrap().connections.len(), 1);
    assert!(app.secrets.accounts().is_empty());

    let saved = app
        .core
        .add_remote("Studio", remote.url().as_str(), REMOTE_TOKEN)
        .await
        .expect("saved");
    assert_eq!(saved.label, "Studio");
    assert_eq!(saved.instance_id, "wisp-instance-bravo");
    assert!(saved.ready);
    assert_eq!(app.secrets.accounts(), vec![saved.id.clone()]);
    assert_eq!(
        app.secrets.get(&saved.id).expect("get").as_deref(),
        Some(REMOTE_TOKEN)
    );
    assert!(remote
        .seen_paths()
        .iter()
        .any(|path| path == "/api/capabilities"));
}

#[tokio::test]
async fn an_address_this_app_will_not_talk_to_is_refused_before_any_request() {
    let local = MockDaemon::start("alpha", LOCAL_TOKEN, "wisp-instance-alpha").await;
    let app = app(Some(&local)).await;

    for url in [
        "http://wisp.example.com",
        "http://localhost:8710",
        "ws://127.0.0.1:8710",
        "file:///etc/passwd",
        "wisp.example.com",
        "https://user:secret@wisp.example.com",
    ] {
        let error = app
            .core
            .add_remote("Nope", url, REMOTE_TOKEN)
            .await
            .expect_err(&format!("{url} must be refused"));
        // A refusal the user can act on, not a stack trace.
        assert!(!error.to_string().is_empty());
    }
    assert!(app.secrets.accounts().is_empty());
    assert_eq!(app.core.bootstrap().connections.len(), 1);
}

#[tokio::test]
async fn a_missing_token_is_refused_without_contacting_anything() {
    let local = MockDaemon::start("alpha", LOCAL_TOKEN, "wisp-instance-alpha").await;
    let remote = MockDaemon::start("bravo", REMOTE_TOKEN, "wisp-instance-bravo").await;
    let app = app(Some(&local)).await;

    let error = app
        .core
        .add_remote("Studio", remote.url().as_str(), "   ")
        .await
        .expect_err("refused");
    assert!(error.to_string().contains("token"));
    assert!(remote.seen().is_empty());
}

#[tokio::test]
async fn renaming_changes_the_label_and_nothing_else() {
    let local = MockDaemon::start("alpha", LOCAL_TOKEN, "wisp-instance-alpha").await;
    let remote = MockDaemon::start("bravo", REMOTE_TOKEN, "wisp-instance-bravo").await;
    let app = app(Some(&local)).await;
    let saved = app
        .core
        .add_remote("Studio", remote.url().as_str(), REMOTE_TOKEN)
        .await
        .expect("saved");

    let renamed = app.core.rename(&saved.id, "Studio (EU)").expect("renamed");
    assert_eq!(renamed.id, saved.id);
    assert_eq!(renamed.url, saved.url);
    assert_eq!(renamed.label, "Studio (EU)");
    assert_eq!(app.secrets.accounts(), vec![saved.id.clone()]);
    let local = app.core.rename("local", "This Mac").expect("local rename");
    assert_eq!(local.label, "This Mac");
    assert_eq!(local.id, "local");
}

#[tokio::test]
async fn reconnecting_the_same_address_refreshes_the_connection_in_place() {
    let local = MockDaemon::start("alpha", LOCAL_TOKEN, "wisp-instance-alpha").await;
    let remote = MockDaemon::start("bravo", REMOTE_TOKEN, "wisp-instance-bravo").await;
    let app = app(Some(&local)).await;
    let saved = app
        .core
        .add_remote("Studio", remote.url().as_str(), REMOTE_TOKEN)
        .await
        .expect("saved");

    let refreshed = app
        .core
        .reconnect(&saved.id, None, None)
        .await
        .expect("reconnected");
    assert_eq!(refreshed.id, saved.id, "an unchanged address keeps its ID");
    assert_eq!(refreshed.url, saved.url);
    assert_eq!(app.secrets.accounts(), vec![saved.id.clone()]);
}

#[tokio::test]
async fn reconnecting_to_a_new_address_mints_a_replacement_rather_than_retargeting() {
    let local = MockDaemon::start("alpha", LOCAL_TOKEN, "wisp-instance-alpha").await;
    let first = MockDaemon::start("bravo", REMOTE_TOKEN, "wisp-instance-bravo").await;
    let second = MockDaemon::start("charlie", REMOTE_TOKEN, "wisp-instance-charlie").await;
    let app = app(Some(&local)).await;
    let saved = app
        .core
        .add_remote("Studio", first.url().as_str(), REMOTE_TOKEN)
        .await
        .expect("saved");

    let replacement = app
        .core
        .reconnect(&saved.id, Some(second.url().as_str()), Some(REMOTE_TOKEN))
        .await
        .expect("reconnected");

    assert_ne!(replacement.id, saved.id);
    assert_eq!(replacement.label, "Studio");
    assert_eq!(replacement.instance_id, "wisp-instance-charlie");
    // The old ID is revoked, so anything still in flight fails closed instead
    // of quietly addressing the new daemon.
    assert!(app.core.registry().resolve(&saved.id).is_none());
    assert_eq!(app.secrets.accounts(), vec![replacement.id.clone()]);
}

#[tokio::test]
async fn a_failed_reconnect_leaves_the_saved_connection_exactly_as_it_was() {
    let local = MockDaemon::start("alpha", LOCAL_TOKEN, "wisp-instance-alpha").await;
    let remote = MockDaemon::start("bravo", REMOTE_TOKEN, "wisp-instance-bravo").await;
    let app = app(Some(&local)).await;
    let saved = app
        .core
        .add_remote("Studio", remote.url().as_str(), REMOTE_TOKEN)
        .await
        .expect("saved");

    let error = app
        .core
        .reconnect(&saved.id, None, Some("a-token-it-will-reject"))
        .await
        .expect_err("refused");
    assert!(error.to_string().contains("token"));

    let listed = app.core.bootstrap().connections;
    let entry = listed.iter().find(|c| c.id == saved.id).expect("unchanged");
    assert_eq!(entry.url, saved.url);
    assert_eq!(entry.label, "Studio");
    assert_eq!(
        app.secrets.get(&saved.id).expect("get").as_deref(),
        Some(REMOTE_TOKEN),
        "a rejected token must not overwrite the working one"
    );
}

#[tokio::test]
async fn removing_a_connection_takes_its_credential_with_it() {
    let local = MockDaemon::start("alpha", LOCAL_TOKEN, "wisp-instance-alpha").await;
    let remote = MockDaemon::start("bravo", REMOTE_TOKEN, "wisp-instance-bravo").await;
    let app = app(Some(&local)).await;
    let saved = app
        .core
        .add_remote("Studio", remote.url().as_str(), REMOTE_TOKEN)
        .await
        .expect("saved");

    app.core.remove(&saved.id).expect("removed");
    assert!(app.secrets.accounts().is_empty());
    assert!(app.core.registry().resolve(&saved.id).is_none());
    assert_eq!(app.core.bootstrap().connections.len(), 1);
    // The built-in local connection is not removable.
    assert!(app.core.remove("local").is_err());
}

#[tokio::test]
async fn the_local_setup_report_describes_the_machine_without_changing_it() {
    let local = MockDaemon::start("alpha", LOCAL_TOKEN, "wisp-instance-alpha").await;
    let app = app(Some(&local)).await;

    let report = app.core.local_setup().await;
    assert!(report.status.available);
    assert!(report.daemon_reachable);
    assert_eq!(report.next_step, wisp_desktop::setup::NextStep::Ready);
    let json = serde_json::to_string(&report).expect("serializes");
    assert!(!json.contains(LOCAL_TOKEN));

    // Nothing was installed, initialized, or started.
    assert!(local
        .seen_paths()
        .iter()
        .all(|path| path == "/api/health" || path == "/api/capabilities"));
}

#[tokio::test]
async fn a_machine_with_no_profile_is_told_what_is_missing() {
    let app = app(None).await;
    let report = app.core.local_setup().await;
    assert!(!report.status.available);
    assert!(!report.daemon_reachable);
    assert!(matches!(
        report.next_step,
        wisp_desktop::setup::NextStep::InstallCli | wisp_desktop::setup::NextStep::RunInit
    ));
    assert!(!report.message.is_empty());
}
