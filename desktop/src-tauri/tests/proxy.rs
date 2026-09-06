//! Acceptance tests for the native loopback proxy.
//!
//! Structured around the rules in `docs/DESKTOP-TRANSPORT.md` §"Credential and
//! proxy rules". Two synthetic daemons are seeded with the *same* task ID
//! throughout, so a routing mistake surfaces as the wrong daemon's content
//! rather than as a 404 nobody would notice.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use support::{attachment_bytes, Harness, MockDaemon, Tripwire, SHARED_TASK_ID};
use wisp_desktop::capability::Capability;
use wisp_desktop::local::LocalProfile;
use wisp_desktop::proxy::{self, ProxyHandle, ProxyState};
use wisp_desktop::registry::{Identity, Registry, RegistryError, Target};
use wisp_desktop::secrets::SecretStore;

const TOKEN_ONE: &str = "synthetic-token-alpha-0000000000";
const TOKEN_TWO: &str = "synthetic-token-bravo-1111111111";

async fn two_daemons() -> (MockDaemon, MockDaemon) {
    (
        MockDaemon::start("alpha", TOKEN_ONE, "wisp-instance-alpha").await,
        MockDaemon::start("bravo", TOKEN_TWO, "wisp-instance-bravo").await,
    )
}

/// Accept TCP connections without ever writing response bytes.
async fn stalled_origin() -> (url::Url, tokio::sync::oneshot::Sender<()>) {
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind stalled origin");
    let port = listener
        .local_addr()
        .expect("stalled origin address")
        .port();
    let (shutdown, mut wait) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let Ok((socket, _peer)) = accepted else { break };
                    tokio::spawn(async move {
                        let _socket = socket;
                        std::future::pending::<()>().await;
                    });
                }
                _ = &mut wait => break,
            }
        }
    });
    (
        url::Url::parse(&format!("http://127.0.0.1:{port}/")).expect("stalled origin URL"),
        shutdown,
    )
}

async fn short_timeout_proxy(harness: &Harness) -> ProxyHandle {
    let state = ProxyState::new(
        Capability::generate(),
        harness.registry.clone(),
        proxy::packaged_app_origins(),
    )
    .expect("proxy state")
    .with_upstream_handshake_timeout(Duration::from_millis(100));
    proxy::start(Arc::new(state)).await.expect("proxy binds")
}

fn held_request_body() -> (reqwest::Body, tokio::sync::oneshot::Sender<()>) {
    let (release, wait) = tokio::sync::oneshot::channel();
    let stream = futures_util::stream::once(async move {
        wait.await
            .map_err(|_| std::io::Error::other("held request body was cancelled"))?;
        Ok::<_, std::io::Error>(bytes::Bytes::from_static(b"{}"))
    });
    (reqwest::Body::wrap_stream(stream), release)
}

async fn wait_for_verified(registry: &Registry, target: &Target) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if matches!(registry.identity(target), Ok(Identity::Verified)) {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("identity probe completed before the held body");
}

/* ── routing ─────────────────────────────────────────────────────────────── */

#[tokio::test]
async fn two_daemons_sharing_a_task_id_never_answer_for_each_other() {
    let (alpha, bravo) = two_daemons().await;
    let (harness, ids) = Harness::start(Some(&alpha), &[&bravo]).await;
    let remote = &ids[0];

    let from_local: serde_json::Value = harness
        .client
        .get(harness.route("local", &format!("api/tasks/{SHARED_TASK_ID}")))
        .send()
        .await
        .expect("local request")
        .json()
        .await
        .expect("json");
    let from_remote: serde_json::Value = harness
        .client
        .get(harness.route(remote, &format!("api/tasks/{SHARED_TASK_ID}")))
        .send()
        .await
        .expect("remote request")
        .json()
        .await
        .expect("json");

    assert_eq!(from_local["daemon"], "alpha");
    assert_eq!(from_remote["daemon"], "bravo");
    assert_eq!(from_local["id"], SHARED_TASK_ID);
    assert_eq!(from_remote["id"], SHARED_TASK_ID);
}

#[tokio::test]
async fn a_stale_local_generation_cannot_reach_a_replacement_daemon() {
    let (alpha, bravo) = two_daemons().await;
    let (harness, _ids) = Harness::start(Some(&alpha), &[]).await;
    let action_path = format!("api/tasks/{SHARED_TASK_ID}/action");
    let terminal_path = format!("api/tasks/{SHARED_TASK_ID}/terminal?shell=1");
    let stale_action = harness.route_at("local", 0, &action_path);
    let stale_terminal = harness
        .route_at("local", 0, &terminal_path)
        .replacen("http://", "ws://", 1);
    let (mut open_terminal, _) = tokio_tungstenite::connect_async(stale_terminal.clone())
        .await
        .expect("generation zero terminal opens before retarget");
    let _hello = open_terminal.next().await.expect("hello frame");

    harness
        .registry
        .refresh_local(LocalProfile::new(
            bravo.url(),
            TOKEN_TWO.to_string(),
            bravo.instance_id(),
            harness.wisp_home().join("config.json"),
        ))
        .expect("retarget Local");
    assert_eq!(harness.registry.list()[0].route_revision, 1);
    let before = bravo.seen().len();

    let refused = harness
        .client
        .post(stale_action)
        .send()
        .await
        .expect("proxy refuses stale write");
    assert_eq!(refused.status().as_u16(), 409);
    assert_eq!(
        refused
            .headers()
            .get("x-wisp-proxy-error")
            .and_then(|value| value.to_str().ok()),
        Some("stale-route")
    );
    match tokio_tungstenite::connect_async(stale_terminal).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            assert_eq!(response.status().as_u16(), 409);
        }
        other => panic!("stale terminal must be rejected locally, got {other:?}"),
    }
    assert_eq!(bravo.seen().len(), before, "stale routes stayed native");

    open_terminal
        .send(tokio_tungstenite::tungstenite::Message::Text(
            "stale command".into(),
        ))
        .await
        .ok();
    let after_retarget = tokio::time::timeout(Duration::from_secs(1), open_terminal.next())
        .await
        .expect("an already-open stale terminal is revoked promptly");
    assert!(
        !matches!(
            after_retarget,
            Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text)))
                if text.contains("stale command")
        ),
        "stale terminal input must not reach its former daemon"
    );

    let accepted = harness
        .client
        .post(harness.route("local", &action_path))
        .send()
        .await
        .expect("current generation writes");
    assert!(accepted.status().is_success());
    assert!(bravo
        .seen_paths()
        .iter()
        .any(|path| path.ends_with("/action")));
}

