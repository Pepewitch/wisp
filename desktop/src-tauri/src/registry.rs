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

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use url::Url;

use crate::local::{
    LocalError, LocalProfile, LocalStatus, LOCAL_CONNECTION_ID, LOCAL_CONNECTION_LABEL,
};
use crate::secrets::{SecretError, SecretStore};
use crate::urls::normalize_daemon_url;

/// Current on-disk schema version of `connections.json`.
const FILE_VERSION: u32 = 1;
/// Product limit, including the built-in Local connection.
pub const MAX_CONNECTIONS: usize = 8;

fn default_local_label() -> String {
    LOCAL_CONNECTION_LABEL.to_string()
}

/// Connection IDs are ASCII path segments — they appear literally in proxy
/// routes and in query-cache keys, so anything needing encoding is out.
pub fn is_valid_connection_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A fresh remote ID. Opaque on purpose: nothing may parse meaning out of it.
fn new_connection_id() -> String {
    format!("c-{}", crate::random::random_hex(12))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionKind {
    Local,
    Remote,
}

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

/// One saved remote connection, exactly as it is written to disk.
///
/// Everything here is non-secret by construction. There is no token field and
/// no place to add one: the type is what the tombstone protocol relies on.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredConnection {
    pub id: String,
    pub label: String,
    pub url: String,
    /// Daemon identity pinned at the capability check that admitted this URL.
    pub instance_id: String,
    pub created_at: u64,
}

/// Non-secret identity of the daemon most recently accepted for Local.
///
/// Local keeps its reserved logical ID across launches, so this is persisted
/// with a monotonic route revision. That lets both the native proxy and the
/// webview reject convenience state or requests that belonged to an earlier
/// daemon without ever copying Local's token into desktop-owned storage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredLocalTarget {
    url: String,
    instance_id: String,
}

