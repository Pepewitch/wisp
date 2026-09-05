//! The built-in Local connection.
//!
//! Its credential is read from the standard Wisp profile (`$WISP_HOME` or
//! `~/.wisp`) straight into native process memory. It is never copied into the
//! Keychain — the daemon already owns that file at mode 0600 and a second copy
//! is a second thing to revoke — and it is never returned to JavaScript.

use std::path::{Path, PathBuf};

use serde::Serialize;
use url::Url;

use crate::urls::{normalize_daemon_url, UrlError};

/// Reserved, immutable ID of the built-in local connection.
pub const LOCAL_CONNECTION_ID: &str = "local";

/// Default label. Mutable like any other; the ID is what routes.
pub const LOCAL_CONNECTION_LABEL: &str = "Local";

#[derive(Debug, thiserror::Error)]
pub enum LocalError {
    #[error("no Wisp profile at {0} — run `wisp init` on this machine")]
    NoProfile(PathBuf),
    #[error("could not read {path}: {source}")]
    Unreadable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("{0} is not valid JSON")]
    Malformed(PathBuf),
    #[error("{path} has no {field}")]
    MissingField { path: PathBuf, field: &'static str },
    #[error("{path} names an address this app will not talk to: {source}")]
    BadAddress {
        path: PathBuf,
        #[source]
        source: UrlError,
    },
}

/// The local daemon's address and credential. Holds a secret; see the `Debug`
/// impl and the deliberate absence of `Serialize`.
#[derive(Clone)]
pub struct LocalProfile {
    base: Url,
    token: String,
    instance_id: String,
    config_path: PathBuf,
}

impl LocalProfile {
    /// Assemble a profile from already-validated parts.
    ///
    /// Used by [`load`] and by tests that need a local connection pointed at a
    /// synthetic daemon.
    pub fn new(base: Url, token: String, instance_id: String, config_path: PathBuf) -> Self {
        Self {
            base,
            token,
            instance_id,
            config_path,
        }
    }

    pub fn base(&self) -> &Url {
        &self.base
    }

    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    pub fn config_path(&self) -> &Path {
        &self.config_path
    }

    /// The daemon credential. Callers inject it into an upstream request and
    /// nothing else; there is no path from here to a command return value.
    pub fn token(&self) -> &str {
        &self.token
    }
}

impl std::fmt::Debug for LocalProfile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalProfile")
            .field("base", &self.base.as_str())
            .field("instance_id", &self.instance_id)
            .field("config_path", &self.config_path)
            .field("token", &"<redacted>")
            .finish()
    }
}

/// `$WISP_HOME`, else `~/.wisp` — the same resolution order `src/config.ts` uses.
pub fn wisp_home() -> PathBuf {
    resolve_wisp_home(
        std::env::var_os("WISP_HOME").map(PathBuf::from),
        std::env::var_os("HOME").map(PathBuf::from),
    )
}

/// The pure half of [`wisp_home`], so the precedence rule is testable without
/// mutating this process's environment.
fn resolve_wisp_home(explicit: Option<PathBuf>, home: Option<PathBuf>) -> PathBuf {
    match explicit {
        Some(path) if !path.as_os_str().is_empty() => path,
        _ => home.unwrap_or_else(|| PathBuf::from("/")).join(".wisp"),
    }
}

/// Read `config.json` out of a Wisp home.
pub fn load(home: &Path) -> Result<LocalProfile, LocalError> {
    let config_path = home.join("config.json");
    if !config_path.exists() {
        return Err(LocalError::NoProfile(config_path));
    }
    let raw = std::fs::read_to_string(&config_path).map_err(|source| LocalError::Unreadable {
        path: config_path.clone(),
        source,
    })?;
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| LocalError::Malformed(config_path.clone()))?;

    let field = |name: &'static str| -> Result<String, LocalError> {
        parsed
            .get(name)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or(LocalError::MissingField {
                path: config_path.clone(),
                field: name,
            })
    };

    let token = field("token")?;
    let instance_id = field("instanceId")?;
    let port = parsed
        .get("port")
        .and_then(serde_json::Value::as_u64)
        .ok_or(LocalError::MissingField {
            path: config_path.clone(),
            field: "port",
        })?;
    // The daemon binds a loopback host by default. Anything else in the profile
    // is still checked by the same rule every remote target passes.
    let host = parsed
        .get("host")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("127.0.0.1");
    let authority = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    let base = normalize_daemon_url(&format!("http://{authority}:{port}")).map_err(|source| {
        LocalError::BadAddress {
            path: config_path.clone(),
            source,
        }
    })?;

    Ok(LocalProfile::new(base, token, instance_id, config_path))
}

