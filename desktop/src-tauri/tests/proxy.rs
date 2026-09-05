//! Acceptance tests for the native loopback proxy.
//!
//! Structured around the rules in `docs/DESKTOP-TRANSPORT.md` §"Credential and
//! proxy rules". Two synthetic daemons are seeded with the *same* task ID
//! throughout, so a routing mistake surfaces as the wrong daemon's content
//! rather than as a 404 nobody would notice.

mod support;

use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use support::{attachment_bytes, Harness, MockDaemon, Tripwire, SHARED_TASK_ID};
use wisp_desktop::secrets::SecretStore;

const TOKEN_ONE: &str = "synthetic-token-alpha-0000000000";
const TOKEN_TWO: &str = "synthetic-token-bravo-1111111111";

async fn two_daemons() -> (MockDaemon, MockDaemon) {
    (
        MockDaemon::start("alpha", TOKEN_ONE, "wisp-instance-alpha").await,
        MockDaemon::start("bravo", TOKEN_TWO, "wisp-instance-bravo").await,
    )
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
        "ws://127.0.0.1:{}/{forged}/connections/local/api/tasks/{SHARED_TASK_ID}/terminal",
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

    // Reads still work: the user has to be able to see the state they are in.
    let read = harness
        .client
        .get(harness.route(&remote, &format!("api/tasks/{SHARED_TASK_ID}")))
        .send()
        .await
        .expect("request");
    assert!(read.status().is_success());
}

#[tokio::test]
async fn a_write_proceeds_once_the_pinned_identity_is_confirmed() {
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

    // The check is once per launch, not once per write.
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
    assert_eq!(capability_checks, 1);
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