#[tokio::test]
async fn local_retarget_while_a_request_body_is_pending_revokes_the_write() {
    let (alpha, bravo) = two_daemons().await;
    let (mut harness, _ids) = Harness::start(Some(&alpha), &[]).await;
    harness.relaunch().await;
    let old_target = harness.registry.resolve("local").expect("old Local");
    assert!(matches!(
        harness.registry.identity(&old_target),
        Ok(Identity::Unchecked)
    ));
    let (body, release_body) = held_request_body();
    let client = harness.client.clone();
    let route = harness.route("local", &format!("api/tasks/{SHARED_TASK_ID}/action"));
    let pending = tokio::spawn(async move {
        client
            .post(route)
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
            .expect("held Local write")
    });

    // Unchecked -> Verified is observable only after the handler has completed
    // its identity probe and yielded while collecting the held body.
    wait_for_verified(&harness.registry, &old_target).await;
    harness
        .registry
        .refresh_local(LocalProfile::new(
            bravo.url(),
            TOKEN_TWO.to_string(),
            bravo.instance_id(),
            harness.wisp_home().join("config.json"),
        ))
        .expect("retarget Local");
    assert!(matches!(
        harness.registry.reload_local_credential(&old_target),
        Err(RegistryError::LocalProfileChanged)
    ));
    assert_eq!(
        harness
            .registry
            .resolve("local")
            .expect("current Local")
            .instance_id,
        bravo.instance_id(),
        "a stale credential reload cannot overwrite the replacement profile"
    );

    release_body.send(()).expect("release request body");
    let response = pending.await.expect("held request task");
    assert_eq!(response.status(), reqwest::StatusCode::CONFLICT);
    assert_eq!(
        response
            .headers()
            .get("x-wisp-proxy-error")
            .and_then(|value| value.to_str().ok()),
        Some("stale-route")
    );
    assert_eq!(
        alpha
            .seen_paths()
            .iter()
            .filter(|path| path.ends_with("/action"))
            .count(),
        0,
        "the revoked write never reaches the former Local daemon"
    );
}

#[tokio::test]
async fn remote_removal_while_a_request_body_is_pending_revokes_the_write() {
    let (alpha, bravo) = two_daemons().await;
    let (mut harness, ids) = Harness::start(Some(&alpha), &[&bravo]).await;
    let remote = ids[0].clone();
    harness.relaunch().await;
    let target = harness.registry.resolve(&remote).expect("remote target");
    assert!(matches!(
        harness.registry.identity(&target),
        Ok(Identity::Unchecked)
    ));
    let (body, release_body) = held_request_body();
    let client = harness.client.clone();
    let route = harness.route(&remote, &format!("api/tasks/{SHARED_TASK_ID}/action"));
    let pending = tokio::spawn(async move {
        client
            .post(route)
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
            .expect("held remote write")
    });

    wait_for_verified(&harness.registry, &target).await;
    harness.registry.remove(&remote).expect("remove remote");
    release_body.send(()).expect("release request body");

    let response = pending.await.expect("held request task");
    assert_eq!(response.status(), reqwest::StatusCode::CONFLICT);
    assert_eq!(
        response
            .headers()
            .get("x-wisp-proxy-error")
            .and_then(|value| value.to_str().ok()),
        Some("stale-route")
    );
    assert_eq!(
        bravo
            .seen_paths()
            .iter()
            .filter(|path| path.ends_with("/action"))
            .count(),
        0,
        "the removed connection never reaches the remote mutation endpoint"
    );
}

#[tokio::test]
async fn each_daemon_only_ever_sees_its_own_credential() {
    let (alpha, bravo) = two_daemons().await;
    let (harness, ids) = Harness::start(Some(&alpha), &[&bravo]).await;

    for connection in ["local", ids[0].as_str()] {
        harness
            .client
            .get(harness.route(connection, "api/whoami"))
            .send()
            .await
            .expect("request");
    }

    let alpha_auth: Vec<Option<String>> =
        alpha.seen().into_iter().map(|r| r.authorization).collect();
    let bravo_auth: Vec<Option<String>> =
        bravo.seen().into_iter().map(|r| r.authorization).collect();

    assert!(alpha_auth
        .iter()
        .all(|value| value.as_deref() == Some(format!("Bearer {TOKEN_ONE}").as_str())));
    assert!(bravo_auth
        .iter()
        .all(|value| value.as_deref() == Some(format!("Bearer {TOKEN_TWO}").as_str())));
    // The decisive assertion: neither token ever appeared at the other daemon.
    assert!(!format!("{alpha_auth:?}").contains(TOKEN_TWO));
    assert!(!format!("{bravo_auth:?}").contains(TOKEN_ONE));
}

#[tokio::test]
async fn query_strings_and_encoded_path_segments_survive_the_hop() {
    let (alpha, _bravo) = two_daemons().await;
    let (harness, _ids) = Harness::start(Some(&alpha), &[]).await;

    let response = harness
        .client
        .get(harness.route(
            "local",
            &format!("api/tasks/{SHARED_TASK_ID}/attachments/a%20b%2Bc.png?turn=1&x=%2F"),
        ))
        .send()
        .await
        .expect("request");
    assert!(response.status().is_success());
    // The daemon decoded exactly one level: the encoding was not doubled or lost.
    assert_eq!(
        response
            .headers()
            .get("x-attachment-name")
            .and_then(|v| v.to_str().ok()),
        Some("a b+c.png")
    );
    let seen = alpha.seen();
    let last = seen.last().expect("a request arrived");
    assert_eq!(last.query.as_deref(), Some("turn=1&x=%2F"));
    assert!(last.path.ends_with("/a%20b%2Bc.png"));
}

/* ── the per-launch capability ───────────────────────────────────────────── */

