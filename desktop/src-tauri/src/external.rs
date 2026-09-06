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
//! Revealing a local path is the one other thing here, and it is deliberately
//! *reveal* rather than open: `open -R` asks Finder to select a file, which
//! cannot run it. "Open with the default application" would be arbitrary
//! execution when the path came from agent output, so it is still absent.
//!
//! The path is not trusted and is not treated as if it were. What bounds the
//! action is what the action can do — selecting something in Finder — plus the
//! caller-side rule that only the Local connection may ask, because a remote
//! daemon's paths are not on this machine at all.

use std::path::Component;
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
    #[error("only an absolute path can be revealed")]
    NotAbsolute,
    #[error("could not reveal that file: {0}")]
    Reveal(#[source] std::io::Error),
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

/// Ask Finder to select `path`, without opening it.
///
/// Absolute only, and `..` is refused rather than normalized: a path that
/// needs resolving did not come from where it says it did, and the honest
/// answer is to decline instead of guessing which file was meant.
pub fn reveal(path: &str) -> Result<(), ExternalError> {
    let path = std::path::Path::new(path);
    if !path.is_absolute() || path.components().any(|c| c == Component::ParentDir) {
        return Err(ExternalError::NotAbsolute);
    }
    let child = Command::new(LAUNCHER)
        .arg("-R")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(ExternalError::Reveal)?;
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

    /// Revealing does not resolve anything. A relative path or a `..` is a
    /// declined request, not a path to work out.
    #[test]
    fn only_a_settled_absolute_path_is_revealable() {
        for path in [
            "relative/PLAN.md",
            "",
            "/task/../../etc/passwd",
            "/task/./../secret",
            "~/PLAN.md",
        ] {
            assert!(
                matches!(super::reveal(path), Err(ExternalError::NotAbsolute)),
                "{path} must not be revealable"
            );
        }
    }
}
