//! Handing a link to the rest of the machine.
//!
//! The webview has no new-window handler, so `target="_blank"` does nothing in
//! the packaged app: the browser opens a tab, the shell swallows the click.
//! This is the native half of the fix, and it is narrow on purpose — the page
//! it serves renders agent output, so a link is attacker-influenced text.
//!
//! Two rules make it safe to expose:
//!
//! 1. Only `http` and `https` open. The frontend applies the same rule before
//!    it renders an anchor at all, so a `file:`, `javascript:` or custom-scheme
//!    href is never a link and never reaches here.
//! 2. What reaches `open(1)` is the **reparsed** URL, not the string the
//!    webview sent. A serialized `Url` always begins with its scheme, so no
//!    input can arrive at the launcher looking like an option.
//!
//! Opening a local path is deliberately absent. "Open with the default
//! application" is arbitrary execution when the path comes from agent output,
//! and a remote connection's paths do not exist on this machine at all.

use std::process::{Command, Stdio};

use url::Url;

/// macOS hands a URL to its registered application through this launcher. An
/// absolute path, not a PATH lookup: the app must not inherit a `PATH` a
/// user's shell profile could have pointed at something else.
const LAUNCHER: &str = "/usr/bin/open";

#[derive(Debug, thiserror::Error)]
pub enum ExternalError {
    #[error("that link is not a web address")]
    Malformed,
    #[error("only http and https links open outside the app")]
    UnsupportedScheme,
    #[error("could not hand the link to the system browser: {0}")]
    Launch(#[source] std::io::Error),
}

/// The exact string a launcher may receive for `href`, or an error naming why
/// it may not. Separated from the spawn so the policy is testable without
/// opening a browser on the developer's machine.
pub fn openable(href: &str) -> Result<String, ExternalError> {
    let url = Url::parse(href.trim()).map_err(|_| ExternalError::Malformed)?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(ExternalError::UnsupportedScheme);
    }
    Ok(url.to_string())
}

/// Open `href` in whatever the machine uses for web links.
///
/// Does not wait for the launcher: a click must not block on LaunchServices,
/// and the child is reaped on its own thread so a session of link clicks
/// cannot accumulate zombies.
pub fn open(href: &str) -> Result<(), ExternalError> {
    let url = openable(href)?;
    let child = Command::new(LAUNCHER)
        .arg(&url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(ExternalError::Launch)?;
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{openable, ExternalError};

    #[test]
    fn web_addresses_open() {
        assert_eq!(
            openable("https://example.invalid/a?b=c#d").unwrap(),
            "https://example.invalid/a?b=c#d"
        );
        assert_eq!(
            openable("  http://example.invalid/  ").unwrap(),
            "http://example.invalid/"
        );
    }

    /// The launcher would treat a leading `-` as an option, so the parse is the
    /// guard: nothing that is not an absolute http(s) URL gets that far.
    #[test]
    fn nothing_else_reaches_the_launcher() {
        for href in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "-h",
            "--version https://example.invalid",
            "wisp://open",
            "/Applications/Calculator.app",
            "",
        ] {
            assert!(
                matches!(
                    openable(href),
                    Err(ExternalError::Malformed | ExternalError::UnsupportedScheme)
                ),
                "{href} must not be openable"
            );
        }
    }

    /// Whatever opens is the reparsed URL, so a percent-encoding trick cannot
    /// survive review here and turn into something else at the launcher.
    #[test]
    fn what_opens_is_the_reparsed_url() {
        assert_eq!(
            openable("https://example.invalid/a b").unwrap(),
            "https://example.invalid/a%20b"
        );
    }
}