/// Everything about the local profile that is safe to hand to the webview.
///
/// Note what is absent: the token, and any derivative of it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    pub available: bool,
    pub config_path: String,
    pub base_url: Option<String>,
    pub instance_id: Option<String>,
    /// Whether a credential was found — never the credential.
    pub has_token: bool,
    /// A sentence to show when `available` is false.
    pub reason: Option<String>,
}

impl LocalStatus {
    pub fn from_result(home: &Path, result: &Result<LocalProfile, LocalError>) -> Self {
        match result {
            Ok(profile) => Self {
                available: true,
                config_path: profile.config_path().display().to_string(),
                base_url: Some(profile.base().to_string()),
                instance_id: Some(profile.instance_id().to_string()),
                has_token: true,
                reason: None,
            },
            Err(error) => Self {
                available: false,
                config_path: home.join("config.json").display().to_string(),
                base_url: None,
                instance_id: None,
                has_token: false,
                reason: Some(error.to_string()),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{load, resolve_wisp_home, LocalError, LocalProfile, LocalStatus};
    use std::path::PathBuf;
    use url::Url;

    fn write_profile(home: &std::path::Path, body: &str) {
        std::fs::create_dir_all(home).expect("home");
        std::fs::write(home.join("config.json"), body).expect("config.json");
    }

    #[test]
    fn reads_address_and_credential_from_the_standard_profile() {
        let home = tempfile::tempdir().expect("tempdir");
        write_profile(
            home.path(),
            r#"{"instanceId":"wisp-instance-aaaa","port":18710,"host":"127.0.0.1","token":"synthetic-local-token"}"#,
        );
        let profile = load(home.path()).expect("profile loads");
        assert_eq!(profile.base().host_str(), Some("127.0.0.1"));
        assert_eq!(profile.base().port(), Some(18710));
        assert_eq!(profile.base().scheme(), "http");
        assert_eq!(profile.instance_id(), "wisp-instance-aaaa");
        assert_eq!(profile.token(), "synthetic-local-token");
    }

    #[test]
    fn a_missing_or_incomplete_profile_is_a_named_refusal() {
        let home = tempfile::tempdir().expect("tempdir");
        assert!(matches!(load(home.path()), Err(LocalError::NoProfile(_))));
        write_profile(home.path(), "not json");
        assert!(matches!(load(home.path()), Err(LocalError::Malformed(_))));
        write_profile(home.path(), r#"{"port":18710,"instanceId":"i"}"#);
        assert!(matches!(
            load(home.path()),
            Err(LocalError::MissingField { field: "token", .. })
        ));
    }

    #[test]
    fn status_never_carries_the_token() {
        let home = tempfile::tempdir().expect("tempdir");
        write_profile(
            home.path(),
            r#"{"instanceId":"wisp-instance-aaaa","port":18710,"token":"synthetic-local-token"}"#,
        );
        let result = load(home.path());
        let status = LocalStatus::from_result(home.path(), &result);
        let json = serde_json::to_string(&status).expect("serializes");
        assert!(status.available);
        assert!(status.has_token);
        assert!(!json.contains("synthetic-local-token"));
        assert!(!json.to_lowercase().contains("\"token\""));
    }

    #[test]
    fn debug_never_prints_the_token() {
        let profile = LocalProfile::new(
            Url::parse("http://127.0.0.1:18710").expect("url"),
            "synthetic-local-token".into(),
            "wisp-instance-aaaa".into(),
            PathBuf::from("/tmp/synthetic/config.json"),
        );
        let rendered = format!("{profile:?}");
        assert!(rendered.contains("<redacted>"));
        assert!(!rendered.contains("synthetic-local-token"));
    }

    #[test]
    fn wisp_home_prefers_the_explicit_override_then_the_home_default() {
        assert_eq!(
            resolve_wisp_home(
                Some("/synthetic/explicit".into()),
                Some("/synthetic/home".into())
            ),
            PathBuf::from("/synthetic/explicit")
        );
        assert_eq!(
            resolve_wisp_home(Some(PathBuf::new()), Some("/synthetic/home".into())),
            PathBuf::from("/synthetic/home/.wisp")
        );
        assert_eq!(
            resolve_wisp_home(None, Some("/synthetic/home".into())),
            PathBuf::from("/synthetic/home/.wisp")
        );
    }
}
