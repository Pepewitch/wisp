//! Signed application updates for the native Desktop shell.
//!
//! The webview receives status and can confirm a version. It cannot choose an
//! endpoint, artifact, signature, public key, or installation path. Discovery
//! is fetched once through this module's bounded client, then fetched by the
//! official Tauri updater and required to match before its signed installer is
//! retained. This keeps Tauri's audited signature/install path while applying
//! Wisp's stricter channel policy ahead of it.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Wry};
use tauri_plugin_updater::{Update, UpdaterExt};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use url::Url;

const CHANNEL: &str = "alpha";
const CHANNEL_ENDPOINT: &str =
    "https://raw.githubusercontent.com/Pepewitch/homebrew-tap/main/updates/wisp-desktop-alpha.json";
const PUBLIC_KEY: &str = include_str!("../updater-public.key");
const PLATFORM: &str = "darwin-aarch64-app";
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CHANNEL_BYTES: usize = 64 * 1024;
const MAX_NOTES_BYTES: usize = 16 * 1024;
const MAX_SIGNATURE_BYTES: usize = 4 * 1024;
const MAX_ARTIFACT_BYTES: u64 = 256 * 1024 * 1024;
const FUTURE_PUBLICATION_TOLERANCE: time::Duration = time::Duration::minutes(10);
pub const STATUS_EVENT: &str = "desktop-update-status";
pub const HOMEBREW_REPAIR: &str = "brew reinstall --cask Pepewitch/tap/wisp-desktop";

fn embedded_public_key() -> Option<&'static str> {
    configured_public_key(PUBLIC_KEY)
}

fn configured_public_key(value: &str) -> Option<&str> {
    let key = value.trim();
    (key != "UNCONFIGURED" && !key.is_empty()).then_some(key)
}