#[tokio::test]
async fn every_route_kind_requires_the_per_launch_capability() {
    let (alpha, _bravo) = two_daemons().await;
    let (harness, _ids) = Harness::start(Some(&alpha), &[]).await;

    for path in [
        format!("api/tasks/{SHARED_TASK_ID}"),
        "api/events".to_string(),
        format!("api/tasks/{SHARED_TASK_ID}/attachments/shot.png"),
    ] {
        let response = harness
            .client
            .get(harness.route_with_wrong_capability("local", &path))
            .send()
            .await
            .expect("request");
        assert_eq!(response.status().as_u16(), 404, "{path} must be refused");
    }

    let forged = "f".repeat(harness.capability.len());
    let socket_url = format!(
        "ws://127.0.0.1:{}/{forged}/connections/local/0/api/tasks/{SHARED_TASK_ID}/terminal",
        harness.proxy.port()
    );
    assert!(
        tokio_tungstenite::connect_async(socket_url).await.is_err(),
        "a terminal upgrade without the capability must not connect"
    );

    // Nothing reached the daemon at all.
    assert!(alpha.seen().is_empty());
}

#[tokio::test]
async fn a_request_from_outside_the_packaged_app_is_refused() {
    let (alpha, _bravo) = two_daemons().await;
    let (harness, _ids) = Harness::start(Some(&alpha), &[]).await;

    let response = harness
        .client
        .get(harness.route("local", &format!("api/tasks/{SHARED_TASK_ID}")))
        .header("origin", "https://evil.example.com")
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 403);
    assert!(alpha.seen().is_empty());

    // The origins the packaged webview actually uses still work.
    let allowed = harness
        .client
        .get(harness.route("local", &format!("api/tasks/{SHARED_TASK_ID}")))
        .header("origin", "tauri://localhost")
        .send()
        .await
        .expect("request");
    assert!(allowed.status().is_success());
    assert_eq!(
        allowed
            .headers()
            .get("access-control-allow-origin")
            .and_then(|value| value.to_str().ok()),
        Some("tauri://localhost")
    );
}

#[tokio::test]
async fn webview_preflights_are_answered_locally_and_actual_responses_enable_cors() {
    let (alpha, _bravo) = two_daemons().await;
    let (harness, _ids) = Harness::start(Some(&alpha), &[]).await;
    let route = harness.route("local", &format!("api/tasks/{SHARED_TASK_ID}/action"));
    let before = alpha.seen().len();

    let preflight = harness
        .client
        .request(reqwest::Method::OPTIONS, &route)
        .header("origin", "tauri://localhost")
        .header("access-control-request-method", "POST")
        .header("access-control-request-headers", "content-type")
        .header("access-control-request-private-network", "true")
        .send()
        .await
        .expect("preflight");
    assert_eq!(preflight.status().as_u16(), 204);
    assert_eq!(alpha.seen().len(), before, "preflight stayed in the proxy");
    assert_eq!(
        preflight
            .headers()
            .get("access-control-allow-origin")
            .and_then(|value| value.to_str().ok()),
        Some("tauri://localhost")
    );
    assert_eq!(
        preflight
            .headers()
            .get("access-control-allow-private-network")
            .and_then(|value| value.to_str().ok()),
        Some("true")
    );

    let actual = harness
        .client
        .post(route)
        .header("origin", "tauri://localhost")
        .json(&serde_json::json!({ "action": "synthetic" }))
        .send()
        .await
        .expect("actual request");
    assert!(actual.status().is_success());
    assert_eq!(
        actual
            .headers()
            .get("access-control-expose-headers")
            .and_then(|value| value.to_str().ok()),
        Some("x-wisp-proxy-error, x-wisp-proxy-redirect")
    );
}

/* ── credentials in and out ──────────────────────────────────────────────── */

#[tokio::test]
async fn client_authorization_and_cookies_never_reach_a_daemon() {
    let (alpha, _bravo) = two_daemons().await;
    let (harness, _ids) = Harness::start(Some(&alpha), &[]).await;

    let echoed: serde_json::Value = harness
        .client
        .get(harness.route("local", "api/whoami"))
        .header("authorization", "Bearer forged-by-the-frontend")
        .header("cookie", "wisp_token=forged-by-the-frontend")
        .send()
        .await
        .expect("request")
        .json()
        .await
        .expect("json");

    // Replaced, not appended: exactly one Authorization, and it is the native one.
    assert_eq!(echoed["authorization"], format!("Bearer {TOKEN_ONE}"));
    assert!(echoed["cookie"].is_null());
    let raw = echoed.to_string();
    assert!(!raw.contains("forged-by-the-frontend"));
    let authorization_headers = echoed["headers"]
        .as_array()
        .expect("headers")
        .iter()
        .filter(|pair| pair[0] == "authorization")
        .count();
    assert_eq!(authorization_headers, 1);
}

#[tokio::test]
async fn an_upstream_set_cookie_never_reaches_the_webview() {
    let (alpha, _bravo) = two_daemons().await;
    let (harness, _ids) = Harness::start(Some(&alpha), &[]).await;

    let response = harness
        .client
        .get(harness.route("local", "api/cookie"))
        .send()
        .await
        .expect("request");
    assert!(response.status().is_success());
    assert!(response.headers().get("set-cookie").is_none());
    assert!(response.headers().get("x-wisp-proxy-error").is_none());
    assert!(response.headers().get("x-wisp-proxy-redirect").is_none());
    assert_eq!(response.text().await.expect("body"), r#"{"ok":true}"#);
}

#[tokio::test]
async fn a_redirect_is_relayed_but_never_followed_and_never_selects_a_target() {
    let (alpha, _bravo) = two_daemons().await;
    let tripwire = Tripwire::start().await;
    alpha.point_redirect_at(&tripwire.url());
    let (harness, _ids) = Harness::start(Some(&alpha), &[]).await;

    let response = harness
        .client
        .get(harness.route("local", "api/redirect"))
        .send()
        .await
        .expect("request");

    // Upstream status is preserved — a daemon refusal is not laundered into a
    // generic proxy failure — but the redirect cannot choose a new target.
    assert_eq!(response.status().as_u16(), 302);
    assert!(response.headers().get("location").is_none());
    assert_eq!(
        response
            .headers()
            .get("x-wisp-proxy-redirect")
            .and_then(|v| v.to_str().ok()),
        Some("blocked")
    );
    assert_eq!(
        tripwire.hits(),
        0,
        "no redirect target may be contacted, with or without a credential"
    );
}

#[tokio::test]
async fn a_connection_whose_credential_is_gone_fails_closed_rather_than_open() {
    let (alpha, bravo) = two_daemons().await;
    let (mut harness, ids) = Harness::start(Some(&alpha), &[&bravo]).await;
    let remote = ids[0].clone();

    // The Keychain item is gone — revoked elsewhere, or a restored machine.
    harness.secrets.delete(&remote).expect("delete");
    harness.relaunch().await;

    let before = bravo.seen().len();
    let response = harness
        .client
        .get(harness.route(&remote, "api/whoami"))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 503);
    assert_eq!(
        response
            .headers()
            .get("x-wisp-proxy-error")
            .and_then(|v| v.to_str().ok()),
        Some("no-credential")
    );
    assert_eq!(
        bravo.seen().len(),
        before,
        "an uncredentialed request must never be sent unauthenticated"
    );

    // It is still listed, so the user can reconnect it rather than guess.
    let listed = harness.registry.list();
    let entry = listed
        .iter()
        .find(|c| c.id == remote)
        .expect("still listed");
    assert!(!entry.ready);
}