impl StoredLocalTarget {
    fn from_profile(profile: &LocalProfile) -> Self {
        Self {
            url: profile.base().to_string(),
            instance_id: profile.instance_id().to_string(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryFile {
    version: u32,
    #[serde(default = "default_local_label")]
    local_label: String,
    #[serde(default)]
    local_target: Option<StoredLocalTarget>,
    #[serde(default)]
    local_route_revision: u32,
    #[serde(default)]
    connections: Vec<StoredConnection>,
    /// Non-secret removal tombstones. An ID here has already lost its route.
    #[serde(default)]
    pending_removals: Vec<String>,
}

impl Default for RegistryFile {
    fn default() -> Self {
        Self {
            version: FILE_VERSION,
            local_label: default_local_label(),
            local_target: None,
            local_route_revision: 0,
            connections: Vec::new(),
            pending_removals: Vec::new(),
        }
    }
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupIssue {
    pub connection_id: String,
    pub message: String,
}

/// A resolved proxy target. Produced only by the registry, never by a request.
#[derive(Debug, Clone)]
pub struct Target {
    pub id: String,
    pub route_revision: u32,
    pub kind: ConnectionKind,
    pub base: Url,
    pub instance_id: String,
}

/// Result of the most recent pinned-identity check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Identity {
    Unchecked,
    Verified,
    Mismatch,
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

    /// Resume removals that a crash interrupted between the tombstone write and
    /// the credential delete. Deleting an absent credential is a no-op, so this
    /// is safe to run on every launch.
    fn finish_pending_removals(&self) -> Result<(), RegistryError> {
        let pending: Vec<String> = {
            let state = self.lock();
            state.pending_removals.iter().cloned().collect()
        };
        if pending.is_empty() {
            return Ok(());
        }
        let mut cleaned = Vec::new();
        let mut failed = Vec::new();
        for id in &pending {
            // A locked or temporarily unavailable Keychain item is scoped to
            // this tombstone. Keep it for a later reset/launch; never make one
            // failed cleanup prevent Local and unrelated remotes from opening.
            match self.secrets.delete(id) {
                Ok(()) => cleaned.push(id.clone()),
                Err(error) => failed.push((id.clone(), error.to_string())),
            }
        }
        let mut state = self.lock();
        for (id, error) in failed {
            state.cleanup_errors.insert(id, error);
        }
        if cleaned.is_empty() {
            return Ok(());
        }
        let before = state.clone();
        for id in &cleaned {
            state.pending_removals.remove(id);
            state.connections.remove(id);
            state.cleanup_errors.remove(id);
        }
        if let Err(error) = self.persist(&state) {
            *state = before;
            return Err(error);
        }
        Ok(())
    }

    fn warm_credentials(&self) {
        let ids: Vec<String> = {
            let state = self.lock();
            state.connections.keys().cloned().collect()
        };
        let mut found = HashMap::new();
        let mut failures = HashMap::new();
        for id in ids {
            // Keychain availability is connection-scoped. A failed read leaves
            // this connection visible but not ready so it can be repaired from
            // the UI without taking down the whole desktop application.
            match self.secrets.get(&id) {
                Ok(Some(secret)) => {
                    found.insert(id, secret);
                }
                Ok(None) => {}
                Err(error) => {
                    failures.insert(id, error.to_string());
                }
            }
        }
        let mut state = self.lock();
        state.credentials.extend(found);
        state.credential_errors.extend(failures);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("registry mutex")
    }

    fn mutation_lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.mutations.lock().expect("registry mutation mutex")
    }

    fn persist(&self, state: &State) -> Result<(), RegistryError> {
        #[cfg(test)]
        {
            let mut countdown = self
                .persist_failure_countdown
                .lock()
                .expect("persist failure mutex");
            if let Some(remaining) = countdown.as_mut() {
                if *remaining == 0 {
                    *countdown = None;
                    return Err(RegistryError::Persist {
                        path: self.path.clone(),
                        source: std::io::Error::other("synthetic persist failure"),
                    });
                }
                *remaining -= 1;
            }
        }
        let file = RegistryFile {
            version: FILE_VERSION,
            local_label: state.local_label.clone(),
            local_target: state.local_target.clone(),
            local_route_revision: state.local_route_revision,
            connections: state.connections.values().cloned().collect(),
            pending_removals: state.pending_removals.iter().cloned().collect(),
        };
        write_file(&self.path, &file)
    }

    #[cfg(test)]
    fn fail_persist_after(&self, successful_calls: usize) {
        *self
            .persist_failure_countdown
            .lock()
            .expect("persist failure mutex") = Some(successful_calls);
    }

    /// Persist a recovery marker before creating a Keychain item. If any later
    /// metadata step fails, launch/reset can still discover and delete it.
    fn stage_secret_recovery(&self, id: &str) -> Result<(), RegistryError> {
        let mut state = self.lock();
        let before = state.clone();
        state.pending_removals.insert(id.to_string());
        if let Err(error) = self.persist(&state) {
            *state = before;
            return Err(error);
        }
        Ok(())
    }

    fn clear_secret_recovery(&self, id: &str) -> Result<(), RegistryError> {
        let mut state = self.lock();
        let before = state.clone();
        state.pending_removals.remove(id);
        state.cleanup_errors.remove(id);
        if let Err(error) = self.persist(&state) {
            *state = before;
            return Err(error);
        }
        Ok(())
    }

    /// Best-effort immediate cleanup backed by the already-persisted marker.
    /// A delete failure is visible in bootstrap; a persist failure leaves the
    /// marker on disk for the next launch, so neither case can orphan an item.
    fn cleanup_staged_secret(&self, id: &str) {
        match self.secrets.delete(id) {
            Ok(()) => {
                let _ = self.clear_secret_recovery(id);
            }
            Err(error) => {
                self.lock()
                    .cleanup_errors
                    .insert(id.to_string(), error.to_string());
            }
        }
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

    pub fn cleanup_issues(&self) -> Vec<CleanupIssue> {
        self.lock()
            .cleanup_errors
            .iter()
            .map(|(connection_id, error)| CleanupIssue {
                connection_id: connection_id.clone(),
                message: format!(
                    "Credential cleanup for {connection_id} is incomplete: {error}. Retry Reset desktop data or relaunch Wisp Desktop."
                ),
            })
            .collect()
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

    /// Replace the in-memory Local profile after an authenticated reconnect.
    /// The source of truth remains `~/.wisp/config.json`; only the mutable
    /// launch snapshot and identity state change here.
    pub fn refresh_local(&self, profile: LocalProfile) -> Result<ConnectionInfo, RegistryError> {
        let _mutation = self.mutation_lock();
        let mut state = self.lock();
        let observed = StoredLocalTarget::from_profile(&profile);
        let target_changed = state.local_target.as_ref() != Some(&observed);
        let before = state.clone();
        if target_changed {
            state.local_route_revision = state.local_route_revision.saturating_add(1);
            state.local_target = Some(observed);
        }
        let info = ConnectionInfo {
            id: LOCAL_CONNECTION_ID.to_string(),
            route_revision: state.local_route_revision,
            label: state.local_label.clone(),
            kind: ConnectionKind::Local,
            url: profile.base().to_string(),
            instance_id: profile.instance_id().to_string(),
            ready: true,
            problem: None,
        };
        state.local = Some(profile);
        state.local_error = None;
        state
            .identity
            .insert(LOCAL_CONNECTION_ID.to_string(), Identity::Verified);
        if target_changed {
            if let Err(error) = self.persist(&state) {
                *state = before;
                return Err(error);
            }
        }
        Ok(info)
    }

    /// Resolve a route's connection ID to an upstream target.
    ///
    /// Returns `None` for an unknown ID and for one whose tombstone is written,
    /// which is what makes removal a revocation rather than a cleanup.
    pub fn resolve(&self, id: &str) -> Option<Target> {
        let state = self.lock();
        if id == LOCAL_CONNECTION_ID {
            let profile = state.local.as_ref()?;
            return Some(Target {
                id: LOCAL_CONNECTION_ID.to_string(),
                route_revision: state.local_route_revision,
                kind: ConnectionKind::Local,
                base: profile.base().clone(),
                instance_id: profile.instance_id().to_string(),
            });
        }
        if state.pending_removals.contains(id) {
            return None;
        }
        let entry = state.connections.get(id)?;
        // Stored URLs pass the same rule they passed when saved; invalid
        // metadata makes the registry fail closed at open().
        let base = normalize_daemon_url(&entry.url).ok()?;
        Some(Target {
            id: entry.id.clone(),
            route_revision: 0,
            kind: ConnectionKind::Remote,
            base,
            instance_id: entry.instance_id.clone(),
        })
    }

    /// Resolve only the exact route generation issued to the webview.
    ///
    /// This is stricter than [`Self::resolve`]: a stale Local transport cannot
    /// silently follow the reserved `local` ID when its target changes.
    pub fn resolve_route(&self, id: &str, route_revision: u32) -> Result<Target, RegistryError> {
        let target = self
            .resolve(id)
            .ok_or_else(|| RegistryError::UnknownConnection(id.to_string()))?;
        if target.route_revision != route_revision {
            return Err(RegistryError::StaleRoute);
        }
        Ok(target)
    }

    /// Whether a previously resolved target is still the active generation.
    /// Terminal input checks this for every frame, so an already-open socket
    /// loses write authority as soon as Local is retargeted.
    pub fn route_is_current(&self, target: &Target) -> bool {
        target_is_current(&self.lock(), target)
    }

    /// The bearer token for a resolved target. Never returned to the webview:
    /// the only caller is the proxy's upstream request builder.
    pub fn credential(&self, target: &Target) -> Result<String, RegistryError> {
        let state = self.lock();
        if !target_is_current(&state, target) {
            return Err(RegistryError::StaleRoute);
        }
        match target.kind {
            ConnectionKind::Local => state
                .local
                .as_ref()
                .map(|profile| profile.token().to_string())
                .ok_or(RegistryError::MissingCredential),
            ConnectionKind::Remote => state
                .credentials
                .get(&target.id)
                .cloned()
                .ok_or(RegistryError::MissingCredential),
        }
    }

    /// Reload a rotated Local credential without allowing a config change to
    /// retarget an in-flight request. The proxy uses this once after a 401.
    pub fn reload_local_credential(&self, target: &Target) -> Result<String, RegistryError> {
        if target.kind != ConnectionKind::Local {
            return Err(RegistryError::UnknownConnection(target.id.clone()));
        }
        let profile = crate::local::load(&self.local_home)?;
        if profile.base() != &target.base || profile.instance_id() != target.instance_id {
            return Err(RegistryError::LocalProfileChanged);
        }
        let credential = profile.token().to_string();
        // A credential reload is not an identity proof. Preserve the current
        // state so a successful ordinary read cannot authorize a later write,
        // and so concurrent probes cannot observe a premature `Verified`.
        let _mutation = self.mutation_lock();
        let mut state = self.lock();
        if !target_is_current(&state, target) {
            return Err(RegistryError::LocalProfileChanged);
        }
        state.local = Some(profile);
        state.local_error = None;
        Ok(credential)
    }

    /// Read identity state only for the exact target generation that was
    /// resolved. A Local reconnect can replace the stable logical ID while an
    /// older request is awaiting its capability response.
    pub fn identity(&self, target: &Target) -> Result<Identity, RegistryError> {
        let state = self.lock();
        if !target_is_current(&state, target) {
            return Err(RegistryError::StaleRoute);
        }
        Ok(state
            .identity
            .get(&target.id)
            .copied()
            .unwrap_or(Identity::Unchecked))
    }

    /// Atomically record one capability probe for a current target.
    ///
    /// Mismatch is monotonic within a target generation: an older successful
    /// probe cannot race a newer mismatch and restore read authority. Only an
    /// explicit checked reconnect writes `Verified` directly when it updates
    /// the saved connection/profile.
    pub fn record_probe_identity(
        &self,
        target: &Target,
        observed: Identity,
    ) -> Result<Identity, RegistryError> {
        let mut state = self.lock();
        if !target_is_current(&state, target) {
            return Err(RegistryError::StaleRoute);
        }
        let current = state
            .identity
            .get(&target.id)
            .copied()
            .unwrap_or(Identity::Unchecked);
        let effective = if current == Identity::Mismatch {
            Identity::Mismatch
        } else {
            observed
        };
        state.identity.insert(target.id.clone(), effective);
        Ok(effective)
    }

    /// Save a remote connection whose URL and credential already passed an
    /// authenticated `/api/capabilities` check.
    pub fn add_remote(
        &self,
        label: &str,
        url: &Url,
        token: &str,
        instance_id: &str,
    ) -> Result<ConnectionInfo, RegistryError> {
        let label = clean_label(label)?;
        let _mutation = self.mutation_lock();
        let id = {
            let state = self.lock();
            if state.connections.len() + 2 > MAX_CONNECTIONS {
                return Err(RegistryError::TooManyConnections);
            }
            ensure_label_available(&state, &label, None)?;
            mint_id(&state)
        };
        // Record the account before creating it. This makes even a Keychain
        // cleanup failure after a metadata error recoverable on next launch.
        self.stage_secret_recovery(&id)?;
        if let Err(error) = self.secrets.set(&id, token) {
            let _ = self.clear_secret_recovery(&id);
            return Err(error.into());
        }
        let entry = StoredConnection {
            id: id.clone(),
            label,
            url: url.to_string(),
            instance_id: instance_id.to_string(),
            created_at: now_seconds(),
        };
        let mut state = self.lock();
        let before = state.clone();
        state.pending_removals.remove(&id);
        state.cleanup_errors.remove(&id);
        state.credential_errors.remove(&id);
        state.credentials.insert(id.clone(), token.to_string());
        state.identity.insert(id.clone(), Identity::Verified);
        state.connections.insert(id.clone(), entry.clone());
        if let Err(error) = self.persist(&state) {
            *state = before;
            drop(state);
            self.cleanup_staged_secret(&id);
            return Err(error);
        }
        Ok(ConnectionInfo {
            id: entry.id,
            route_revision: 0,
            label: entry.label,
            kind: ConnectionKind::Remote,
            url: entry.url,
            instance_id: entry.instance_id,
            ready: true,
            problem: None,
        })
    }

    /// Change a display label. The ID, route, cache scope, and Keychain account
    /// are all untouched.
    pub fn rename(&self, id: &str, label: &str) -> Result<ConnectionInfo, RegistryError> {
        let label = clean_label(label)?;
        let _mutation = self.mutation_lock();
        let mut state = self.lock();
        ensure_label_available(&state, &label, Some(id))?;
        let before = state.clone();
        if id == LOCAL_CONNECTION_ID {
            state.local_label = label;
            if let Err(error) = self.persist(&state) {
                *state = before;
                return Err(error);
            }
            drop(state);
            return self
                .list()
                .into_iter()
                .find(|connection| connection.id == LOCAL_CONNECTION_ID)
                .ok_or_else(|| RegistryError::UnknownConnection(id.to_string()));
        }
        if state.pending_removals.contains(id) {
            return Err(RegistryError::PendingRemoval);
        }
        let ready = state.credentials.contains_key(id);
        let problem =
            if ready {
                None
            } else {
                state.credential_errors.get(id).cloned().or_else(|| {
                    Some("No stored credential; reconnect to enter its token".to_string())
                })
            };
        let entry = state
            .connections
            .get_mut(id)
            .ok_or_else(|| RegistryError::UnknownConnection(id.to_string()))?;
        entry.label = label;
        let info = ConnectionInfo {
            id: entry.id.clone(),
            route_revision: 0,
            label: entry.label.clone(),
            kind: ConnectionKind::Remote,
            url: entry.url.clone(),
            instance_id: entry.instance_id.clone(),
            ready,
            problem,
        };
        if let Err(error) = self.persist(&state) {
            *state = before;
            return Err(error);
        }
        Ok(info)
    }

    /// Refresh a connection in place after a successful capability check.
    ///
    /// Only for a re-check of the *same* target: a new URL goes through
    /// [`Registry::replace`], because editing an address is a different daemon
    /// until proven otherwise and must not retarget in-flight work.
    pub fn refresh(
        &self,
        id: &str,
        token: Option<&str>,
        instance_id: &str,
    ) -> Result<ConnectionInfo, RegistryError> {
        if id == LOCAL_CONNECTION_ID {
            return Err(RegistryError::LocalIsBuiltIn("re-credentialed"));
        }
        let _mutation = self.mutation_lock();
        let entry = {
            let state = self.lock();
            if state.pending_removals.contains(id) {
                return Err(RegistryError::PendingRemoval);
            }
            let entry = state
                .connections
                .get(id)
                .ok_or_else(|| RegistryError::UnknownConnection(id.to_string()))?;
            if entry.instance_id != instance_id {
                return Err(RegistryError::IdentityChangeRequiresReplacement);
            }
            entry.clone()
        };
        if let Some(token) = token {
            self.secrets.set(id, token)?;
        }
        let mut state = self.lock();
        let info = ConnectionInfo {
            id: entry.id.clone(),
            route_revision: 0,
            label: entry.label.clone(),
            kind: ConnectionKind::Remote,
            url: entry.url.clone(),
            instance_id: entry.instance_id.clone(),
            ready: true,
            problem: None,
        };
        if let Some(token) = token {
            state.credentials.insert(id.to_string(), token.to_string());
        }
        state.credential_errors.remove(id);
        state.identity.insert(id.to_string(), Identity::Verified);
        let ready = state.credentials.contains_key(id);
        Ok(ConnectionInfo {
            ready,
            problem: (!ready)
                .then(|| "No stored credential; reconnect to enter its token".to_string()),
            ..info
        })
    }

    /// Retarget: save a replacement connection with a new immutable ID and
    /// remove the old one. The caller keeps the old ID for anything already in
    /// flight; that work fails closed against a revoked route instead of
    /// silently addressing a different daemon.
    pub fn replace(
        &self,
        id: &str,
        url: &Url,
        token: &str,
        instance_id: &str,
    ) -> Result<ConnectionInfo, RegistryError> {
        if id == LOCAL_CONNECTION_ID {
            return Err(RegistryError::LocalIsBuiltIn("retargeted"));
        }
        let _mutation = self.mutation_lock();
        let (label, replacement_id) = {
            let state = self.lock();
            if state.pending_removals.contains(id) {
                return Err(RegistryError::PendingRemoval);
            }
            let label = state
                .connections
                .get(id)
                .ok_or_else(|| RegistryError::UnknownConnection(id.to_string()))?
                .label
                .clone();
            (label, mint_id(&state))
        };
        self.stage_secret_recovery(&replacement_id)?;
        if let Err(error) = self.secrets.set(&replacement_id, token) {
            let _ = self.clear_secret_recovery(&replacement_id);
            return Err(error.into());
        }

        let mut state = self.lock();
        let before = state.clone();
        state.connections.remove(id);
        state.credentials.remove(id);
        state.identity.remove(id);
        state.pending_removals.insert(id.to_string());
        state.pending_removals.remove(&replacement_id);
        state.cleanup_errors.remove(&replacement_id);
        state.credential_errors.remove(&replacement_id);
        let entry = StoredConnection {
            id: replacement_id.clone(),
            label,
            url: url.to_string(),
            instance_id: instance_id.to_string(),
            created_at: now_seconds(),
        };
        state
            .credentials
            .insert(replacement_id.clone(), token.to_string());
        state
            .identity
            .insert(replacement_id.clone(), Identity::Verified);
        state
            .connections
            .insert(replacement_id.clone(), entry.clone());
        if let Err(error) = self.persist(&state) {
            *state = before;
            drop(state);
            self.cleanup_staged_secret(&replacement_id);
            return Err(error);
        }

        drop(state);
        if let Err(error) = self.secrets.delete(id) {
            self.lock()
                .cleanup_errors
                .insert(id.to_string(), error.to_string());
            return Err(error.into());
        }
        let mut state = self.lock();
        state.pending_removals.remove(id);
        state.cleanup_errors.remove(id);
        self.persist(&state)?;
        Ok(ConnectionInfo {
            id: entry.id,
            route_revision: 0,
            label: entry.label,
            kind: ConnectionKind::Remote,
            url: entry.url,
            instance_id: entry.instance_id,
            ready: true,
            problem: None,
        })
    }

    /// Revoke, then delete. Step one drops the route and records a non-secret
    /// tombstone in a single atomic write; step two deletes the credential;
    /// step three clears the tombstone. A crash after step one resumes at open.
    pub fn remove(&self, id: &str) -> Result<(), RegistryError> {
        if id == LOCAL_CONNECTION_ID {
            return Err(RegistryError::LocalIsBuiltIn("removed"));
        }
        let _mutation = self.mutation_lock();
        {
            let mut state = self.lock();
            if !state.connections.contains_key(id) && !state.pending_removals.contains(id) {
                return Err(RegistryError::UnknownConnection(id.to_string()));
            }
            let before = state.clone();
            state.connections.remove(id);
            state.credentials.remove(id);
            state.identity.remove(id);
            state.pending_removals.insert(id.to_string());
            if let Err(error) = self.persist(&state) {
                *state = before;
                return Err(error);
            }
        }
        if let Err(error) = self.secrets.delete(id) {
            self.lock()
                .cleanup_errors
                .insert(id.to_string(), error.to_string());
            return Err(error.into());
        }
        let mut state = self.lock();
        state.pending_removals.remove(id);
        state.cleanup_errors.remove(id);
        self.persist(&state)
    }

    /// Revoke and remove every desktop-owned remote connection in one
    /// transaction. The built-in Local target and the daemon's own profile are
    /// deliberately untouched; only its desktop-local display label resets.
    pub fn reset_desktop_data(&self) -> Result<(), RegistryError> {
        let _mutation = self.mutation_lock();
        let ids = {
            let mut state = self.lock();
            let before = state.clone();
            let ids = state
                .connections
                .keys()
                .chain(state.pending_removals.iter())
                .cloned()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            state.connections.clear();
            state.credentials.clear();
            state.identity.clear();
            state.pending_removals.extend(ids.iter().cloned());
            state.local_label = default_local_label();
            if let Err(error) = self.persist(&state) {
                *state = before;
                return Err(error);
            }
            ids
        };

        let mut first_error = None;
        let mut cleaned = Vec::new();
        for id in &ids {
            match self.secrets.delete(id) {
                Ok(()) => cleaned.push(id.clone()),
                Err(error) => {
                    let message = error.to_string();
                    self.lock().cleanup_errors.insert(id.clone(), message);
                    if first_error.is_none() {
                        first_error = Some(RegistryError::Secret(error));
                    }
                }
            }
        }
        let mut state = self.lock();
        let before = state.clone();
        for id in &cleaned {
            state.pending_removals.remove(id);
            state.cleanup_errors.remove(id);
        }
        if let Err(error) = self.persist(&state) {
            *state = before;
            return Err(error);
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

fn clean_label(label: &str) -> Result<String, RegistryError> {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return Err(RegistryError::EmptyLabel);
    }
    Ok(trimmed.chars().take(120).collect())
}

fn target_is_current(state: &State, target: &Target) -> bool {
    match target.kind {
        ConnectionKind::Local => {
            target.id == LOCAL_CONNECTION_ID
                && target.route_revision == state.local_route_revision
                && state.local.as_ref().is_some_and(|profile| {
                    profile.base() == &target.base && profile.instance_id() == target.instance_id
                })
        }
        ConnectionKind::Remote => {
            target.route_revision == 0
                && !state.pending_removals.contains(&target.id)
                && state.connections.get(&target.id).is_some_and(|entry| {
                    entry.url == target.base.as_str() && entry.instance_id == target.instance_id
                })
        }
    }
}

fn mint_id(state: &State) -> String {
    loop {
        let id = new_connection_id();
        if !state.connections.contains_key(&id) && !state.pending_removals.contains(&id) {
            return id;
        }
    }
}

fn label_key(label: &str) -> String {
    label.trim().to_lowercase()
}

fn ensure_label_available(
    state: &State,
    label: &str,
    except_id: Option<&str>,
) -> Result<(), RegistryError> {
    let key = label_key(label);
    if except_id != Some(LOCAL_CONNECTION_ID) && label_key(&state.local_label) == key {
        return Err(RegistryError::DuplicateLabel(label.to_string()));
    }
    if state
        .connections
        .values()
        .any(|entry| except_id != Some(entry.id.as_str()) && label_key(&entry.label) == key)
    {
        return Err(RegistryError::DuplicateLabel(label.to_string()));
    }
    Ok(())
}

fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

/// A genuinely absent file is a fresh registry. Existing metadata fails closed
/// if it cannot be read or decoded, so corruption never silently orphans the
/// corresponding Keychain credentials.
fn read_file(path: &Path) -> Result<RegistryFile, RegistryError> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RegistryFile::default());
        }
        Err(source) => {
            return Err(RegistryError::Read {
                path: path.to_path_buf(),
                source,
            });
        }
    };
    serde_json::from_str(&raw).map_err(|source| RegistryError::Decode {
        path: path.to_path_buf(),
        source,
    })
}

fn validate_file(path: &Path, file: &RegistryFile) -> Result<(), RegistryError> {
    let invalid = |reason| RegistryError::InvalidFile {
        path: path.to_path_buf(),
        reason,
    };
    if file.version != FILE_VERSION {
        return Err(invalid("unsupported schema version"));
    }
    if !clean_label(&file.local_label).is_ok_and(|label| label == file.local_label) {
        return Err(invalid("the Local label is invalid"));
    }
    if let Some(target) = &file.local_target {
        if normalize_daemon_url(&target.url).is_err()
            || !crate::probe::is_instance_id(&target.instance_id)
        {
            return Err(invalid("the saved Local target is invalid"));
        }
    } else if file.local_route_revision != 0 {
        return Err(invalid("a Local route revision has no saved target"));
    }
    if file.connections.len() >= MAX_CONNECTIONS {
        return Err(invalid("the connection limit is exceeded"));
    }

    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::from([label_key(&file.local_label)]);
    for entry in &file.connections {
        if !is_valid_connection_id(&entry.id) || entry.id == LOCAL_CONNECTION_ID {
            return Err(invalid("a connection ID is invalid"));
        }
        if !ids.insert(entry.id.as_str()) {
            return Err(invalid("a connection ID is duplicated"));
        }
        if normalize_daemon_url(&entry.url).is_err() {
            return Err(invalid("a connection URL is invalid"));
        }
        if !clean_label(&entry.label).is_ok_and(|label| label == entry.label)
            || !names.insert(label_key(&entry.label))
        {
            return Err(invalid("a connection label is invalid or duplicated"));
        }
        if !crate::probe::is_instance_id(&entry.instance_id) {
            return Err(invalid("a daemon identity is invalid"));
        }
    }
    for id in &file.pending_removals {
        if !is_valid_connection_id(id) || id == LOCAL_CONNECTION_ID {
            return Err(invalid("a removal tombstone is invalid"));
        }
    }
    Ok(())
}

/// Write through a temporary file and rename, so a crash mid-write leaves the
/// previous complete state rather than a truncated one.
fn write_file(path: &Path, file: &RegistryFile) -> Result<(), RegistryError> {
    let persist_error = |source: std::io::Error| RegistryError::Persist {
        path: path.to_path_buf(),
        source,
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(persist_error)?;
    }
    let body = serde_json::to_vec_pretty(file)
        .map_err(|error| persist_error(std::io::Error::other(error)))?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, &body).map_err(persist_error)?;
    set_owner_only(&temporary).map_err(persist_error)?;
    std::fs::rename(&temporary, path).map_err(persist_error)
}

#[cfg(unix)]
fn set_owner_only(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_owner_only(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        is_valid_connection_id, ConnectionKind, Identity, Registry, RegistryError,
        StoredConnection, MAX_CONNECTIONS,
    };
    use crate::local::{LocalError, LocalProfile, LOCAL_CONNECTION_ID, LOCAL_CONNECTION_LABEL};
    use crate::secrets::{MemorySecretStore, SecretStore};
    use crate::urls::normalize_daemon_url;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use url::Url;

    const REMOTE_INSTANCE: &str = "00000000-0000-4000-8000-000000000001";

    struct Harness {
        _dir: tempfile::TempDir,
        path: PathBuf,
        secrets: Arc<MemorySecretStore>,
        registry: Registry,
    }

    fn remote(raw: &str) -> Url {
        normalize_daemon_url(raw).expect("test URL is valid")
    }

    fn local_profile() -> LocalProfile {
        LocalProfile::new(
            remote("http://127.0.0.1:18710"),
            "synthetic-local-token".into(),
            "00000000-0000-4000-8000-000000000002".into(),
            PathBuf::from("/synthetic/.wisp/config.json"),
        )
    }

    fn harness(with_local: bool) -> Harness {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("connections.json");
        let secrets = Arc::new(MemorySecretStore::new());
        let registry = open(&path, secrets.clone(), with_local);
        Harness {
            _dir: dir,
            path,
            secrets,
            registry,
        }
    }

    fn open(path: &Path, secrets: Arc<MemorySecretStore>, with_local: bool) -> Registry {
        let local = if with_local {
            Ok(local_profile())
        } else {
            Err(LocalError::NoProfile(PathBuf::from(
                "/synthetic/.wisp/config.json",
            )))
        };
        Registry::open(
            path.to_path_buf(),
            secrets,
            PathBuf::from("/synthetic/.wisp"),
            local,
        )
        .expect("registry opens")
    }

    #[test]
    fn ids_are_restricted_to_ascii_path_segments() {
        assert!(is_valid_connection_id("local"));
        assert!(is_valid_connection_id("c-0123456789abcdef"));
        assert!(!is_valid_connection_id(""));
        assert!(!is_valid_connection_id("has space"));
        assert!(!is_valid_connection_id("has/slash"));
        assert!(!is_valid_connection_id("has.dot"));
        assert!(!is_valid_connection_id(".."));
        assert!(!is_valid_connection_id(&"c".repeat(65)));
    }

    #[test]
    fn the_local_connection_is_built_in_renameable_and_not_removable() {
        let h = harness(true);
        let target = h
            .registry
            .resolve(LOCAL_CONNECTION_ID)
            .expect("local resolves");
        assert_eq!(target.kind, ConnectionKind::Local);
        assert_eq!(
            h.registry.credential(&target).expect("local credential"),
            "synthetic-local-token"
        );
        let renamed = h
            .registry
            .rename(LOCAL_CONNECTION_ID, "This Mac")
            .expect("local rename");
        assert_eq!(renamed.label, "This Mac");
        assert_eq!(renamed.id, LOCAL_CONNECTION_ID);
        assert!(matches!(
            h.registry.remove(LOCAL_CONNECTION_ID),
            Err(RegistryError::LocalIsBuiltIn(_))
        ));

        let reopened = open(&h.path, h.secrets.clone(), true);
        let local = reopened
            .list()
            .into_iter()
            .find(|connection| connection.id == LOCAL_CONNECTION_ID)
            .expect("local stays present");
        assert_eq!(local.label, "This Mac");
    }

    #[test]
    fn local_route_revision_survives_launches_and_rejects_the_old_generation() {
        let h = harness(true);
        assert_eq!(h.registry.list()[0].route_revision, 0);
        assert!(h.registry.resolve_route(LOCAL_CONNECTION_ID, 0).is_ok());
        let old_target = h.registry.resolve(LOCAL_CONNECTION_ID).expect("old target");

        let path = h.path.clone();
        let secrets = h.secrets.clone();
        drop(h.registry);
        let replacement = LocalProfile::new(
            remote("http://127.0.0.1:18711"),
            "synthetic-replacement-token".into(),
            "00000000-0000-4000-8000-000000000003".into(),
            PathBuf::from("/synthetic/.wisp/config.json"),
        );
        let reopened = Registry::open(
            path.clone(),
            secrets.clone(),
            PathBuf::from("/synthetic/.wisp"),
            Ok(replacement.clone()),
        )
        .expect("replacement launch opens");
        assert_eq!(reopened.list()[0].route_revision, 1);
        assert!(matches!(
            reopened.resolve_route(LOCAL_CONNECTION_ID, 0),
            Err(RegistryError::StaleRoute)
        ));
        assert!(matches!(
            reopened.credential(&old_target),
            Err(RegistryError::StaleRoute)
        ));
        assert!(reopened.resolve_route(LOCAL_CONNECTION_ID, 1).is_ok());

        drop(reopened);
        let stable = Registry::open(
            path,
            secrets,
            PathBuf::from("/synthetic/.wisp"),
            Ok(replacement),
        )
        .expect("same target reopens");
        assert_eq!(stable.list()[0].route_revision, 1);
    }

    #[test]
    fn reset_revokes_all_remotes_and_restores_the_local_label() {
        let h = harness(true);
        h.registry
            .rename(LOCAL_CONNECTION_ID, "This Mac")
            .expect("rename local");
        let first = h
            .registry
            .add_remote(
                "One",
                &remote("https://one.example.test"),
                "synthetic-token-one",
                "00000000-0000-4000-8000-000000000001",
            )
            .expect("first");
        let second = h
            .registry
            .add_remote(
                "Two",
                &remote("https://two.example.test"),
                "synthetic-token-two",
                "00000000-0000-4000-8000-000000000002",
            )
            .expect("second");

        h.registry.reset_desktop_data().expect("reset");

        assert!(h.registry.resolve(&first.id).is_none());
        assert!(h.registry.resolve(&second.id).is_none());
        assert!(h.secrets.accounts().is_empty());
        let listed = h.registry.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].label, LOCAL_CONNECTION_LABEL);
    }

