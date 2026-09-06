//! The native core the Tauri commands sit on: registry, proxy, and the one
//! shared HTTP client. Kept free of `tauri` types so the whole surface can be
//! driven from integration tests without a running application.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use url::Url;

use crate::capability::Capability;
use crate::local::{self, LocalError, LocalStatus};
use crate::probe::{self, ProbeError};
use crate::proxy::{self, ProxyHandle, ProxyStartError, ProxyState};
use crate::registry::{ConnectionInfo, Registry, RegistryError};
use crate::secrets::SecretStore;
use crate::setup::{self, LocalSetupReport, SetupError};
use crate::urls::{normalize_daemon_url, UrlError};

/// Everything `desktop_bootstrap` hands the webview.
///
/// Note the shape of the contract: an unguessable base, and metadata. No token,
/// no daemon URL the frontend could substitute into a request, and no way to
/// ask for one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    /// `http://127.0.0.1:<port>/<capability>` — prefix for every daemon call.
    pub proxy_base_url: String,
    /// The desktop opens on Local. Selection after bootstrap is webview state.
    pub active_connection_id: &'static str,
    pub connections: Vec<ConnectionInfo>,
    pub local: LocalStatus,
}

/// Every way a command can refuse, as a sentence the UI can show.
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error(transparent)]
    Url(#[from] UrlError),
    #[error(transparent)]
    Probe(#[from] ProbeError),
    #[error(transparent)]
    Registry(#[from] RegistryError),
    #[error(transparent)]
    Local(#[from] LocalError),
    #[error("the Local profile and daemon report different instance identities")]
    LocalIdentityMismatch,
    #[error("a token is required")]
    EmptyToken,
    #[error("that daemon changed after the connection check; check it again before saving")]
    RemoteIdentityChanged,
    #[error(
        "a different Wisp daemon answers this connection; review its identity before reconnecting"
    )]
    RemoteIdentityConfirmationRequired,
    #[error(transparent)]
    Start(#[from] ProxyStartError),
    #[error(transparent)]
    Setup(#[from] SetupError),
    #[error("the local Wisp service did not become ready within 30 seconds")]
    SetupTimeout,
    #[error("local Wisp changed after it was diagnosed; review the new status before confirming")]
    SetupPlanChanged,
}

/// Commands cross into JavaScript, so the error becomes a string there. This is
/// the only conversion, and it is `Display` — never `Debug`, which could carry
/// a source chain a future edit made secret-bearing.
impl serde::Serialize for CoreError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub struct DesktopCore {
    state: Arc<ProxyState>,
    proxy: ProxyHandle,
    registry: Arc<Registry>,
    wisp_home: PathBuf,
}

impl DesktopCore {
    /// Open the registry, mint a capability, and bind the loopback proxy.
    ///
    /// `registry_path` is app-owned state; `wisp_home` is the standard Wisp
    /// profile the built-in local connection reads.
    pub async fn start(
        registry_path: PathBuf,
        secrets: Arc<dyn SecretStore>,
        wisp_home: PathBuf,
        allowed_origins: Vec<String>,
    ) -> Result<Self, CoreError> {
        let local = local::load(&wisp_home);
        let registry = Arc::new(Registry::open(
            registry_path,
            secrets,
            wisp_home.clone(),
            local,
        )?);
        let state = Arc::new(ProxyState::new(
            Capability::generate(),
            registry.clone(),
            allowed_origins,
        )?);
        let proxy = proxy::start(state.clone()).await?;
        Ok(Self {
            state,
            proxy,
            registry,
            wisp_home,
        })
    }

    pub fn registry(&self) -> &Arc<Registry> {
        &self.registry
    }

    pub fn proxy_base(&self) -> &str {
        self.proxy.base()
    }

    pub fn bootstrap(&self) -> Bootstrap {
        Bootstrap {
            proxy_base_url: self.proxy.base().to_string(),
            active_connection_id: local::LOCAL_CONNECTION_ID,
            connections: self.registry.list(),
            local: self.registry.local_status(),
        }
    }

    /// Validate, prove, then save — in that order, and never any other.
    pub async fn add_remote(
        &self,
        label: &str,
        url: &str,
        token: &str,
    ) -> Result<ConnectionInfo, CoreError> {
        self.add_remote_checked(label, url, token, None).await
    }

    pub async fn probe_remote(
        &self,
        url: &str,
        token: &str,
    ) -> Result<probe::DaemonIdentity, CoreError> {
        let (url, token) = check(url, token)?;
        Ok(probe::probe(self.state.client(), &url, &token).await?)
    }

    pub async fn add_remote_checked(
        &self,
        label: &str,
        url: &str,
        token: &str,
        expected_instance_id: Option<&str>,
    ) -> Result<ConnectionInfo, CoreError> {
        let (url, token) = check(url, token)?;
        let identity = probe::probe(self.state.client(), &url, &token).await?;
        if expected_instance_id.is_some_and(|expected| expected != identity.instance_id) {
            return Err(CoreError::RemoteIdentityChanged);
        }
        Ok(self
            .registry
            .add_remote(label, &url, &token, &identity.instance_id)?)
    }

    /// Re-prove a saved connection.
    ///
    /// Same URL: refresh the credential and clear the identity pin in place.
    /// New URL: mint a replacement connection with a new immutable ID and
    /// remove the old one, so nothing already in flight is retargeted.
    pub async fn reconnect(
        &self,
        connection_id: &str,
        url: Option<&str>,
        token: Option<&str>,
    ) -> Result<ConnectionInfo, CoreError> {
        self.reconnect_checked(connection_id, url, token, None)
            .await
    }

    pub async fn probe_reconnect(
        &self,
        connection_id: &str,
        url: Option<&str>,
        token: Option<&str>,
    ) -> Result<probe::DaemonIdentity, CoreError> {
        let target = self
            .registry
            .resolve(connection_id)
            .ok_or_else(|| RegistryError::UnknownConnection(connection_id.to_string()))?;
        let next_url = match url {
            Some(raw) => normalize_daemon_url(raw)?,
            None => target.base.clone(),
        };
        let next_token = match token {
            Some(raw) if !raw.trim().is_empty() => raw.trim().to_string(),
            Some(_) => return Err(CoreError::EmptyToken),
            None => self.registry.credential(&target)?,
        };
        Ok(probe::probe(self.state.client(), &next_url, &next_token).await?)
    }

    pub async fn reconnect_checked(
        &self,
        connection_id: &str,
        url: Option<&str>,
        token: Option<&str>,
        expected_instance_id: Option<&str>,
    ) -> Result<ConnectionInfo, CoreError> {
        // Re-read the standard profile: `wisp init`, token rotation, or a
        // daemon replacement may all have happened since app launch.
        if connection_id == local::LOCAL_CONNECTION_ID {
            let profile = local::load(&self.wisp_home)?;
            let identity =
                probe::probe(self.state.client(), profile.base(), profile.token()).await?;
            if identity.instance_id != profile.instance_id() {
                return Err(CoreError::LocalIdentityMismatch);
            }
            return Ok(self.registry.refresh_local(profile));
        }

        let target = self
            .registry
            .resolve(connection_id)
            .ok_or_else(|| RegistryError::UnknownConnection(connection_id.to_string()))?;

        let next_url = match url {
            Some(raw) => normalize_daemon_url(raw)?,
            None => target.base.clone(),
        };
        let next_token = match token {
            Some(raw) if !raw.trim().is_empty() => raw.trim().to_string(),
            Some(_) => return Err(CoreError::EmptyToken),
            None => self.registry.credential(&target)?,
        };

        let identity = probe::probe(self.state.client(), &next_url, &next_token).await?;
        if expected_instance_id.is_some_and(|expected| expected != identity.instance_id) {
            return Err(CoreError::RemoteIdentityChanged);
        }
        if identity.instance_id != target.instance_id
            && expected_instance_id != Some(identity.instance_id.as_str())
        {
            return Err(CoreError::RemoteIdentityConfirmationRequired);
        }
        if next_url == target.base {
            Ok(self.registry.refresh(
                connection_id,
                token.map(|_| next_token.as_str()),
                &identity.instance_id,
            )?)
        } else {
            Ok(self.registry.replace(
                connection_id,
                &next_url,
                &next_token,
                &identity.instance_id,
            )?)
        }
    }

    pub fn rename(&self, connection_id: &str, label: &str) -> Result<ConnectionInfo, CoreError> {
        Ok(self.registry.rename(connection_id, label)?)
    }

    pub fn remove(&self, connection_id: &str) -> Result<(), CoreError> {
        Ok(self.registry.remove(connection_id)?)
    }

    pub fn reset_desktop_data(&self) -> Result<(), CoreError> {
        Ok(self.registry.reset_desktop_data()?)
    }

    /// Report on the local install without changing it.
    pub async fn local_setup(&self) -> Result<LocalSetupReport, CoreError> {
        let profile = local::load(&self.wisp_home);
        let status = LocalStatus::from_result(&self.wisp_home, &profile);
        let cli = setup::find_wisp_cli(std::env::var_os("HOME").map(PathBuf::from).as_deref());
        let reachable = match &profile {
            Ok(profile) => {
                match probe::probe(self.state.client(), profile.base(), profile.token()).await {
                    Ok(identity) if identity.instance_id == profile.instance_id() => {
                        self.registry.refresh_local(profile.clone());
                        true
                    }
                    Ok(_) => return Err(CoreError::LocalIdentityMismatch),
                    Err(ProbeError::Unreachable(_)) => false,
                    Err(error) => return Err(error.into()),
                }
            }
            Err(_) => false,
        };
        Ok(setup::decide(&status, cli.as_deref(), reachable))
    }

    /// Apply a diagnosis only after the webview displayed it and the user
    /// explicitly confirmed. Then prove the authenticated daemon and refresh
    /// the built-in Local route without restarting the desktop process.
    pub async fn apply_local_setup(
        &self,
        expected_step: setup::NextStep,
    ) -> Result<LocalSetupReport, CoreError> {
        let report = self.local_setup().await?;
        if report.next_step != expected_step {
            return Err(CoreError::SetupPlanChanged);
        }
        let planned = report.clone();
        tokio::task::spawn_blocking(move || setup::apply(&planned))
            .await
            .map_err(|_| SetupError::Failed("local setup worker"))??;

        for _ in 0..120 {
            match local::load(&self.wisp_home) {
                Ok(profile) => {
                    match probe::probe(self.state.client(), profile.base(), profile.token()).await {
                        Ok(identity) => {
                            if identity.instance_id != profile.instance_id() {
                                return Err(CoreError::LocalIdentityMismatch);
                            }
                            self.registry.refresh_local(profile);
                            return self.local_setup().await;
                        }
                        Err(ProbeError::Unreachable(_)) => {}
                        Err(error) => return Err(error.into()),
                    }
                }
                Err(LocalError::NoProfile(_)) => {}
                Err(error) => return Err(error.into()),
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        Err(CoreError::SetupTimeout)
    }

    pub fn wisp_home(&self) -> &PathBuf {
        &self.wisp_home
    }
}

fn check(url: &str, token: &str) -> Result<(Url, String), CoreError> {
    let url = normalize_daemon_url(url)?;
    let token = token.trim();
    if token.is_empty() {
        return Err(CoreError::EmptyToken);
    }
    Ok((url, token.to_string()))
}