#[tokio::test]
async fn local_get_reloads_a_rotated_profile_token_once_and_retries() {
    let local = MockDaemon::start("alpha", TOKEN_ONE, "wisp-instance-alpha").await;
    let (harness, _) = Harness::start(Some(&local), &[]).await;
    let rotated = "synthetic-token-rotated-2222222222";
    local.rotate_token(rotated);
    harness.set_local_profile_token(rotated);

    let response = harness
        .client
        .get(harness.route("local", "api/whoami"))
        .send()
        .await
        .expect("request");
    assert!(response.status().is_success());
    let seen = local.seen();
    assert_eq!(
        seen.len(),
        3,
        "stale identity proof, retried proof, then the requested read"
    );
    assert_eq!(
        seen[0].authorization.as_deref(),
        Some(format!("Bearer {TOKEN_ONE}").as_str())
    );
    assert_eq!(
        seen[1].authorization.as_deref(),
        Some(format!("Bearer {rotated}").as_str())
    );
    assert_eq!(
        seen[2].authorization.as_deref(),
        Some(format!("Bearer {rotated}").as_str())
    );
    let local_target = harness.registry.resolve("local").expect("local target");
    assert_eq!(
        harness
            .registry
            .identity(&local_target)
            .expect("current local target"),
        Identity::Verified,
        "only the successful capabilities retry proves identity"
    );

    let mutation = harness
        .client
        .post(harness.route("local", &format!("api/tasks/{SHARED_TASK_ID}/action")))
        .header("content-type", "application/json")
        .body("{}")
        .send()
        .await
        .expect("mutation after rotated read");
    assert!(mutation.status().is_success());
    let paths = local.seen_paths();
    assert_eq!(paths[3], "/api/capabilities");
    assert!(paths[4].ends_with("/action"));
}