    #[test]
    fn reset_retries_a_tombstone_that_predated_the_current_connections() {
        let h = harness(true);
        let orphan = "c-prior-cleanup";
        h.secrets
            .set(orphan, "synthetic-prior-token")
            .expect("seed credential");
        {
            let mut state = h.registry.lock();
            state.pending_removals.insert(orphan.to_string());
            h.registry.persist(&state).expect("persist tombstone");
        }

        h.registry
            .reset_desktop_data()
            .expect("reset retries cleanup");
        assert!(h.secrets.accounts().is_empty());
        assert!(h.registry.cleanup_issues().is_empty());
        assert!(!std::fs::read_to_string(&h.path)
            .expect("registry")
            .contains(orphan));
    }

    #[test]
    fn a_keychain_read_failure_is_connection_scoped_and_visible() {
        let h = harness(true);
        let info = h
            .registry
            .add_remote(
                "Studio",
                &remote("https://wisp.example.com"),
                "synthetic-remote-token",
                REMOTE_INSTANCE,
            )
            .expect("add");
        h.secrets.fail_next_get(&info.id);

        let reopened = open(&h.path, h.secrets.clone(), true);
        let remote = reopened
            .list()
            .into_iter()
            .find(|connection| connection.id == info.id)
            .expect("remote remains visible");
        assert!(!remote.ready);
        assert!(remote
            .problem
            .as_deref()
            .is_some_and(|problem| problem.contains("synthetic get failure")));
        assert!(reopened.resolve(LOCAL_CONNECTION_ID).is_some());
    }

