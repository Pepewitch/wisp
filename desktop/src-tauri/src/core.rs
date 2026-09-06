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
use crate::setup::{self, LocalSetupReport};
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
    #[error(transparent)]
    Start(#[from] ProxyStartError),
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
        let (url, token) = check(url, token)?;
        let identity = probe::probe(self.state.client(), &url, &token).await?;
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

    /// Report on the local install without changing it.
    pub async fn local_setup(&self) -> LocalSetupReport {
        let status = self.registry.local_status();
        let cli = setup::find_wisp_cli(std::env::var_os("HOME").map(PathBuf::from).as_deref());
        let reachable = match self.registry.resolve(local::LOCAL_CONNECTION_ID) {
            Some(target) => setup::daemon_reachable(self.state.client(), &target.base).await,
            None => false,
        };
        setup::decide(&status, cli.as_deref(), reachable)
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