#[tokio::test]
async fn local_mutation_replays_its_bounded_body_after_token_rotation() {
    let local = MockDaemon::start("alpha", TOKEN_ONE, "wisp-instance-alpha").await;
    let (harness, _) = Harness::start(Some(&local), &[]).await;
    let path = format!("api/tasks/{SHARED_TASK_ID}/action");
    assert!(harness
        .client
        .post(harness.route("local", &path))
        .header("content-type", "application/json")
        .body(r#"{"before":true}"#)
        .send()
        .await
        .expect("prime identity")
        .status()
        .is_success());

    let rotated = "synthetic-token-rotated-3333333333";
    local.rotate_token(rotated);
    harness.set_local_profile_token(rotated);
    let before = local.seen().len();
    let response = harness
        .client
        .post(harness.route("local", &path))
        .header("content-type", "application/json")
        .body(r#"{"after":true}"#)
        .send()
        .await
        .expect("rotated mutation");
    assert!(response.status().is_success());
    assert_eq!(
        local.seen().len() - before,
        3,
        "stale identity proof, retried proof, then one mutation"
    );
}

#[tokio::test]
async fn local_auth_retry_preserves_unauthorized_after_one_failed_reload() {
    let local = MockDaemon::start("alpha", TOKEN_ONE, "wisp-instance-alpha").await;
    let (harness, _) = Harness::start(Some(&local), &[]).await;
    local.rotate_token("synthetic-daemon-token-4444444444");
    harness.set_local_profile_token("synthetic-still-wrong-token-555555");

    let response = harness
        .client
        .get(harness.route("local", "api/whoami"))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(local.seen().len(), 2, "the proxy retries exactly once");
}

#[tokio::test]
async fn desktop_update_refuses_an_incompatible_target_protocol() {
    let local = MockDaemon::start("alpha", TOKEN_ONE, "wisp-instance-alpha").await;
    local.use_update_protocol(2);
    let (harness, _) = Harness::start(Some(&local), &[]).await;

    let response = harness
        .client
        .post(harness.route("local", "api/update"))
        .header("content-type", "application/json")
        .body(r#"{"version":"0.0.1-synthetic"}"#)
        .send()
        .await
        .expect("request");
    assert_eq!(response.status(), reqwest::StatusCode::CONFLICT);
    assert_eq!(
        response
            .headers()
            .get("x-wisp-proxy-error")
            .and_then(|value| value.to_str().ok()),
        Some("incompatible-update")
    );
    assert_eq!(
        local
            .seen()
            .iter()
            .filter(|request| request.path == "/api/update" && request.method == "POST")
            .count(),
        0,
        "the incompatible update command must not reach the daemon"
    );
}

#[tokio::test]
async fn compatible_update_reloads_a_rotated_local_token_before_posting() {
    let local = MockDaemon::start("alpha", TOKEN_ONE, "wisp-instance-alpha").await;
    let (harness, _) = Harness::start(Some(&local), &[]).await;
    // Prime one successful write before rotating the Local credential.
    assert!(harness
        .client
        .post(harness.route("local", &format!("api/tasks/{SHARED_TASK_ID}/action")))
        .header("content-type", "application/json")
        .body("{}")
        .send()
        .await
        .expect("prime identity")
        .status()
        .is_success());

    let rotated = "synthetic-token-rotated-update-66666";
    local.rotate_token(rotated);
    harness.set_local_profile_token(rotated);
    let response = harness
        .client
        .post(harness.route("local", "api/update"))
        .header("content-type", "application/json")
        .body(r#"{"version":"0.0.1-synthetic"}"#)
        .send()
        .await
        .expect("update");
    assert!(response.status().is_success());
    let update_requests: Vec<_> = local
        .seen()
        .into_iter()
        .filter(|request| request.path == "/api/update")
        .collect();
    assert_eq!(update_requests.len(), 2, "one compatibility GET, one POST");
    assert_eq!(update_requests.last().expect("POST").method, "POST");
    assert_eq!(
        update_requests
            .last()
            .expect("POST")
            .authorization
            .as_deref(),
        Some(format!("Bearer {rotated}").as_str())
    );
}

#[tokio::test]
async fn an_unknown_connection_id_is_not_a_target() {
    let (alpha, _bravo) = two_daemons().await;
    let (harness, _ids) = Harness::start(Some(&alpha), &[]).await;

    let response = harness
        .client
        .get(harness.route("c-never-added0000", "api/whoami"))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 404);
    assert_eq!(
        response
            .headers()
            .get("x-wisp-proxy-error")
            .and_then(|v| v.to_str().ok()),
        Some("unknown-connection")
    );
}

/* ── frontend-supplied targets ───────────────────────────────────────────── */

#[tokio::test]
async fn a_frontend_cannot_supply_or_override_an_upstream_target() {
    let (alpha, _bravo) = two_daemons().await;
    let tripwire = Tripwire::start().await;
    let (harness, _ids) = Harness::start(Some(&alpha), &[]).await;

    let attempts = [
        // An absolute URL where the daemon path belongs.
        format!("api/http://127.0.0.1:{}/api/tasks", tripwire.port),
        // Protocol-relative.
        format!("api//127.0.0.1:{}/api/tasks", tripwire.port),
        // Traversal out of the approved prefix.
        "api/../../api/tasks".to_string(),
        "api/%2e%2e/%2e%2e/api/tasks".to_string(),
    ];
    for attempt in attempts {
        let url = harness.route("local", &attempt);
        let response = harness.client.get(&url).send().await.expect("request");
        assert!(
            response.status().is_client_error() || response.status().is_success(),
            "{url} produced {}",
            response.status()
        );
        assert_eq!(tripwire.hits(), 0, "{url} reached a frontend-named target");
    }

    // A query parameter naming another daemon is just a query parameter.
    let response = harness
        .client
        .get(harness.route(
            "local",
            &format!("api/whoami?url=http://127.0.0.1:{}/api", tripwire.port),
        ))
        .send()
        .await
        .expect("request");
    assert!(response.status().is_success());
    assert_eq!(tripwire.hits(), 0);
    let landed: serde_json::Value = response.json().await.expect("json");
    assert_eq!(landed["daemon"], "alpha");

    // An unknown connection ID is not a target either.
    let unknown = harness
        .client
        .get(harness.route("c-not-a-connection", "api/whoami"))
        .send()
        .await
        .expect("request");
    assert_eq!(unknown.status().as_u16(), 404);
}

#[tokio::test]
async fn nothing_but_the_daemon_api_is_reachable_through_the_proxy() {
    let (alpha, _bravo) = two_daemons().await;
    let (harness, _ids) = Harness::start(Some(&alpha), &[]).await;

    for path in ["index.html", "", "apiary/tasks", "../etc/passwd"] {
        let response = harness
            .client
            .get(harness.route("local", path))
            .send()
            .await
            .expect("request");
        assert_eq!(
            response.status().as_u16(),
            404,
            "{path} must not be a proxy route"
        );
    }
    assert!(alpha.seen().is_empty());
}

/* ── streaming ───────────────────────────────────────────────────────────── */

#[tokio::test]
async fn an_upstream_that_never_sends_http_headers_times_out() {
    let (alpha, _bravo) = two_daemons().await;
    let (harness, _ids) = Harness::start(Some(&alpha), &[]).await;
    let (url, shutdown) = stalled_origin().await;
    let connection = harness
        .registry
        .add_remote(
            "Stalled HTTP",
            &url,
            "synthetic-stalled-token",
            "00000000-0000-4000-8000-000000000042",
        )
        .expect("save stalled connection");
    let proxy = short_timeout_proxy(&harness).await;

    let response = harness
        .client
        .get(format!(
            "{}/connections/{}/0/api/whoami",
            proxy.base(),
            connection.id
        ))
        .send()
        .await
        .expect("the proxy answers the timed-out request");

    assert_eq!(response.status().as_u16(), 504);
    assert_eq!(
        response
            .headers()
            .get("x-wisp-proxy-error")
            .and_then(|value| value.to_str().ok()),
        Some("upstream-timeout")
    );
    let _ = shutdown.send(());
}

#[tokio::test]
async fn server_sent_events_arrive_as_they_are_produced() {
    let (alpha, bravo) = two_daemons().await;
    let (harness, ids) = Harness::start(Some(&alpha), &[&bravo]).await;

    let started = Instant::now();
    let response = harness
        .client
        .get(harness.route(&ids[0], "api/events"))
        .send()
        .await
        .expect("stream opens");
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
        Some("text/event-stream")
    );

    let mut stream = response.bytes_stream();
    let first = stream
        .next()
        .await
        .expect("a first frame")
        .expect("frame bytes");
    let first_at = started.elapsed();
    let first_text = String::from_utf8_lossy(&first).to_string();

    // The daemon sleeps 250ms between frames. A proxy that buffered the
    // response to completion could not have produced frame 0 before then.
    assert!(
        first_at < Duration::from_millis(200),
        "first frame took {first_at:?} — the stream was buffered"
    );
    assert!(first_text.contains("\"daemon\":\"bravo\""));
    assert!(first_text.contains("\"n\":0"));

    let mut rest = String::new();
    while let Some(Ok(chunk)) = stream.next().await {
        rest.push_str(&String::from_utf8_lossy(&chunk));
    }
    assert!(rest.contains("\"n\":2"));
    assert!(started.elapsed() >= Duration::from_millis(450));
}

#[tokio::test]
async fn attachment_bytes_pass_through_verbatim_from_the_right_daemon() {
    let (alpha, bravo) = two_daemons().await;
    let (harness, ids) = Harness::start(Some(&alpha), &[&bravo]).await;

    for (connection, label) in [("local", "alpha"), (ids[0].as_str(), "bravo")] {
        let response = harness
            .client
            .get(harness.route(
                connection,
                &format!("api/tasks/{SHARED_TASK_ID}/attachments/shot.png"),
            ))
            .send()
            .await
            .expect("request");
        assert!(response.status().is_success());
        assert_eq!(
            response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok()),
            Some("image/png")
        );
        // No credential is in the URL and none comes back in a header.
        assert!(response.headers().get("set-cookie").is_none());
        let bytes = response.bytes().await.expect("bytes");
        assert_eq!(bytes.as_ref(), attachment_bytes(label).as_slice());
    }
}

/* ── terminal WebSocket ──────────────────────────────────────────────────── */

#[tokio::test]
async fn an_upstream_that_never_completes_a_websocket_handshake_times_out() {
    let (alpha, _bravo) = two_daemons().await;
    let (harness, _ids) = Harness::start(Some(&alpha), &[]).await;
    let (url, shutdown) = stalled_origin().await;
    let connection = harness
        .registry
        .add_remote(
            "Stalled WebSocket",
            &url,
            "synthetic-stalled-token",
            "00000000-0000-4000-8000-000000000043",
        )
        .expect("save stalled connection");
    let proxy = short_timeout_proxy(&harness).await;
    let route = format!(
        "{}/connections/{}/0/api/tasks/{SHARED_TASK_ID}/terminal?shell=1",
        proxy.base().replacen("http://", "ws://", 1),
        connection.id,
    );

    match tokio_tungstenite::connect_async(route).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            assert_eq!(response.status().as_u16(), 504);
            assert_eq!(
                response
                    .headers()
                    .get("x-wisp-proxy-error")
                    .and_then(|value| value.to_str().ok()),
                Some("upstream-timeout")
            );
        }
        Err(other) => panic!("expected the proxy timeout response, got {other}"),
        Ok(_) => panic!("a stalled upstream handshake must not open a terminal"),
    }
    let _ = shutdown.send(());
}