    #[test]
    fn a_failed_delete_keeps_a_visible_retryable_tombstone() {
        let h = harness(true);
        let info = h
            .registry
            .add_remote(
                "Studio",
                &remote("https://wisp.example.com"),
                "synthetic-remote-token",
                REMOTE_INSTANCE,
            )
            .expect("add");
        h.secrets.fail_next_delete(&info.id);
        assert!(h.registry.remove(&info.id).is_err());
        assert!(h.registry.resolve(&info.id).is_none());
        assert_eq!(h.registry.cleanup_issues().len(), 1);

        h.registry.reset_desktop_data().expect("retry cleanup");
        assert!(h.secrets.accounts().is_empty());
        assert!(h.registry.cleanup_issues().is_empty());
    }

    #[test]
    fn failed_add_persistence_and_cleanup_cannot_orphan_the_new_account() {
        let h = harness(true);
        // The recovery-marker write succeeds; publishing the connection fails.
        h.registry.fail_persist_after(1);
        h.secrets.fail_next_delete("*");
        let error = h
            .registry
            .add_remote(
                "Studio",
                &remote("https://wisp.example.com"),
                "synthetic-remote-token",
                REMOTE_INSTANCE,
            )
            .expect_err("metadata publish fails");
        assert!(matches!(error, RegistryError::Persist { .. }));

        let accounts = h.secrets.accounts();
        assert_eq!(accounts.len(), 1);
        let account = &accounts[0];
        assert!(h.registry.resolve(account).is_none());
        assert_eq!(h.registry.cleanup_issues()[0].connection_id, *account);
        let file = std::fs::read_to_string(&h.path).expect("registry");
        assert!(file.contains(account), "the recovery tombstone is durable");

        h.registry.reset_desktop_data().expect("retry cleanup");
        assert!(h.secrets.accounts().is_empty());
    }

