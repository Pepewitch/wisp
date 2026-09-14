//! Webview origin, CORS, and credential/header filtering policy.

use axum::response::{IntoResponse, Response};
use http::header::{
    ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
    ACCESS_CONTROL_EXPOSE_HEADERS, ACCESS_CONTROL_REQUEST_HEADERS, ACCESS_CONTROL_REQUEST_METHOD,
    AUTHORIZATION, ORIGIN, VARY,
};
use http::{HeaderMap, HeaderValue, StatusCode};
use url::Url;

use super::ProxyState;

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
pub(super) const REQUEST_HEADER_DENYLIST: &[&str] = &[
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
pub(super) const RESPONSE_HEADER_DENYLIST: &[&str] = &[
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
pub(super) const PROXY_ERROR_HEADER: &str = "x-wisp-proxy-error";
/// Set when a 3xx was relayed with its `Location` removed.
pub(super) const PROXY_REDIRECT_HEADER: &str = "x-wisp-proxy-redirect";

impl ProxyState {
    pub(super) fn cors_origin(&self, headers: &HeaderMap) -> Result<Option<HeaderValue>, ()> {
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

pub(super) fn refuse(
    status: StatusCode,
    code: &'static str,
    message: impl Into<String>,
) -> Response {
    let body = serde_json::json!({ "error": message.into() });
    let mut response = (status, axum::Json(body)).into_response();
    response
        .headers_mut()
        .insert(PROXY_ERROR_HEADER, HeaderValue::from_static(code));
    response
}

pub(super) fn with_cors(mut response: Response, origin: Option<&HeaderValue>) -> Response {
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

pub(super) fn preflight(headers: &HeaderMap, method: &http::Method) -> Option<Response> {
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

pub(super) fn bearer(credential: &str) -> HeaderValue {
    let mut value = HeaderValue::from_str(&format!("Bearer {credential}"))
        .unwrap_or_else(|_| HeaderValue::from_static("Bearer"));
    // Belt and braces: a credential is never a thing to print in a debug dump.
    value.set_sensitive(true);
    value
}

pub(super) fn upstream_request(
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
