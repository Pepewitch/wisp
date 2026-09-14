use super::header_policy::{bearer, REQUEST_HEADER_DENYLIST, RESPONSE_HEADER_DENYLIST};
use super::http_forward::{has_request_body, is_streaming_upload};
use super::is_write;
use super::route::ProxyRoute;
use super::websocket_forward::is_websocket_upgrade;
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
    let route = ProxyRoute::parse("/CAP/connections/local/4/api/tasks/t-1/attachments/a%20b.png")
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
fn only_raw_attachment_posts_bypass_the_replay_buffer() {
    assert!(is_streaming_upload("api/attachments", &Method::POST));
    assert!(!is_streaming_upload("api/attachments", &Method::GET));
    assert!(!is_streaming_upload("api/tasks", &Method::POST));
    assert!(!is_streaming_upload("api/attachments/other", &Method::POST));
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
    let value = bearer("synthetic-daemon-token");
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
    assert!(REQUEST_HEADER_DENYLIST.contains(&"authorization"));
    assert!(REQUEST_HEADER_DENYLIST.contains(&"cookie"));
    assert!(RESPONSE_HEADER_DENYLIST.contains(&"set-cookie"));
    assert!(RESPONSE_HEADER_DENYLIST.contains(&"location"));
    assert!(RESPONSE_HEADER_DENYLIST.contains(&"x-wisp-proxy-error"));
    assert!(RESPONSE_HEADER_DENYLIST.contains(&"x-wisp-proxy-redirect"));
}
