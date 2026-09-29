//! Where the shell's own webview may go.
//!
//! The window has no address bar, so a navigation away from the bundle is a
//! page the user cannot identify, sitting in a trusted frame, with no way
//! back. The webview's context menu offers exactly that for any link or
//! image: "Open Link" navigates the whole shell, and "Open Link in New
//! Window" asks for a second one.
//!
//! So the rule is small:
//!
//! * The bundle's own origin (and `about:blank`/`about:srcdoc`, which have no
//!   content or origin of their own) stays in the webview.
//! * The loopback proxy's origin never leaves the app and never renders in it:
//!   its URLs carry the per-launch capability, which must not reach a browser's
//!   history, and its bytes are daemon data, not documents.
//! * Any other `http`/`https` address goes to the machine's browser through
//!   the same launcher as `open_external_url`, and the navigation is cancelled.
//! * Everything else is cancelled.
//!
//! A new-window request follows the same rule, except that the app itself is
//! never opened a second time: a second shell would have no connection state.

use url::Url;

/// What to do with one navigation or new-window request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Navigation {
    /// Let the webview load it.
    Stay,
    /// Cancel it, and hand this exact (reparsed) URL to the system browser.
    OpenInBrowser(String),
    /// Cancel it.
    Refuse,
}

/// The navigation rule for one launch: the bundle's origins and the proxy's.
#[derive(Debug, Clone)]
pub struct NavigationPolicy {
    app_origins: Vec<Url>,
    proxy_origin: Url,
}

impl NavigationPolicy {
    /// `app_origins` are the documents the shell itself serves (the packaged
    /// origin, plus a configured `devUrl` under `tauri dev`); `proxy_base` is
    /// the per-launch loopback base the webview was handed.
    pub fn new(app_origins: Vec<Url>, proxy_base: &str) -> Result<Self, url::ParseError> {
        Ok(Self {
            app_origins,
            proxy_origin: Url::parse(proxy_base)?,
        })
    }

    /// Decide an in-place navigation of the shell's webview (or a frame in it).
    pub fn navigation(&self, url: &Url) -> Navigation {
        if self.is_app(url) || is_empty_document(url) {
            return Navigation::Stay;
        }
        if same_origin(&self.proxy_origin, url) {
            return Navigation::Refuse;
        }
        match crate::external::openable(url.as_str()) {
            Ok(href) => Navigation::OpenInBrowser(href),
            Err(_) => Navigation::Refuse,
        }
    }

    /// Decide a request for a new window (`window.open`, a middle click, or
    /// the context menu's "Open … in New Window").
    pub fn new_window(&self, url: &Url) -> Navigation {
        match self.navigation(url) {
            Navigation::Stay => Navigation::Refuse,
            decided => decided,
        }
    }

    fn is_app(&self, url: &Url) -> bool {
        self.app_origins.iter().any(|app| same_origin(app, url))
    }
}

/// `about:blank` and `about:srcdoc` carry no content of their own; a frame
/// that loads one inherits the document that created it.
fn is_empty_document(url: &Url) -> bool {
    url.scheme() == "about" && matches!(url.path(), "blank" | "srcdoc")
}

/// Scheme, host and port. `Url::origin` is opaque for a non-special scheme
/// such as `tauri:`, so two identical `tauri://localhost` origins would never
/// compare equal through it.
fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

#[cfg(test)]
mod tests {
    use super::{Navigation, NavigationPolicy};
    use url::Url;

    const PROXY_BASE: &str = "http://127.0.0.1:49152/0123456789abcdef";

    fn url(value: &str) -> Url {
        Url::parse(value).expect("test URL")
    }

    fn policy() -> NavigationPolicy {
        NavigationPolicy::new(vec![url("tauri://localhost")], PROXY_BASE).expect("policy")
    }

    #[test]
    fn the_bundle_stays_in_the_shell() {
        let policy = policy();
        for href in [
            "tauri://localhost",
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "tauri://localhost/#/gallery",
            "about:blank",
            "about:srcdoc",
        ] {
            assert_eq!(policy.navigation(&url(href)), Navigation::Stay, "{href}");
        }
    }

    /// "Open Link" on a link in agent prose must not replace the shell with a
    /// page the user cannot see the address of.
    #[test]
    fn a_web_address_opens_in_the_browser_instead_of_the_shell() {
        let policy = policy();
        assert_eq!(
            policy.navigation(&url("https://example.invalid/a b?c=d#e")),
            Navigation::OpenInBrowser("https://example.invalid/a%20b?c=d#e".to_string())
        );
        assert_eq!(
            policy.navigation(&url("http://127.0.0.1:8710/")),
            Navigation::OpenInBrowser("http://127.0.0.1:8710/".to_string())
        );
    }

    /// A proxy URL carries the per-launch capability. It is neither rendered
    /// as a document in the shell nor handed to a browser's history.
    #[test]
    fn proxy_urls_never_render_and_never_leave_the_app() {
        let policy = policy();
        for href in [
            "http://127.0.0.1:49152/0123456789abcdef/connections/local/0/api/tasks/t-1/attachments/a.html",
            "http://127.0.0.1:49152/",
        ] {
            assert_eq!(policy.navigation(&url(href)), Navigation::Refuse, "{href}");
            assert_eq!(policy.new_window(&url(href)), Navigation::Refuse, "{href}");
        }
    }

    #[test]
    fn other_schemes_and_look_alike_origins_are_refused() {
        let policy = policy();
        for href in [
            "file:///etc/hosts",
            "data:text/html,<p>x</p>",
            "blob:tauri://localhost/00000000-0000-4000-8000-000000000000",
            "javascript:alert(1)",
            "about:config",
            "tauri://evil.example/",
            "wisp://open",
        ] {
            assert_eq!(policy.navigation(&url(href)), Navigation::Refuse, "{href}");
        }
        // A look-alike web origin is just a web address: it leaves the app.
        assert!(matches!(
            policy.navigation(&url("http://tauri.localhost/")),
            Navigation::OpenInBrowser(_)
        ));
    }

    #[test]
    fn a_new_window_never_opens_the_app_a_second_time() {
        let policy = policy();
        assert_eq!(
            policy.new_window(&url("tauri://localhost/")),
            Navigation::Refuse
        );
        assert_eq!(policy.new_window(&url("about:blank")), Navigation::Refuse);
        assert_eq!(
            policy.new_window(&url("https://example.invalid/")),
            Navigation::OpenInBrowser("https://example.invalid/".to_string())
        );
    }

    /// `tauri dev` with a configured `devUrl` serves the bundle from there.
    #[test]
    fn a_dev_server_origin_is_the_app_only_when_configured() {
        let dev = NavigationPolicy::new(
            vec![url("tauri://localhost"), url("http://localhost:1420")],
            PROXY_BASE,
        )
        .expect("policy");
        assert_eq!(
            dev.navigation(&url("http://localhost:1420/#/gallery")),
            Navigation::Stay
        );
        assert!(matches!(
            policy().navigation(&url("http://localhost:1420/")),
            Navigation::OpenInBrowser(_)
        ));
    }
}