    #[test]
    fn failed_replace_persistence_keeps_old_route_and_tracks_new_account() {
        let h = harness(true);
        let original = h
            .registry
            .add_remote(
                "Studio",
                &remote("https://one.example.com"),
                "synthetic-old-token",
                REMOTE_INSTANCE,
            )
            .expect("original");
        h.registry.fail_persist_after(1);
        h.secrets.fail_next_delete("*");
        assert!(matches!(
            h.registry.replace(
                &original.id,
                &remote("https://two.example.com"),
                "synthetic-new-token",
                "00000000-0000-4000-8000-000000000002",
            ),
            Err(RegistryError::Persist { .. })
        ));

        assert!(h.registry.resolve(&original.id).is_some());
        assert_eq!(h.secrets.accounts().len(), 2);
        assert_eq!(h.registry.cleanup_issues().len(), 1);
        h.registry
            .reset_desktop_data()
            .expect("reset all represented accounts");
        assert!(h.secrets.accounts().is_empty());
    }

    #[test]
    fn failed_refresh_set_leaves_the_previous_credential_untouched() {
        let h = harness(true);
        let info = h
            .registry
            .add_remote(
                "Studio",
                &remote("https://wisp.example.com"),
                "synthetic-old-token",
                REMOTE_INSTANCE,
            )
            .expect("add");
        h.secrets.fail_next_set(&info.id);
        assert!(h
            .registry
            .refresh(&info.id, Some("synthetic-new-token"), REMOTE_INSTANCE)
            .is_err());
        assert_eq!(
            h.secrets.get(&info.id).expect("get").as_deref(),
            Some("synthetic-old-token")
        );
    }