pub fn plugin() -> tauri::plugin::TauriPlugin<Wry, tauri_plugin_updater::Config> {
    tauri_plugin_updater::Builder::new()
        .pubkey(embedded_public_key().unwrap_or("UNCONFIGURED"))
        .build()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopUpdatePhase {
    Unconfigured,
    Idle,
    Checking,
    UpToDate,
    Available,
    Downloading,
    Installing,
    ReadyToRelaunch,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateStatus {
    pub channel: &'static str,
    pub configured: bool,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub phase: DesktopUpdatePhase,
    pub release_notes: Option<String>,
    pub published_at: Option<String>,
    pub checked_at: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub message: Option<String>,
}

impl DesktopUpdateStatus {
    fn initial() -> Self {
        let configured = embedded_public_key().is_some();
        Self {
            channel: CHANNEL,
            configured,
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            latest_version: None,
            phase: if configured {
                DesktopUpdatePhase::Idle
            } else {
                DesktopUpdatePhase::Unconfigured
            },
            release_notes: None,
            published_at: None,
            checked_at: None,
            downloaded_bytes: 0,
            total_bytes: None,
            message: (!configured).then(|| {
                "Application updates are unavailable in this build; reinstall with Homebrew when a signed release is published."
                    .to_string()
            }),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum DesktopUpdateError {
    #[error("another Desktop update operation is still running")]
    Busy,
    #[error("this Desktop build has no updater signing key; use `{HOMEBREW_REPAIR}` after a signed release is published")]
    Unconfigured,
    #[error("the Desktop update channel is invalid: {0}")]
    InvalidChannel(&'static str),
    #[error("could not check the Desktop update channel: {0}")]
    Discovery(&'static str),
    #[error("the Desktop update changed after confirmation; check again")]
    StaleConfirmation,
    #[error(
        "the Desktop application cannot update from this location: {0}; run `{HOMEBREW_REPAIR}`"
    )]
    UnsupportedLocation(&'static str),
    #[error("the signed Desktop update failed: {0}")]
    Updater(String),
    #[error("Desktop is not ready to relaunch for an installed update")]
    NotReadyToRelaunch,
}

impl Serialize for DesktopUpdateError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChannelManifest {
    schema_version: u32,
    channel: String,
    version: String,
    published_at: String,
    #[serde(rename = "pub_date")]
    pub_date: String,
    notes: Option<String>,
    artifact_size: u64,
    platforms: BTreeMap<String, ChannelPlatform>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ChannelPlatform {
    url: Url,
    signature: String,
}

struct Candidate {
    version: Version,
    version_text: String,
    published_at: String,
    notes: Option<String>,
    artifact_size: u64,
    url: Url,
    signature: String,
}

struct UpdaterInner {
    status: DesktopUpdateStatus,
    pending: Option<Update>,
}

pub struct DesktopUpdater {
    inner: Arc<Mutex<UpdaterInner>>,
    operation: tokio::sync::Mutex<()>,
}

impl Default for DesktopUpdater {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(UpdaterInner {
                status: DesktopUpdateStatus::initial(),
                pending: None,
            })),
            operation: tokio::sync::Mutex::new(()),
        }
    }
}

impl DesktopUpdater {
    pub fn status(&self) -> DesktopUpdateStatus {
        self.inner
            .lock()
            .expect("updater state mutex")
            .status
            .clone()
    }

    pub async fn check(
        &self,
        app: &AppHandle<Wry>,
    ) -> Result<DesktopUpdateStatus, DesktopUpdateError> {
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| DesktopUpdateError::Busy)?;
        let status = self.status();
        if check_preserves_status(status.phase) {
            return Ok(status);
        }
        let key = embedded_public_key().ok_or(DesktopUpdateError::Unconfigured)?;
        self.change(app, |inner| {
            inner.pending = None;
            inner.status.phase = DesktopUpdatePhase::Checking;
            inner.status.latest_version = None;
            inner.status.release_notes = None;
            inner.status.published_at = None;
            inner.status.downloaded_bytes = 0;
            inner.status.total_bytes = None;
            inner.status.message = None;
        });

        let result = self.check_inner(app, key).await;
        match result {
            Ok((None, checked_at)) => Ok(self.change(app, |inner| {
                inner.status.phase = DesktopUpdatePhase::UpToDate;
                inner.status.checked_at = Some(checked_at);
                inner.status.message = None;
            })),
            Ok((Some((update, candidate)), checked_at)) => Ok(self.change(app, |inner| {
                inner.status.phase = DesktopUpdatePhase::Available;
                inner.status.latest_version = Some(candidate.version_text);
                inner.status.release_notes = candidate.notes;
                inner.status.published_at = Some(candidate.published_at);
                inner.status.checked_at = Some(checked_at);
                inner.status.total_bytes = Some(candidate.artifact_size);
                inner.status.message = None;
                inner.pending = Some(update);
            })),
            Err(error) => {
                self.fail(app, &error);
                Err(error)
            }
        }
    }

    async fn check_inner(
        &self,
        app: &AppHandle<Wry>,
        key: &str,
    ) -> Result<(Option<(Update, Candidate)>, String), DesktopUpdateError> {
        let endpoint = Url::parse(CHANNEL_ENDPOINT).map_err(|_| {
            DesktopUpdateError::InvalidChannel("the embedded endpoint is not a URL")
        })?;
        let raw = fetch_channel(&endpoint).await?;
        let candidate = validate_manifest(&raw, OffsetDateTime::now_utc())?;
        let current = Version::parse(&self.status().current_version)
            .map_err(|_| DesktopUpdateError::InvalidChannel("the installed version is invalid"))?;

        let updater = app
            .updater_builder()
            .endpoints(vec![endpoint])
            .map_err(updater_error)?
            .pubkey(key)
            .target(PLATFORM)
            .timeout(CHECK_TIMEOUT)
            .configure_client(|builder| {
                builder.redirect(reqwest_updater::redirect::Policy::custom(|attempt| {
                    if attempt.previous().len() >= 5 || !allowed_network_url(attempt.url()) {
                        attempt.stop()
                    } else {
                        attempt.follow()
                    }
                }))
            })
            .build()
            .map_err(updater_error)?;
        let discovered = updater.check().await.map_err(updater_error)?;
        let checked_at = now_text()?;

        if candidate.version <= current {
            if discovered.is_some() {
                return Err(DesktopUpdateError::InvalidChannel(
                    "the updater offered a non-newer release",
                ));
            }
            return Ok((None, checked_at));
        }

        let update = discovered.ok_or(DesktopUpdateError::InvalidChannel(
            "the updater did not return the newer channel release",
        ))?;
        if update.raw_json != raw
            || update.version != candidate.version_text
            || update.download_url != candidate.url
            || update.signature != candidate.signature
        {
            return Err(DesktopUpdateError::InvalidChannel(
                "discovery changed between the bounded check and signed updater",
            ));
        }
        Ok((Some((update, candidate)), checked_at))
    }

    pub async fn download_and_install(
        &self,
        app: &AppHandle<Wry>,
        confirmed_version: &str,
    ) -> Result<DesktopUpdateStatus, DesktopUpdateError> {
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| DesktopUpdateError::Busy)?;
        embedded_public_key().ok_or(DesktopUpdateError::Unconfigured)?;
        let executable = std::env::current_exe().map_err(|_| {
            DesktopUpdateError::UnsupportedLocation("the executable path is unavailable")
        })?;
        let app_path =
            tauri_plugin_updater::extract_path_from_executable(&executable).map_err(|_| {
                DesktopUpdateError::UnsupportedLocation("the application bundle was not found")
            })?;
        preflight_install_location(&app_path)?;

        let update = {
            let inner = self.inner.lock().expect("updater state mutex");
            if !matches!(
                inner.status.phase,
                DesktopUpdatePhase::Available | DesktopUpdatePhase::Failed
            ) || inner.status.latest_version.as_deref() != Some(confirmed_version)
            {
                return Err(DesktopUpdateError::StaleConfirmation);
            }
            inner
                .pending
                .clone()
                .ok_or(DesktopUpdateError::StaleConfirmation)?
        };

        self.change(app, |inner| {
            inner.status.phase = DesktopUpdatePhase::Downloading;
            inner.status.downloaded_bytes = 0;
            inner.status.message = None;
        });
        let progress_inner = Arc::clone(&self.inner);
        let progress_app = app.clone();
        let install_inner = Arc::clone(&self.inner);
        let install_app = app.clone();
        let result = update
            .download_and_install(
                move |chunk, reported_total| {
                    let mut inner = progress_inner.lock().expect("updater state mutex");
                    inner.status.downloaded_bytes = inner
                        .status
                        .downloaded_bytes
                        .saturating_add(chunk as u64)
                        .min(MAX_ARTIFACT_BYTES);
                    if let Some(total) = reported_total.filter(|value| *value <= MAX_ARTIFACT_BYTES)
                    {
                        inner.status.total_bytes = Some(total);
                    }
                    let _ = progress_app.emit(STATUS_EVENT, inner.status.clone());
                },
                move || {
                    let mut inner = install_inner.lock().expect("updater state mutex");
                    inner.status.phase = DesktopUpdatePhase::Installing;
                    let _ = install_app.emit(STATUS_EVENT, inner.status.clone());
                },
            )
            .await
            .map_err(updater_error);

        match result {
            Ok(()) => Ok(self.change(app, |inner| {
                inner.status.phase = DesktopUpdatePhase::ReadyToRelaunch;
                inner.status.message = Some(
                    "The signed update is installed. Relaunch Wisp Desktop to use it.".to_string(),
                );
                inner.pending = None;
            })),
            Err(error) => {
                self.fail(app, &error);
                Err(error)
            }
        }
    }

    pub fn relaunch(&self, app: &AppHandle<Wry>) -> Result<(), DesktopUpdateError> {
        if self.status().phase != DesktopUpdatePhase::ReadyToRelaunch {
            return Err(DesktopUpdateError::NotReadyToRelaunch);
        }
        app.restart()
    }

    fn fail(&self, app: &AppHandle<Wry>, error: &DesktopUpdateError) {
        self.change(app, |inner| {
            inner.status.phase = DesktopUpdatePhase::Failed;
            inner.status.message = Some(error.to_string());
        });
    }

    fn change(
        &self,
        app: &AppHandle<Wry>,
        update: impl FnOnce(&mut UpdaterInner),
    ) -> DesktopUpdateStatus {
        let status = {
            let mut inner = self.inner.lock().expect("updater state mutex");
            update(&mut inner);
            inner.status.clone()
        };
        let _ = app.emit(STATUS_EVENT, status.clone());
        status
    }
}

fn check_preserves_status(phase: DesktopUpdatePhase) -> bool {
    phase == DesktopUpdatePhase::ReadyToRelaunch
}

fn updater_error(error: impl std::fmt::Display) -> DesktopUpdateError {
    DesktopUpdateError::Updater(error.to_string())
}

fn now_text() -> Result<String, DesktopUpdateError> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|_| DesktopUpdateError::Discovery("could not record the check time"))
}