#[tokio::test]
async fn a_terminal_socket_carries_traffic_to_the_daemon_that_opened_it() {
    let (alpha, bravo) = two_daemons().await;
    let (harness, ids) = Harness::start(Some(&alpha), &[&bravo]).await;

    for (connection, label) in [("local", "alpha"), (ids[0].as_str(), "bravo")] {
        let url = harness.websocket_route(
            connection,
            &format!("api/tasks/{SHARED_TASK_ID}/terminal?shell=1"),
        );
        let (mut socket, _response) = tokio_tungstenite::connect_async(url)
            .await
            .expect("terminal upgrades");

        let hello = socket.next().await.expect("hello").expect("frame");
        assert_eq!(
            hello.into_text().expect("text").as_str(),
            format!("hello from {label}")
        );

        socket
            .send(tokio_tungstenite::tungstenite::Message::Text("ls\n".into()))
            .await
            .expect("send");
        let echo = socket.next().await.expect("echo").expect("frame");
        assert_eq!(
            echo.into_text().expect("text").as_str(),
            format!("{label}:ls\n")
        );

        socket
            .send(tokio_tungstenite::tungstenite::Message::Binary(
                bytes::Bytes::from_static(&[1, 2, 3, 4]),
            ))
            .await
            .expect("send binary");
        let binary = socket.next().await.expect("binary echo").expect("frame");
        assert_eq!(binary.into_data().as_ref(), &[1, 2, 3, 4]);

        socket.close(None).await.expect("close");
    }
}

#[tokio::test]
async fn local_terminal_reloads_a_token_rotated_after_the_identity_probe() {
    let local = MockDaemon::start("alpha", TOKEN_ONE, "wisp-instance-alpha").await;
    let (harness, _) = Harness::start(Some(&local), &[]).await;
    let rotated = "synthetic-terminal-token-rotated-7777";
    harness.set_local_profile_token(rotated);
    local.rotate_token_after_next_capabilities(rotated);

    let url = harness.websocket_route(
        "local",
        &format!("api/tasks/{SHARED_TASK_ID}/terminal?shell=1"),
    );
    let (mut socket, _) = tokio_tungstenite::connect_async(url)
        .await
        .expect("terminal retries with the rotated Local token");
    assert_eq!(
        socket
            .next()
            .await
            .expect("hello")
            .expect("frame")
            .into_text()
            .expect("text")
            .as_str(),
        "hello from alpha"
    );
    socket.close(None).await.expect("close");

    let attempts: Vec<_> = local
        .seen()
        .into_iter()
        .filter(|request| request.path.ends_with("/terminal"))
        .collect();
    assert_eq!(attempts.len(), 2, "the handshake retries exactly once");
    assert_eq!(
        attempts[0].authorization.as_deref(),
        Some(format!("Bearer {TOKEN_ONE}").as_str())
    );
    assert_eq!(
        attempts[1].authorization.as_deref(),
        Some(format!("Bearer {rotated}").as_str())
    );
}

#[tokio::test]
async fn local_terminal_forwards_the_second_credential_rejection() {
    let local = MockDaemon::start("alpha", TOKEN_ONE, "wisp-instance-alpha").await;
    let (harness, _) = Harness::start(Some(&local), &[]).await;
    local.rotate_token_after_next_capabilities("synthetic-daemon-terminal-token-8888");
    harness.set_local_profile_token("synthetic-still-wrong-terminal-token-9999");

    let url = harness.websocket_route(
        "local",
        &format!("api/tasks/{SHARED_TASK_ID}/terminal?shell=1"),
    );
    match tokio_tungstenite::connect_async(url).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
        }
        Err(other) => panic!("expected the daemon's second rejection, got {other}"),
        Ok(_) => panic!("a terminal with a rejected rotated token must not open"),
    }
    assert_eq!(
        local
            .seen_paths()
            .iter()
            .filter(|path| path.ends_with("/terminal"))
            .count(),
        2,
        "the handshake retry is bounded"
    );
}

#[tokio::test]
async fn a_remote_terminal_never_reloads_or_retries_its_saved_credential() {
    let (alpha, remote) = two_daemons().await;
    let (harness, ids) = Harness::start(Some(&alpha), &[&remote]).await;
    remote.rotate_token_after_next_capabilities("synthetic-new-remote-terminal-token");

    let url = harness.websocket_route(
        &ids[0],
        &format!("api/tasks/{SHARED_TASK_ID}/terminal?shell=1"),
    );
    match tokio_tungstenite::connect_async(url).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
        }
        Err(other) => panic!("expected the remote daemon's rejection, got {other}"),
        Ok(_) => panic!("a remote terminal with a stale saved token must not open"),
    }
    assert_eq!(
        remote
            .seen_paths()
            .iter()
            .filter(|path| path.ends_with("/terminal"))
            .count(),
        1,
        "remote credentials are never reread or retried"
    );
}