    #[test]
    fn a_missing_local_profile_keeps_the_fixed_local_connection_visible() {
        let h = harness(false);
        assert!(h.registry.resolve(LOCAL_CONNECTION_ID).is_none());
        let listed = h.registry.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, LOCAL_CONNECTION_ID);
        assert!(!listed[0].ready);
        let status = h.registry.local_status();
        assert!(!status.available);
        assert!(!status.has_token);
        assert!(status.reason.is_some());
    }

    #[test]
    fn adding_stores_metadata_on_disk_and_the_token_only_in_the_credential_service() {
        let h = harness(true);
        let info = h
            .registry
            .add_remote(
                "  Studio  ",
                &remote("https://wisp.example.com"),
                "synthetic-remote-token",
                REMOTE_INSTANCE,
            )
            .expect("add");
        assert_eq!(info.label, "Studio");
        assert!(is_valid_connection_id(&info.id));
        assert!(info.ready);

        let on_disk = std::fs::read_to_string(&h.path).expect("file written");
        assert!(on_disk.contains(&info.id));
        assert!(on_disk.contains("wisp.example.com"));
        assert!(!on_disk.contains("synthetic-remote-token"));
        assert!(!on_disk.to_lowercase().contains("token"));

        assert_eq!(h.secrets.accounts(), vec![info.id.clone()]);
        let target = h.registry.resolve(&info.id).expect("resolves");
        assert_eq!(
            h.registry.credential(&target).expect("credential"),
            "synthetic-remote-token"
        );
    }

    #[test]
    fn serialized_connection_metadata_never_carries_a_secret() {
        let h = harness(true);
        let info = h
            .registry
            .add_remote(
                "Studio",
                &remote("https://wisp.example.com"),
                "synthetic-remote-token",
                REMOTE_INSTANCE,
            )
            .expect("add");
        let listed = serde_json::to_string(&h.registry.list()).expect("serializes");
        assert!(listed.contains(&info.id));
        assert!(!listed.contains("synthetic-remote-token"));
        assert!(!listed.contains("synthetic-local-token"));

        let stored = StoredConnection {
            id: info.id.clone(),
            label: info.label.clone(),
            url: info.url.clone(),
            instance_id: info.instance_id.clone(),
            created_at: 0,
        };
        let json = serde_json::to_value(&stored).expect("serializes");
        let mut keys: Vec<&str> = json
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        // The exhaustive list is the assertion: a future field cannot quietly
        // become a place a credential could live.
        assert_eq!(keys, vec!["createdAt", "id", "instanceId", "label", "url"]);
    }

    #[test]
    fn renaming_changes_only_the_label() {
        let h = harness(true);
        let info = h
            .registry
            .add_remote(
                "Studio",
                &remote("https://wisp.example.com"),
                "synthetic-remote-token",
                REMOTE_INSTANCE,
            )
            .expect("add");
        let renamed = h.registry.rename(&info.id, "Studio (EU)").expect("rename");
        assert_eq!(renamed.id, info.id);
        assert_eq!(renamed.label, "Studio (EU)");
        assert_eq!(renamed.url, info.url);
        // The Keychain account is the ID, so a rename cannot orphan a token.
        assert_eq!(h.secrets.accounts(), vec![info.id.clone()]);
        assert!(h.registry.resolve(&info.id).is_some());
        assert!(matches!(
            h.registry.rename(&info.id, "   "),
            Err(RegistryError::EmptyLabel)
        ));
    }

    #[test]
    fn names_are_unique_case_insensitively_including_local() {
        let h = harness(true);
        let first = h
            .registry
            .add_remote(
                "Studio",
                &remote("https://one.example.com"),
                "synthetic-token-one",
                REMOTE_INSTANCE,
            )
            .expect("first");
        assert!(matches!(
            h.registry.add_remote(
                "studio",
                &remote("https://two.example.com"),
                "synthetic-token-two",
                REMOTE_INSTANCE,
            ),
            Err(RegistryError::DuplicateLabel(_))
        ));
        assert!(matches!(
            h.registry.rename(&first.id, "LOCAL"),
            Err(RegistryError::DuplicateLabel(_))
        ));
        assert!(matches!(
            h.registry.rename(LOCAL_CONNECTION_ID, "studio"),
            Err(RegistryError::DuplicateLabel(_))
        ));
    }

    #[test]
    fn the_eight_connection_limit_includes_local() {
        let h = harness(true);
        for index in 0..(MAX_CONNECTIONS - 1) {
            h.registry
                .add_remote(
                    &format!("Remote {index}"),
                    &remote(&format!("https://remote-{index}.example.com")),
                    &format!("synthetic-token-{index}"),
                    REMOTE_INSTANCE,
                )
                .expect("within limit");
        }
        assert_eq!(h.registry.list().len(), MAX_CONNECTIONS);
        assert!(matches!(
            h.registry.add_remote(
                "One too many",
                &remote("https://overflow.example.com"),
                "synthetic-overflow-token",
                REMOTE_INSTANCE,
            ),
            Err(RegistryError::TooManyConnections)
        ));
    }

    #[test]
    fn retargeting_mints_a_new_id_and_revokes_the_old_route() {
        let h = harness(true);
        let original = h
            .registry
            .add_remote(
                "Studio",
                &remote("https://wisp.example.com"),
                "synthetic-remote-token",
                REMOTE_INSTANCE,
            )
            .expect("add");
        let replacement = h
            .registry
            .replace(
                &original.id,
                &remote("https://wisp-2.example.com"),
                "synthetic-replacement-token",
                REMOTE_INSTANCE,
            )
            .expect("replace");

        assert_ne!(replacement.id, original.id);
        assert_eq!(replacement.label, "Studio");
        // In-flight work holding the old ID fails closed rather than following
        // the edit onto a different daemon.
        assert!(h.registry.resolve(&original.id).is_none());
        assert_eq!(h.secrets.accounts(), vec![replacement.id.clone()]);
        let target = h.registry.resolve(&replacement.id).expect("resolves");
        assert_eq!(
            h.registry.credential(&target).expect("credential"),
            "synthetic-replacement-token"
        );
    }

    #[test]
    fn removal_revokes_the_route_then_clears_credential_and_tombstone() {
        let h = harness(true);
        let info = h
            .registry
            .add_remote(
                "Studio",
                &remote("https://wisp.example.com"),
                "synthetic-remote-token",
                REMOTE_INSTANCE,
            )
            .expect("add");
        h.registry.remove(&info.id).expect("remove");
        assert!(h.registry.resolve(&info.id).is_none());
        assert!(h.registry.list().iter().all(|c| c.id != info.id));
        assert!(h.secrets.accounts().is_empty());
        let on_disk = std::fs::read_to_string(&h.path).expect("file");
        assert!(!on_disk.contains(&info.id));
        assert!(matches!(
            h.registry.remove(&info.id),
            Err(RegistryError::UnknownConnection(_))
        ));
    }

    #[test]
    fn a_late_refresh_cannot_recreate_a_removed_credential() {
        let h = harness(true);
        let info = h
            .registry
            .add_remote(
                "Studio",
                &remote("https://wisp.example.com"),
                "synthetic-old-token",
                REMOTE_INSTANCE,
            )
            .expect("add");
        h.registry.remove(&info.id).expect("remove");

        assert!(matches!(
            h.registry
                .refresh(&info.id, Some("synthetic-new-token"), REMOTE_INSTANCE),
            Err(RegistryError::UnknownConnection(_))
        ));
        assert!(h.secrets.accounts().is_empty());
    }

    #[test]
    fn an_interrupted_removal_is_finished_at_the_next_launch() {
        let h = harness(true);
        let info = h
            .registry
            .add_remote(
                "Studio",
                &remote("https://wisp.example.com"),
                "synthetic-remote-token",
                REMOTE_INSTANCE,
            )
            .expect("add");

        // Simulate a crash after the tombstone write: the route is already gone
        // from the file, the Keychain item is not.
        let crashed = serde_json::json!({
            "version": 1,
            "connections": [],
            "pendingRemovals": [info.id],
        });
        std::fs::write(&h.path, serde_json::to_vec_pretty(&crashed).expect("json")).expect("write");
        assert_eq!(h.secrets.accounts(), vec![info.id.clone()]);

        let reopened = open(&h.path, h.secrets.clone(), true);
        assert!(reopened.resolve(&info.id).is_none());
        assert!(h.secrets.accounts().is_empty());
        let on_disk = std::fs::read_to_string(&h.path).expect("file");
        assert!(!on_disk.contains(&info.id));
    }

    #[test]
    fn a_tombstoned_connection_has_no_route_even_before_cleanup_runs() {
        let h = harness(true);
        let info = h
            .registry
            .add_remote(
                "Studio",
                &remote("https://wisp.example.com"),
                "synthetic-remote-token",
                REMOTE_INSTANCE,
            )
            .expect("add");
        // The record survives, but the tombstone is authoritative.
        let crashed = serde_json::json!({
            "version": 1,
            "connections": [{
                "id": info.id,
                "label": info.label,
                "url": info.url,
                "instanceId": info.instance_id,
                "createdAt": 0,
            }],
            "pendingRemovals": [info.id],
        });
        std::fs::write(&h.path, serde_json::to_vec_pretty(&crashed).expect("json")).expect("write");
        let reopened = open(&h.path, h.secrets.clone(), true);
        assert!(reopened.resolve(&info.id).is_none());
        assert!(reopened.list().iter().all(|c| c.id != info.id));
    }

    #[test]
    fn invalid_existing_metadata_fails_closed_instead_of_orphaning_credentials() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("connections.json");
        let poisoned = serde_json::json!({
            "version": 1,
            "connections": [
                { "id": "local", "label": "Impostor", "url": "https://evil.example.com", "instanceId": "x", "createdAt": 0 },
                { "id": "bad id", "label": "Spaces", "url": "https://wisp.example.com", "instanceId": "x", "createdAt": 0 },
                { "id": "c-plainhttp", "label": "Insecure", "url": "http://wisp.example.com", "instanceId": "x", "createdAt": 0 },
                { "id": "c-file", "label": "Scheme", "url": "file:///etc/passwd", "instanceId": "x", "createdAt": 0 },
                { "id": "c-good", "label": "Fine", "url": "https://wisp.example.com", "instanceId": "x", "createdAt": 0 }
            ],
            "pendingRemovals": []
        });
        std::fs::write(&path, serde_json::to_vec_pretty(&poisoned).expect("json")).expect("write");
        let result = Registry::open(
            path,
            Arc::new(MemorySecretStore::new()),
            PathBuf::from("/synthetic/.wisp"),
            Ok(local_profile()),
        );
        assert!(matches!(result, Err(RegistryError::InvalidFile { .. })));
    }

    #[test]
    fn malformed_existing_metadata_fails_closed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("connections.json");
        std::fs::write(&path, b"{not-json").expect("write");

        let result = Registry::open(
            path,
            Arc::new(MemorySecretStore::new()),
            PathBuf::from("/synthetic/.wisp"),
            Ok(local_profile()),
        );
        assert!(matches!(result, Err(RegistryError::Decode { .. })));
    }

    #[test]
    fn unbounded_or_non_uuid_saved_identity_fails_closed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("connections.json");
        let poisoned = serde_json::json!({
            "version": 1,
            "connections": [{
                "id": "c-valid",
                "label": "Studio",
                "url": "https://wisp.example.com",
                "instanceId": "synthetic-token-shaped-value",
                "createdAt": 0
            }],
            "pendingRemovals": []
        });
        std::fs::write(&path, serde_json::to_vec_pretty(&poisoned).expect("json")).expect("write");

        let result = Registry::open(
            path,
            Arc::new(MemorySecretStore::new()),
            PathBuf::from("/synthetic/.wisp"),
            Ok(local_profile()),
        );
        assert!(matches!(
            result,
            Err(RegistryError::InvalidFile {
                reason: "a daemon identity is invalid",
                ..
            })
        ));
    }

    #[test]
    fn a_connection_whose_credential_vanished_is_listed_but_not_ready() {
        let h = harness(true);
        let info = h
            .registry
            .add_remote(
                "Studio",
                &remote("https://wisp.example.com"),
                "synthetic-remote-token",
                REMOTE_INSTANCE,
            )
            .expect("add");
        h.secrets
            .delete(&info.id)
            .expect("delete out from under it");
        let reopened = open(&h.path, h.secrets.clone(), true);
        let listed = reopened.list();
        let entry = listed
            .iter()
            .find(|c| c.id == info.id)
            .expect("still listed");
        assert!(!entry.ready);
        let target = reopened.resolve(&info.id).expect("route exists");
        assert!(matches!(
            reopened.credential(&target),
            Err(RegistryError::MissingCredential)
        ));
    }

    #[test]
    fn identity_state_is_per_connection_and_survives_a_rename() {
        let h = harness(true);
        let info = h
            .registry
            .add_remote(
                "Studio",
                &remote("https://wisp.example.com"),
                "synthetic-remote-token",
                REMOTE_INSTANCE,
            )
            .expect("add");
        let target = h.registry.resolve(&info.id).expect("target");
        assert_eq!(
            h.registry.identity(&target).expect("current target"),
            Identity::Verified
        );
        assert_eq!(
            h.registry
                .record_probe_identity(&target, Identity::Mismatch)
                .expect("record mismatch"),
            Identity::Mismatch
        );
        assert_eq!(
            h.registry
                .record_probe_identity(&target, Identity::Verified)
                .expect("late success stays failed closed"),
            Identity::Mismatch
        );
        h.registry.rename(&info.id, "Renamed").expect("rename");
        assert_eq!(
            h.registry.identity(&target).expect("renamed target"),
            Identity::Mismatch
        );
        h.registry
            .refresh(&info.id, None, REMOTE_INSTANCE)
            .expect("explicit checked reconnect");
        assert_eq!(
            h.registry.identity(&target).expect("refreshed target"),
            Identity::Verified
        );
    }

    #[test]
    fn two_connections_keep_independent_targets_and_credentials() {
        let h = harness(true);
        let first = h
            .registry
            .add_remote(
                "One",
                &remote("https://one.example.com"),
                "synthetic-token-one",
                REMOTE_INSTANCE,
            )
            .expect("add one");
        let second = h
            .registry
            .add_remote(
                "Two",
                &remote("https://two.example.com"),
                "synthetic-token-two",
                REMOTE_INSTANCE,
            )
            .expect("add two");
        assert_ne!(first.id, second.id);

        let a = h.registry.resolve(&first.id).expect("one");
        let b = h.registry.resolve(&second.id).expect("two");
        assert_eq!(a.base.host_str(), Some("one.example.com"));
        assert_eq!(b.base.host_str(), Some("two.example.com"));
        assert_eq!(
            h.registry.credential(&a).expect("cred"),
            "synthetic-token-one"
        );
        assert_eq!(
            h.registry.credential(&b).expect("cred"),
            "synthetic-token-two"
        );

        h.registry.remove(&first.id).expect("remove one");
        assert!(h.registry.resolve(&first.id).is_none());
        assert!(h.registry.resolve(&second.id).is_some());
        assert_eq!(h.secrets.accounts(), vec![second.id]);
    }
}
