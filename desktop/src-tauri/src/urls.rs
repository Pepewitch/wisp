//! Where a daemon may live, and how a client path is appended to it.
//!
//! Two separate jobs, both of which are attack surface:
//!
//! 1. `normalize_daemon_url` decides whether a URL the *user* typed is an
//!    acceptable target at all. HTTPS everywhere, with one carve-out for the
//!    literal loopback addresses a user-managed tunnel terminates on.
//! 2. `join_upstream` appends the *frontend's* path to an already-approved
//!    base. The frontend never supplies a target, only a suffix, and this
//!    function is what keeps that true.

use percent_encoding::percent_decode_str;
use url::{Host, Url};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum UrlError {
    #[error("enter a full URL, for example https://wisp.example.com")]
    NotAbsolute,
    #[error("only https:// is allowed (http:// only for 127.0.0.1 or [::1])")]
    UnsupportedScheme,
    #[error(
        "plain http:// is allowed only for the literal loopback addresses 127.0.0.1 and [::1]"
    )]
    InsecureHost,
    #[error("the URL must not contain a username or password")]
    CredentialsInUrl,
    #[error("the URL must not contain a query string or fragment")]
    QueryOrFragment,
    #[error("the URL is missing a host")]
    EmptyHost,
    #[error("the path may not contain '.' or '..' segments")]
    RelativeSegment,
    #[error("the path contains invalid percent-encoded text")]
    InvalidEncoding,
}

/// Exactly the two literal loopback addresses. `localhost` deliberately does
/// not qualify: it is a name, and a name resolves through whatever the machine
/// has been told to believe, which is not a property we can pin a plaintext
/// bearer token to.
pub fn is_literal_loopback(host: &Host<&str>) -> bool {
    match host {
        Host::Ipv4(addr) => addr.octets() == [127, 0, 0, 1],
        Host::Ipv6(addr) => addr.is_loopback(),
        Host::Domain(_) => false,
    }
}

/// Validate a user-entered daemon URL and reduce it to a stable base.
///
/// The result keeps any path prefix (a daemon behind `https://host/wisp` is a
/// normal reverse-proxy deployment) but never a trailing slash, query, or
/// fragment, so `join_upstream` has exactly one shape to reason about.
pub fn normalize_daemon_url(raw: &str) -> Result<Url, UrlError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(UrlError::NotAbsolute);
    }
    let mut url = Url::parse(trimmed).map_err(|_| UrlError::NotAbsolute)?;

    match url.scheme() {
        "https" => {}
        "http" => {
            let host = url.host().ok_or(UrlError::EmptyHost)?;
            if !is_literal_loopback(&host) {
                return Err(UrlError::InsecureHost);
            }
        }
        _ => return Err(UrlError::UnsupportedScheme),
    }

    if url.host_str().is_none_or(str::is_empty) {
        return Err(UrlError::EmptyHost);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(UrlError::CredentialsInUrl);
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(UrlError::QueryOrFragment);
    }
    if url
        .path_segments()
        .into_iter()
        .flatten()
        .any(|segment| segment == "." || segment == "..")
    {
        return Err(UrlError::RelativeSegment);
    }

    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(&path);
    Ok(url)
}

/// Append a frontend-supplied daemon path to an approved base.
///
/// `rest` arrives still percent-encoded, straight off the request line, because
/// attachment filenames survive only if nothing decodes and re-encodes them on
/// the way through. It is treated as opaque except for the traversal check: a
/// `..` segment is the one way a suffix could reach outside the daemon path
/// prefix the user approved.
pub fn join_upstream(base: &Url, rest: &str, query: Option<&str>) -> Result<Url, UrlError> {
    reject_relative_segments(rest)?;
    let mut url = base.clone();
    let base_path = base.path().trim_end_matches('/');
    url.set_path(&format!("{base_path}/{}", rest.trim_start_matches('/')));
    url.set_query(query);
    Ok(url)
}

/// URL parsers recognize percent-encoded dot segments during normalization.
/// Check the decoded spelling before calling `Url::set_path`, including an
/// encoded slash that reveals a segment boundary. Decode until stable so no
/// number of nested `%25` spellings can become traversal in a later hop. Each
/// successful pass shortens the string, so the loop is intrinsically bounded.
fn reject_relative_segments(rest: &str) -> Result<(), UrlError> {
    let mut decoded = rest.to_string();
    loop {
        if decoded
            .split(['/', '\\'])
            .any(|segment| segment == "." || segment == "..")
        {
            return Err(UrlError::RelativeSegment);
        }
        let next = percent_decode_str(&decoded)
            .decode_utf8()
            .map_err(|_| UrlError::InvalidEncoding)?
            .into_owned();
        if next == decoded {
            return Ok(());
        }
        decoded = next;
    }
}

/// The `wss://`/`ws://` twin of an already-approved `https://`/`http://` URL.
pub fn to_websocket_url(url: &Url) -> Url {
    let mut socket = url.clone();
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    socket
        .set_scheme(scheme)
        .expect("http(s) -> ws(s) is a permitted scheme change");
    socket
}

#[cfg(test)]
mod tests {
    use super::{join_upstream, normalize_daemon_url, to_websocket_url, UrlError};