#[tokio::test]
async fn an_upstream_upgrade_refusal_is_forwarded_rather_than_laundered() {
    let alpha = MockDaemon::start("alpha", TOKEN_ONE, "wisp-instance-alpha").await;
    let mismatched =
        MockDaemon::start("bravo", "the-daemons-real-token", "wisp-instance-bravo").await;
    let (harness, _ids) = Harness::start(Some(&alpha), &[]).await;
    // Saved with a credential the daemon will reject.
    let info = harness
        .registry
        .add_remote(
            "Stale",
            &mismatched.url(),
            "a-token-this-daemon-does-not-accept",
            &mismatched.instance_id(),
        )
        .expect("saved");

    let url = harness.websocket_route(
        &info.id,
        &format!("api/tasks/{SHARED_TASK_ID}/terminal?shell=1"),
    );
    match tokio_tungstenite::connect_async(url).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            assert_eq!(response.status().as_u16(), 401);
        }
        Err(other) => panic!("expected the daemon's 401 to be forwarded, got {other}"),
        Ok(_) => panic!("an unauthenticated terminal upgrade must not succeed"),
    }
}

/* ── daemon identity ─────────────────────────────────────────────────────── */

#[tokio::test]
async fn a_write_is_refused_when_a_different_daemon_answers_the_saved_address() {
    let (alpha, bravo) = two_daemons().await;
    let (mut harness, ids) = Harness::start(Some(&alpha), &[&bravo]).await;
    let remote = ids[0].clone();

    // Quit, and come back to a different daemon behind the saved address.
    harness.relaunch().await;
    bravo.become_a_different_daemon("wisp-instance-somebody-else");

    let response = harness
        .client
        .post(harness.route(&remote, &format!("api/tasks/{SHARED_TASK_ID}/action")))
        .header("content-type", "application/json")
        .body("{}")
        .send()
        .await
        .expect("request");

    assert_eq!(response.status().as_u16(), 409);
    assert_eq!(
        response
            .headers()
            .get("x-wisp-proxy-error")
            .and_then(|v| v.to_str().ok()),
        Some("identity-changed")
    );
    assert!(
        !bravo
            .seen_paths()
            .iter()
            .any(|path| path.ends_with("/action")),
        "the write must not reach a daemon whose identity did not match"
    );

    // Once a mismatch is known, reads fail closed too: task or attachment data
    // from the replacement daemon must not render under the saved connection.
    let read = harness
        .client
        .get(harness.route(&remote, &format!("api/tasks/{SHARED_TASK_ID}")))
        .send()
        .await
        .expect("request");
    assert_eq!(read.status(), reqwest::StatusCode::CONFLICT);

    let terminal = harness.websocket_route(
        &remote,
        &format!("api/tasks/{SHARED_TASK_ID}/terminal?shell=1"),
    );
    match tokio_tungstenite::connect_async(terminal).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            assert_eq!(response.status().as_u16(), 409);
        }
        Err(other) => panic!("expected identity refusal, got {other}"),
        Ok(_) => panic!("a terminal must not open on a different daemon"),
    }
    assert_eq!(
        bravo
            .seen_paths()
            .iter()
            .filter(|path| path.ends_with("/terminal"))
            .count(),
        0,
        "the terminal upgrade must not reach a daemon whose identity changed"
    );
}

#[tokio::test]
async fn an_older_success_cannot_overwrite_a_newer_identity_mismatch() {
    let (alpha, bravo) = two_daemons().await;
    let (harness, ids) = Harness::start(Some(&alpha), &[&bravo]).await;
    let remote = ids[0].clone();
    let route = harness.route(&remote, &format!("api/tasks/{SHARED_TASK_ID}/action"));
    let saved_instance = bravo.instance_id();
    let (probe_started, release_probe) = bravo.hold_next_capabilities();

    let delayed_client = harness.client.clone();
    let delayed_route = route.clone();
    let delayed = tokio::spawn(async move {
        delayed_client
            .post(delayed_route)
            .header("content-type", "application/json")
            .body("{}")
            .send()
            .await
            .expect("delayed write")
    });
    tokio::time::timeout(Duration::from_secs(2), probe_started)
        .await
        .expect("first capability probe started")
        .expect("probe start signal");

    bravo.become_a_different_daemon("wisp-instance-newer-mismatch");
    let newer = harness
        .client
        .post(&route)
        .header("content-type", "application/json")
        .body("{}")
        .send()
        .await
        .expect("newer write");
    assert_eq!(newer.status(), reqwest::StatusCode::CONFLICT);

    release_probe.send(()).expect("release older probe");
    let older = delayed.await.expect("delayed task");
    assert_eq!(
        older.status(),
        reqwest::StatusCode::CONFLICT,
        "the late matching response must inherit the latched mismatch"
    );
    assert_eq!(
        bravo
            .seen_paths()
            .iter()
            .filter(|path| path.ends_with("/action"))
            .count(),
        0,
        "neither reordered write may reach the mutation endpoint"
    );

    // Even restoring the original answer cannot silently clear the latch;
    // only an explicit checked reconnect may do that.
    bravo.become_a_different_daemon(&saved_instance);
    let seen_before = bravo.seen().len();
    let read = harness
        .client
        .get(harness.route(&remote, &format!("api/tasks/{SHARED_TASK_ID}")))
        .send()
        .await
        .expect("read after mismatch");
    assert_eq!(read.status(), reqwest::StatusCode::CONFLICT);
    assert_eq!(bravo.seen().len(), seen_before, "the mismatch stays native");
}

#[tokio::test]
async fn an_old_local_probe_cannot_write_identity_into_a_new_generation() {
    let (alpha, bravo) = two_daemons().await;
    let (harness, _ids) = Harness::start(Some(&alpha), &[]).await;
    let action_path = format!("api/tasks/{SHARED_TASK_ID}/action");
    let old_route = harness.route_at("local", 0, &action_path);
    let (probe_started, release_probe) = alpha.hold_next_capabilities();

    let delayed_client = harness.client.clone();
    let delayed = tokio::spawn(async move {
        delayed_client
            .post(old_route)
            .header("content-type", "application/json")
            .body("{}")
            .send()
            .await
            .expect("old-generation write")
    });
    tokio::time::timeout(Duration::from_secs(2), probe_started)
        .await
        .expect("old capability probe started")
        .expect("probe start signal");

    harness
        .registry
        .refresh_local(LocalProfile::new(
            bravo.url(),
            TOKEN_TWO.to_string(),
            bravo.instance_id(),
            harness.wisp_home().join("config.json"),
        ))
        .expect("checked Local replacement");
    release_probe.send(()).expect("release old probe");

    let stale = delayed.await.expect("delayed task");
    assert_eq!(stale.status(), reqwest::StatusCode::CONFLICT);
    assert_eq!(
        stale
            .headers()
            .get("x-wisp-proxy-error")
            .and_then(|value| value.to_str().ok()),
        Some("stale-route")
    );
    assert_eq!(
        alpha
            .seen_paths()
            .iter()
            .filter(|path| path.ends_with("/action"))
            .count(),
        0,
        "the old request never mutates its former daemon"
    );

    let current_target = harness.registry.resolve("local").expect("current Local");
    assert_eq!(
        harness
            .registry
            .identity(&current_target)
            .expect("current identity"),
        Identity::Verified,
        "the stale completion did not alter the checked generation"
    );
    let current = harness
        .client
        .post(harness.route("local", &action_path))
        .header("content-type", "application/json")
        .body("{}")
        .send()
        .await
        .expect("current-generation write");
    assert!(current.status().is_success());
    assert_eq!(
        bravo
            .seen_paths()
            .iter()
            .filter(|path| path.ends_with("/action"))
            .count(),
        1
    );
}

