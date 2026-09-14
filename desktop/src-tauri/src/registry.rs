//! Native connection state: the only place a proxy target can come from.
//!
//! Three invariants this module exists to hold:
//!
//! * **IDs are immutable.** A label is what a person edits; an ID is what
//!   routes, keys caches, and names a Keychain account. Renaming touches only
//!   the label. Retargeting mints a *new* ID rather than moving an old one, so
//!   in-flight work on the old connection can never be silently redirected.
//! * **The file holds no secrets.** Metadata on disk, credentials in the
//!   Keychain. That split is what makes a removal tombstone safe to write.
//! * **Removal revokes before it deletes.** The route dies in the same atomic
//!   file write that records the tombstone; the credential and the tombstone
//!   are cleaned up after. A crash between the two resumes at next launch.

mod credentials;
mod persistence;
mod routes;

pub use credentials::CleanupIssue;
pub use persistence::StoredConnection;
pub use routes::{is_valid_connection_id, ConnectionKind, Identity, Target};

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::local::{LocalError, LocalProfile, LocalStatus, LOCAL_CONNECTION_ID};
use crate::secrets::{SecretError, SecretStore};
use persistence::{clean_label, read_file, validate_file, write_file, StoredLocalTarget};

/// Product limit, including the built-in Local connection.
pub const MAX_CONNECTIONS: usize = 8;

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("no connection named {0}")]
    UnknownConnection(String),
    #[error("that connection route belongs to an earlier target generation")]
    StaleRoute,
    #[error("that connection is being removed")]
    PendingRemoval,
    #[error("the built-in local connection cannot be {0}")]
    LocalIsBuiltIn(&'static str),
    #[error("a changed daemon identity requires a replacement connection")]
    IdentityChangeRequiresReplacement,
    #[error("a label is required")]
    EmptyLabel,
    #[error("a connection named {0} already exists")]
    DuplicateLabel(String),
    #[error("Wisp Desktop supports at most {MAX_CONNECTIONS} connections")]
    TooManyConnections,
    #[error("no credential is stored for this connection — reconnect to enter its token")]
    MissingCredential,
    #[error(
        "the Local Wisp profile now points to a different daemon — reconnect Local before retrying"
    )]
    LocalProfileChanged,
    #[error("could not read the local Wisp profile: {0}")]
    Local(#[from] LocalError),
    #[error(transparent)]
    Secret(#[from] SecretError),
    #[error("could not write {path}: {source}")]
    Persist {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("could not read {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("could not decode {path}: {source}")]
    Decode {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("invalid connection registry at {path}: {reason}")]
    InvalidFile { path: PathBuf, reason: &'static str },
}

/// What the webview is allowed to know about a connection.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub id: String,
    /// Persisted routing generation. The reserved Local ID stays stable, so a
    /// target change increments this value to invalidate proxy routes and
    /// webview state across both reconnects and application launches.
    pub route_revision: u32,
    #[serde(rename = "name")]
    pub label: String,
    pub kind: ConnectionKind,
    /// Display address. Non-secret: the user typed it, or it is loopback.
    pub url: String,
    pub instance_id: String,
    /// False when the credential or local profile is gone and the connection
    /// needs attention before it will serve traffic.
    pub ready: bool,
    /// A connection-scoped, secret-free recovery reason when `ready` is false.
    pub problem: Option<String>,
}

#[derive(Clone)]
struct State {
    local: Option<LocalProfile>,
    local_error: Option<String>,
    local_label: String,
    connections: BTreeMap<String, StoredConnection>,
    pending_removals: BTreeSet<String>,
    /// Remote credentials, read from the Keychain once per launch so the proxy
    /// hot path never blocks on Security.framework.
    credentials: HashMap<String, String>,
    credential_errors: HashMap<String, String>,
    cleanup_errors: BTreeMap<String, String>,
    identity: HashMap<String, Identity>,
    local_target: Option<StoredLocalTarget>,
    local_route_revision: u32,
}

/// The native connection registry.
pub struct Registry {
    path: PathBuf,
    secrets: Arc<dyn SecretStore>,
    local_home: PathBuf,
    /// Serializes metadata/Keychain transactions without blocking proxy reads.
    mutations: Mutex<()>,
    state: Mutex<State>,
    #[cfg(test)]
    persist_failure_countdown: Mutex<Option<usize>>,
}

impl Registry {
    /// Open the registry, replay any interrupted removal, and warm the
    /// credential cache. Blocking: call it off the async runtime.
    pub fn open(
        path: PathBuf,
        secrets: Arc<dyn SecretStore>,
        local_home: PathBuf,
        local: Result<LocalProfile, LocalError>,
    ) -> Result<Self, RegistryError> {
        let mut file = read_file(&path)?;
        validate_file(&path, &file)?;
        let (local_profile, local_error) = match local {
            Ok(profile) => (Some(profile), None),
            Err(error) => (None, Some(error.to_string())),
        };

        // Record the first observed Local target without advancing the
        // generation. Thereafter, an address or identity change advances and
        // persists the generation before the proxy becomes available. A
        // launch that cannot durably record the new scope fails closed.
        if let Some(observed) = local_profile.as_ref().map(StoredLocalTarget::from_profile) {
            if file.local_target.as_ref() != Some(&observed) {
                if file.local_target.is_some() {
                    file.local_route_revision = file.local_route_revision.saturating_add(1);
                }
                file.local_target = Some(observed);
                write_file(&path, &file)?;
            }
        }

        let local_label = clean_label(&file.local_label)?;
        let mut connections = BTreeMap::new();
        for entry in file.connections {
            connections.insert(entry.id.clone(), entry);
        }

        let registry = Self {
            path,
            secrets,
            local_home,
            mutations: Mutex::new(()),
            state: Mutex::new(State {
                local: local_profile,
                local_error,
                local_label,
                connections,
                pending_removals: file.pending_removals.into_iter().collect(),
                credentials: HashMap::new(),
                credential_errors: HashMap::new(),
                cleanup_errors: BTreeMap::new(),
                identity: HashMap::new(),
                local_target: file.local_target,
                local_route_revision: file.local_route_revision,
            }),
            #[cfg(test)]
            persist_failure_countdown: Mutex::new(None),
        };
        registry.finish_pending_removals()?;
        registry.warm_credentials();
        Ok(registry)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("registry mutex")
    }

    fn mutation_lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.mutations.lock().expect("registry mutation mutex")
    }

    /// Non-secret metadata for every connection, local first.
    pub fn list(&self) -> Vec<ConnectionInfo> {
        let state = self.lock();
        let mut out = Vec::with_capacity(state.connections.len() + 1);
        out.push(match &state.local {
            Some(profile) => ConnectionInfo {
                id: LOCAL_CONNECTION_ID.to_string(),
                route_revision: state.local_route_revision,
                label: state.local_label.clone(),
                kind: ConnectionKind::Local,
                url: profile.base().to_string(),
                instance_id: profile.instance_id().to_string(),
                ready: true,
                problem: None,
            },
            None => ConnectionInfo {
                id: LOCAL_CONNECTION_ID.to_string(),
                route_revision: state.local_route_revision,
                label: state.local_label.clone(),
                kind: ConnectionKind::Local,
                url: String::new(),
                instance_id: String::new(),
                ready: false,
                problem: state.local_error.clone(),
            },
        });
        for entry in state.connections.values() {
            if state.pending_removals.contains(&entry.id) {
                continue;
            }
            let ready = state.credentials.contains_key(&entry.id);
            out.push(ConnectionInfo {
                id: entry.id.clone(),
                route_revision: 0,
                label: entry.label.clone(),
                kind: ConnectionKind::Remote,
                url: entry.url.clone(),
                instance_id: entry.instance_id.clone(),
                ready,
                problem: if ready {
                    None
                } else {
                    state.credential_errors.get(&entry.id).cloned().or_else(|| {
                        Some("No stored credential; reconnect to enter its token".to_string())
                    })
                },
            });
        }
        out
    }

    pub fn local_status(&self) -> LocalStatus {
        let state = self.lock();
        match &state.local {
            Some(profile) => LocalStatus {
                available: true,
                config_path: profile.config_path().display().to_string(),
                base_url: Some(profile.base().to_string()),
                instance_id: Some(profile.instance_id().to_string()),
                has_token: true,
                reason: None,
            },
            None => LocalStatus {
                available: false,
                config_path: self.local_home.join("config.json").display().to_string(),
                base_url: None,
                instance_id: None,
                has_token: false,
                reason: state.local_error.clone(),
            },
        }
    }
}

#[cfg(test)]
mod tests;