    #[test]
    fn https_is_accepted_and_normalized() {
        let url = normalize_daemon_url("  https://wisp.example.com/  ").expect("https is allowed");
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("wisp.example.com"));
        assert!(url.path().is_empty() || url.path() == "/");
        let prefixed = normalize_daemon_url("https://wisp.example.com/wisp/").expect("prefix ok");
        assert_eq!(prefixed.path(), "/wisp");
        // Whatever the crate does with an empty path, joining is unaffected.
        assert_eq!(
            join_upstream(&url, "api/health", None)
                .expect("joined")
                .as_str(),
            "https://wisp.example.com/api/health"
        );
    }

    #[test]
    fn plain_http_is_only_for_literal_loopback() {
        assert!(normalize_daemon_url("http://127.0.0.1:8710").is_ok());
        assert!(normalize_daemon_url("http://[::1]:8710").is_ok());
        // A name is not an address: `localhost` resolves through host state.
        assert_eq!(
            normalize_daemon_url("http://localhost:8710"),
            Err(UrlError::InsecureHost)
        );
        assert_eq!(
            normalize_daemon_url("http://127.0.0.2:8710"),
            Err(UrlError::InsecureHost)
        );
        assert_eq!(
            normalize_daemon_url("http://wisp.example.com"),
            Err(UrlError::InsecureHost)
        );
    }

    #[test]
    fn other_schemes_are_refused() {
        for raw in [
            "ws://127.0.0.1:8710",
            "wss://wisp.example.com",
            "file:///etc/passwd",
            "data:text/plain,hi",
            "javascript:alert(1)",
        ] {
            assert!(
                matches!(
                    normalize_daemon_url(raw),
                    Err(UrlError::UnsupportedScheme) | Err(UrlError::NotAbsolute)
                ),
                "{raw} must not be accepted"
            );
        }
    }

    #[test]
    fn junk_and_relative_input_is_refused() {
        assert_eq!(normalize_daemon_url(""), Err(UrlError::NotAbsolute));
        assert_eq!(
            normalize_daemon_url("wisp.example.com"),
            Err(UrlError::NotAbsolute)
        );
        assert_eq!(
            normalize_daemon_url("/api/tasks"),
            Err(UrlError::NotAbsolute)
        );
    }

    #[test]
    fn embedded_credentials_query_and_traversal_are_refused() {
        assert_eq!(
            normalize_daemon_url("https://user:secret@wisp.example.com"),
            Err(UrlError::CredentialsInUrl)
        );
        assert_eq!(
            normalize_daemon_url("https://wisp.example.com?token=abc"),
            Err(UrlError::QueryOrFragment)
        );
        assert_eq!(
            normalize_daemon_url("https://wisp.example.com#frag"),
            Err(UrlError::QueryOrFragment)
        );
        // Dot segments never survive into a stored base: WHATWG parsing
        // resolves them, so the saved prefix is always the literal one.
        let collapsed = normalize_daemon_url("https://wisp.example.com/a/../b").expect("parses");
        assert_eq!(collapsed.path(), "/b");
    }

    #[test]
    fn joining_keeps_the_prefix_the_user_approved() {
        let base = normalize_daemon_url("https://wisp.example.com/wisp").expect("valid base");
        let joined = join_upstream(&base, "api/tasks", Some("archived=1")).expect("joined");
        assert_eq!(
            joined.as_str(),
            "https://wisp.example.com/wisp/api/tasks?archived=1"
        );
    }

    #[test]
    fn joining_preserves_percent_encoding_verbatim() {
        let base = normalize_daemon_url("https://wisp.example.com").expect("valid base");
        let joined = join_upstream(
            &base,
            "api/tasks/t-000000000001/attachments/turn-1/a%20b%2Bc.png",
            None,
        )
        .expect("joined");
        assert!(joined.as_str().ends_with("/a%20b%2Bc.png"));
    }

    #[test]
    fn joining_refuses_traversal_out_of_the_prefix() {
        let base = normalize_daemon_url("https://wisp.example.com/wisp").expect("valid base");
        assert_eq!(
            join_upstream(&base, "api/../../admin", None),
            Err(UrlError::RelativeSegment)
        );
        assert_eq!(
            join_upstream(&base, "..", None),
            Err(UrlError::RelativeSegment)
        );
        for encoded in [
            "api/%2e%2e/admin",
            "api/.%2E/admin",
            "api/%2e%2e%2fadmin",
            "api/%252e%252e/admin",
            "api/%252525252e%252525252e/admin",
        ] {
            assert_eq!(
                join_upstream(&base, encoded, None),
                Err(UrlError::RelativeSegment),
                "{encoded} must not escape the saved /wisp prefix"
            );
        }
        assert_eq!(
            join_upstream(&base, "api/tasks", None)
                .expect("ordinary path")
                .path(),
            "/wisp/api/tasks"
        );
    }

    #[test]
    fn joining_cannot_be_talked_into_a_different_host() {
        let base = normalize_daemon_url("https://wisp.example.com").expect("valid base");
        // A suffix that looks like an absolute URL stays a path segment.
        let joined = join_upstream(&base, "https://evil.example.com/api/tasks", None)
            .expect("still a suffix");
        assert_eq!(joined.host_str(), Some("wisp.example.com"));
        let protocol_relative =
            join_upstream(&base, "/evil.example.com/api", None).expect("still a suffix");
        assert_eq!(protocol_relative.host_str(), Some("wisp.example.com"));
    }

    #[test]
    fn websocket_urls_track_the_transport_security_of_their_base() {
        let secure = normalize_daemon_url("https://wisp.example.com").expect("valid");
        assert_eq!(to_websocket_url(&secure).scheme(), "wss");
        let loopback = normalize_daemon_url("http://127.0.0.1:8710").expect("valid");
        assert_eq!(to_websocket_url(&loopback).scheme(), "ws");
    }
}