#[tokio::test]
async fn every_write_refreshes_the_pinned_identity_before_proceeding() {
    let (alpha, bravo) = two_daemons().await;
    let (mut harness, ids) = Harness::start(Some(&alpha), &[&bravo]).await;
    let remote = ids[0].clone();
    harness.relaunch().await;

    let response = harness
        .client
        .post(harness.route(&remote, &format!("api/tasks/{SHARED_TASK_ID}/action")))
        .header("content-type", "application/json")
        .body("{}")
        .send()
        .await
        .expect("request");
    assert!(response.status().is_success());
    let body: serde_json::Value = response.json().await.expect("json");
    assert_eq!(body["daemon"], "bravo");

    let paths = bravo.seen_paths();
    assert!(paths.iter().any(|path| path == "/api/capabilities"));
    assert!(paths.iter().any(|path| path.ends_with("/action")));

    // A later write cannot inherit a launch-wide proof that may now be stale.
    harness
        .client
        .post(harness.route(&remote, &format!("api/tasks/{SHARED_TASK_ID}/action")))
        .header("content-type", "application/json")
        .body("{}")
        .send()
        .await
        .expect("request");
    let capability_checks = bravo
        .seen_paths()
        .iter()
        .filter(|path| path.as_str() == "/api/capabilities")
        .count();
    assert_eq!(capability_checks, 2);
}

#[tokio::test]
async fn a_later_write_refuses_an_endpoint_retargeted_after_a_successful_write() {
    let (alpha, bravo) = two_daemons().await;
    let (harness, ids) = Harness::start(Some(&alpha), &[&bravo]).await;
    let remote = ids[0].clone();
    let route = harness.route(&remote, &format!("api/tasks/{SHARED_TASK_ID}/action"));

    assert!(harness
        .client
        .post(&route)
        .header("content-type", "application/json")
        .body("{}")
        .send()
        .await
        .expect("first write")
        .status()
        .is_success());
    bravo.become_a_different_daemon("wisp-instance-retargeted");

    let response = harness
        .client
        .post(&route)
        .header("content-type", "application/json")
        .body("{}")
        .send()
        .await
        .expect("write after retarget");
    assert_eq!(response.status(), reqwest::StatusCode::CONFLICT);
    assert_eq!(
        bravo
            .seen_paths()
            .iter()
            .filter(|path| path.ends_with("/action"))
            .count(),
        1,
        "only the first write may reach the mutation endpoint"
    );
}

/* ── removal is revocation ───────────────────────────────────────────────── */

#[tokio::test]
async fn removing_a_connection_revokes_its_route_immediately() {
    let (alpha, bravo) = two_daemons().await;
    let (harness, ids) = Harness::start(Some(&alpha), &[&bravo]).await;
    let remote = ids[0].clone();

    assert!(harness
        .client
        .get(harness.route(&remote, "api/whoami"))
        .send()
        .await
        .expect("request")
        .status()
        .is_success());

    harness.registry.remove(&remote).expect("remove");
    let before = bravo.seen().len();

    let response = harness
        .client
        .get(harness.route(&remote, "api/whoami"))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 404);
    assert_eq!(
        bravo.seen().len(),
        before,
        "no request may reach a removed daemon"
    );
    assert!(harness.secrets.accounts().is_empty());

    // Its terminal socket is gone too.
    let url = harness.websocket_route(
        &remote,
        &format!("api/tasks/{SHARED_TASK_ID}/terminal?shell=1"),
    );
    assert!(tokio_tungstenite::connect_async(url).await.is_err());
}

/* ── no secret ever crosses back ─────────────────────────────────────────── */

#[tokio::test]
async fn no_proxy_response_and_no_metadata_carries_a_daemon_token() {
    let (alpha, bravo) = two_daemons().await;
    let (harness, ids) = Harness::start(Some(&alpha), &[&bravo]).await;

    let listed = serde_json::to_string(&harness.registry.list()).expect("serializes");
    assert!(!listed.contains(TOKEN_ONE));
    assert!(!listed.contains(TOKEN_TWO));

    let status = serde_json::to_string(&harness.registry.local_status()).expect("serializes");
    assert!(!status.contains(TOKEN_ONE));

    for connection in ["local", ids[0].as_str()] {
        for path in [
            "api/whoami",
            &format!("api/tasks/{SHARED_TASK_ID}"),
            "api/cookie",
        ] {
            let response = harness
                .client
                .get(harness.route(connection, path))
                .send()
                .await
                .expect("request");
            let headers = format!("{:?}", response.headers());
            let body = response.text().await.expect("body");
            // /api/whoami deliberately echoes what the daemon received, so the
            // native token IS expected there and nowhere else. Assert on the
            // capability and the *other* daemon's token instead.
            assert!(!headers.contains(&harness.capability));
            assert!(!body.contains(&harness.capability));
            if connection == "local" {
                assert!(!body.contains(TOKEN_TWO), "{path} leaked the other token");
            } else {
                assert!(!body.contains(TOKEN_ONE), "{path} leaked the other token");
            }
        }
    }

    // The capability is in the proxy base and nowhere else in what a command
    // would hand JavaScript.
    assert!(harness.base().contains(&harness.capability));
    assert!(!listed.contains(&harness.capability));
    assert!(!status.contains(&harness.capability));

    let _ = (alpha, bravo);
}