async fn fetch_channel(endpoint: &Url) -> Result<serde_json::Value, DesktopUpdateError> {
    if endpoint.as_str() != CHANNEL_ENDPOINT {
        return Err(DesktopUpdateError::InvalidChannel(
            "the endpoint is not approved",
        ));
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(CHECK_TIMEOUT)
        .user_agent(concat!("wisp-desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| DesktopUpdateError::Discovery("could not create the HTTPS client"))?;
    let response = client
        .get(endpoint.clone())
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|_| DesktopUpdateError::Discovery("the update host did not respond"))?;
    if !response.status().is_success() {
        return Err(DesktopUpdateError::Discovery(
            "the update channel is not published yet",
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CHANNEL_BYTES as u64)
    {
        return Err(DesktopUpdateError::InvalidChannel(
            "the document is too large",
        ));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk
            .map_err(|_| DesktopUpdateError::Discovery("the channel download was interrupted"))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_CHANNEL_BYTES {
            return Err(DesktopUpdateError::InvalidChannel(
                "the document is too large",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| DesktopUpdateError::InvalidChannel("the document is not valid JSON"))
}

fn validate_manifest(
    raw: &serde_json::Value,
    now: OffsetDateTime,
) -> Result<Candidate, DesktopUpdateError> {
    if serde_json::to_vec(raw).is_ok_and(|encoded| encoded.len() > MAX_CHANNEL_BYTES) {
        return Err(DesktopUpdateError::InvalidChannel(
            "the document is too large",
        ));
    }
    let manifest: ChannelManifest = serde_json::from_value(raw.clone())
        .map_err(|_| DesktopUpdateError::InvalidChannel("the document schema is not supported"))?;
    if manifest.schema_version != 1 || manifest.channel != CHANNEL {
        return Err(DesktopUpdateError::InvalidChannel(
            "the channel identity is wrong",
        ));
    }
    if manifest.published_at != manifest.pub_date {
        return Err(DesktopUpdateError::InvalidChannel(
            "publication dates disagree",
        ));
    }
    let published = OffsetDateTime::parse(&manifest.published_at, &Rfc3339)
        .map_err(|_| DesktopUpdateError::InvalidChannel("the publication date is invalid"))?;
    if published > now + FUTURE_PUBLICATION_TOLERANCE {
        return Err(DesktopUpdateError::InvalidChannel(
            "the publication date is in the future",
        ));
    }
    let version = Version::parse(&manifest.version)
        .map_err(|_| DesktopUpdateError::InvalidChannel("the release version is invalid"))?;
    if version.build != semver::BuildMetadata::EMPTY {
        return Err(DesktopUpdateError::InvalidChannel(
            "build metadata is not allowed",
        ));
    }
    if manifest
        .notes
        .as_ref()
        .is_some_and(|notes| notes.len() > MAX_NOTES_BYTES)
    {
        return Err(DesktopUpdateError::InvalidChannel(
            "release notes are too large",
        ));
    }
    if manifest.artifact_size == 0 || manifest.artifact_size > MAX_ARTIFACT_BYTES {
        return Err(DesktopUpdateError::InvalidChannel(
            "the artifact size is invalid",
        ));
    }
    if manifest.platforms.len() != 1 {
        return Err(DesktopUpdateError::InvalidChannel(
            "the platform set is invalid",
        ));
    }
    let platform = manifest
        .platforms
        .get(PLATFORM)
        .ok_or(DesktopUpdateError::InvalidChannel(
            "the Apple Silicon application is missing",
        ))?;
    if platform.signature.is_empty() || platform.signature.len() > MAX_SIGNATURE_BYTES {
        return Err(DesktopUpdateError::InvalidChannel(
            "the updater signature is invalid",
        ));
    }
    validate_artifact_url(&platform.url, &manifest.version)?;
    Ok(Candidate {
        version,
        version_text: manifest.version,
        published_at: manifest.published_at,
        notes: manifest.notes,
        artifact_size: manifest.artifact_size,
        url: platform.url.clone(),
        signature: platform.signature.clone(),
    })
}

fn validate_artifact_url(url: &Url, version: &str) -> Result<(), DesktopUpdateError> {
    let expected_path = format!(
        "/Pepewitch/wisp/releases/download/v{version}/wisp-desktop-v{version}-darwin-arm64.tar.gz"
    );
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != expected_path
    {
        return Err(DesktopUpdateError::InvalidChannel(
            "the artifact URL is not approved",
        ));
    }
    Ok(())
}

fn allowed_network_url(url: &Url) -> bool {
    if url.scheme() != "https" || url.username() != "" || url.password().is_some() {
        return false;
    }
    matches!(
        url.host_str(),
        Some("raw.githubusercontent.com")
            | Some("github.com")
            | Some("release-assets.githubusercontent.com")
            | Some("objects.githubusercontent.com")
    )
}

fn preflight_install_location(app: &Path) -> Result<(), DesktopUpdateError> {
    if app.extension().and_then(|value| value.to_str()) != Some("app") {
        return Err(DesktopUpdateError::UnsupportedLocation(
            "the running process is not inside an application bundle",
        ));
    }
    if app
        .components()
        .any(|component| component.as_os_str() == "AppTranslocation")
    {
        return Err(DesktopUpdateError::UnsupportedLocation(
            "macOS is running a translocated copy",
        ));
    }
    let parent = app.parent().ok_or(DesktopUpdateError::UnsupportedLocation(
        "the application has no parent directory",
    ))?;
    let metadata = std::fs::metadata(parent).map_err(|_| {
        DesktopUpdateError::UnsupportedLocation("the application directory is unavailable")
    })?;
    if !metadata.is_dir() {
        return Err(DesktopUpdateError::UnsupportedLocation(
            "the application directory is not writable",
        ));
    }
    tempfile::NamedTempFile::new_in(parent).map_err(|_| {
        DesktopUpdateError::UnsupportedLocation("the application directory is not writable")
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(version: &str, published_at: &str) -> serde_json::Value {
        serde_json::json!({
            "schemaVersion": 1,
            "channel": "alpha",
            "version": version,
            "publishedAt": published_at,
            "pub_date": published_at,
            "notes": "A signed update.",
            "artifactSize": 42,
            "platforms": {
                "darwin-aarch64-app": {
                    "url": format!("https://github.com/Pepewitch/wisp/releases/download/v{version}/wisp-desktop-v{version}-darwin-arm64.tar.gz"),
                    "signature": "synthetic-updater-signature"
                }
            }
        })
    }

    #[test]
    fn accepts_the_exact_alpha_channel_contract() {
        let now = OffsetDateTime::parse("2026-09-06T12:00:00Z", &Rfc3339).unwrap();
        let candidate =
            validate_manifest(&manifest("0.4.0-alpha.9", "2026-09-06T11:59:00Z"), now).unwrap();
        assert_eq!(candidate.version_text, "0.4.0-alpha.9");
        assert_eq!(candidate.artifact_size, 42);
    }

    #[test]
    fn rejects_future_unknown_or_redirectable_channel_data() {
        let now = OffsetDateTime::parse("2026-09-06T12:00:00Z", &Rfc3339).unwrap();
        assert!(
            validate_manifest(&manifest("0.4.0-alpha.9", "2026-09-06T12:11:00Z"), now).is_err()
        );

        let mut unknown = manifest("0.4.0-alpha.9", "2026-09-06T12:00:00Z");
        unknown["unexpected"] = serde_json::json!(true);
        assert!(validate_manifest(&unknown, now).is_err());

        let mut wrong_url = manifest("0.4.0-alpha.9", "2026-09-06T12:00:00Z");
        wrong_url["platforms"][PLATFORM]["url"] =
            serde_json::json!("https://example.test/update.tar.gz");
        assert!(validate_manifest(&wrong_url, now).is_err());
    }

    #[test]
    fn updater_redirects_stay_on_the_release_allowlist() {
        assert!(allowed_network_url(
            &Url::parse("https://release-assets.githubusercontent.com/object").unwrap()
        ));
        assert!(!allowed_network_url(
            &Url::parse("https://release-assets.githubusercontent.com.example.test/object")
                .unwrap()
        ));
        assert!(!allowed_network_url(
            &Url::parse("http://github.com/Pepewitch/wisp/releases/download/v1/x").unwrap()
        ));
    }

    #[test]
    fn install_preflight_rejects_non_bundle_and_translocated_paths() {
        assert!(matches!(
            preflight_install_location(Path::new("/tmp/wisp-desktop")),
            Err(DesktopUpdateError::UnsupportedLocation(_))
        ));
        assert!(matches!(
            preflight_install_location(Path::new("/private/var/folders/AppTranslocation/Wisp.app")),
            Err(DesktopUpdateError::UnsupportedLocation(_))
        ));

        let parent = tempfile::tempdir().unwrap();
        let app = parent.path().join("Wisp.app");
        std::fs::create_dir(&app).unwrap();
        preflight_install_location(&app).unwrap();
    }

    #[test]
    fn an_unprovisioned_key_is_honest_and_inert() {
        assert_eq!(configured_public_key("  UNCONFIGURED\n"), None);
        assert_eq!(configured_public_key(""), None);
        assert_eq!(configured_public_key("public-key"), Some("public-key"));
    }

    #[test]
    fn an_installed_update_keeps_its_relaunch_recovery_state() {
        assert!(check_preserves_status(DesktopUpdatePhase::ReadyToRelaunch));
        assert!(!check_preserves_status(DesktopUpdatePhase::Available));
    }
}
