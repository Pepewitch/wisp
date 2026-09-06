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
    #[error("that connection is being removed")]
    PendingRemoval,
    #[error("the built-in local connection cannot be {0}")]
    LocalIsBuiltIn(&'static str),
    #[error("a label is required")]
    EmptyLabel,
    #[error("a connection named {0} already exists")]
    DuplicateLabel(String),
    #[error("Wisp Desktop supports at most {MAX_CONNECTIONS} connections")]
    TooManyConnections,
    #[error("no credential is stored for this connection — reconnect to enter its token")]
    MissingCredential,
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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryFile {
    version: u32,
    #[serde(default = "default_local_label")]
    local_label: String,
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
    #[serde(rename = "name")]
    pub label: String,
    pub kind: ConnectionKind,
    /// Display address. Non-secret: the user typed it, or it is loopback.
    pub url: String,
    pub instance_id: String,
    /// False when the credential or local profile is gone and the connection
    /// needs attention before it will serve traffic.
    pub ready: bool,
}

/// A resolved proxy target. Produced only by the registry, never by a request.
#[derive(Debug, Clone)]
pub struct Target {
    pub id: String,
    pub kind: ConnectionKind,
    pub base: Url,
    pub instance_id: String,
}

/// Result of the pinned-identity check performed before the first write.
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
    identity: HashMap<String, Identity>,
}

/// The native connection registry.
pub struct Registry {
    path: PathBuf,
    secrets: Arc<dyn SecretStore>,
    local_home: PathBuf,
    /// Serializes metadata/Keychain transactions without blocking proxy reads.
    mutations: Mutex<()>,
    state: Mutex<State>,
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
        let file = read_file(&path)?;
        validate_file(&path, &file)?;
        let (local_profile, local_error) = match local {
            Ok(profile) => (Some(profile), None),
            Err(error) => (None, Some(error.to_string())),
        };

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
                identity: HashMap::new(),
            }),
        };
        registry.finish_pending_removals()?;
        registry.warm_credentials()?;
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
        for id in &pending {
            self.secrets.delete(id)?;
        }
        let mut state = self.lock();
        for id in &pending {
            state.pending_removals.remove(id);
            state.connections.remove(id);
        }
        self.persist(&state)
    }

    fn warm_credentials(&self) -> Result<(), RegistryError> {
        let ids: Vec<String> = {
            let state = self.lock();
            state.connections.keys().cloned().collect()
        };
        let mut found = HashMap::new();
        for id in ids {
            if let Some(secret) = self.secrets.get(&id)? {
                found.insert(id, secret);
            }
        }
        self.lock().credentials.extend(found);
        Ok(())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("registry mutex")
    }

    fn mutation_lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.mutations.lock().expect("registry mutation mutex")
    }

    fn persist(&self, state: &State) -> Result<(), RegistryError> {
        let file = RegistryFile {
            version: FILE_VERSION,
            local_label: state.local_label.clone(),
            connections: state.connections.values().cloned().collect(),
            pending_removals: state.pending_removals.iter().cloned().collect(),
        };
        write_file(&self.path, &file)
    }

    /// Non-secret metadata for every connection, local first.
    pub fn list(&self) -> Vec<ConnectionInfo> {
        let state = self.lock();
        let mut out = Vec::with_capacity(state.connections.len() + 1);
        out.push(match &state.local {
            Some(profile) => ConnectionInfo {
                id: LOCAL_CONNECTION_ID.to_string(),
                label: state.local_label.clone(),
                kind: ConnectionKind::Local,
                url: profile.base().to_string(),
                instance_id: profile.instance_id().to_string(),
                ready: true,
            },
            None => ConnectionInfo {
                id: LOCAL_CONNECTION_ID.to_string(),
                label: state.local_label.clone(),
                kind: ConnectionKind::Local,
                url: String::new(),
                instance_id: String::new(),
                ready: false,
            },
        });
        for entry in state.connections.values() {
            if state.pending_removals.contains(&entry.id) {
                continue;
            }
            out.push(ConnectionInfo {
                id: entry.id.clone(),
                label: entry.label.clone(),
                kind: ConnectionKind::Remote,
                url: entry.url.clone(),
                instance_id: entry.instance_id.clone(),
                ready: state.credentials.contains_key(&entry.id),
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

    /// Replace the in-memory Local profile after an authenticated reconnect.
    /// The source of truth remains `~/.wisp/config.json`; only the mutable
    /// launch snapshot and identity state change here.
    pub fn refresh_local(&self, profile: LocalProfile) -> ConnectionInfo {
        let _mutation = self.mutation_lock();
        let mut state = self.lock();
        let info = ConnectionInfo {
            id: LOCAL_CONNECTION_ID.to_string(),
            label: state.local_label.clone(),
            kind: ConnectionKind::Local,
            url: profile.base().to_string(),
            instance_id: profile.instance_id().to_string(),
            ready: true,
        };
        state.local = Some(profile);
        state.local_error = None;
        state
            .identity
            .insert(LOCAL_CONNECTION_ID.to_string(), Identity::Verified);
        info
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
            kind: ConnectionKind::Remote,
            base,
            instance_id: entry.instance_id.clone(),
        })
    }

    /// The bearer token for a resolved target. Never returned to the webview:
    /// the only caller is the proxy's upstream request builder.
    pub fn credential(&self, target: &Target) -> Result<String, RegistryError> {
        let state = self.lock();
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

    pub fn identity(&self, id: &str) -> Identity {
        self.lock()
            .identity
            .get(id)
            .copied()
            .unwrap_or(Identity::Unchecked)
    }

    pub fn set_identity(&self, id: &str, value: Identity) {
        self.lock().identity.insert(id.to_string(), value);
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
        // Credential first: a saved connection with no credential is broken.
        // The mutation lock prevents another command racing this transaction,
        // while proxy reads remain free to use the independent state lock.
        self.secrets.set(&id, token)?;
        let entry = StoredConnection {
            id: id.clone(),
            label,
            url: url.to_string(),
            instance_id: instance_id.to_string(),
            created_at: now_seconds(),
        };
        let mut state = self.lock();
        state.credentials.insert(id.clone(), token.to_string());
        state.identity.insert(id.clone(), Identity::Verified);
        state.connections.insert(id.clone(), entry.clone());
        if let Err(error) = self.persist(&state) {
            state.credentials.remove(&id);
            state.identity.remove(&id);
            state.connections.remove(&id);
            drop(state);
            let _ = self.secrets.delete(&id);
            return Err(error);
        }
        Ok(ConnectionInfo {
            id: entry.id,
            label: entry.label,
            kind: ConnectionKind::Remote,
            url: entry.url,
            instance_id: entry.instance_id,
            ready: true,
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
        let entry = state
            .connections
            .get_mut(id)
            .ok_or_else(|| RegistryError::UnknownConnection(id.to_string()))?;
        entry.label = label;
        let info = ConnectionInfo {
            id: entry.id.clone(),
            label: entry.label.clone(),
            kind: ConnectionKind::Remote,
            url: entry.url.clone(),
            instance_id: entry.instance_id.clone(),
            ready: state.credentials.contains_key(id),
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
        let previous_credential = {
            let state = self.lock();
            if state.pending_removals.contains(id) {
                return Err(RegistryError::PendingRemoval);
            }
            if !state.connections.contains_key(id) {
                return Err(RegistryError::UnknownConnection(id.to_string()));
            }
            state.credentials.get(id).cloned()
        };
        if let Some(token) = token {
            self.secrets.set(id, token)?;
        }
        let mut state = self.lock();
        let before = state.clone();
        let entry = state
            .connections
            .get_mut(id)
            .expect("the mutation lock keeps the validated connection present");
        entry.instance_id = instance_id.to_string();
        let info = ConnectionInfo {
            id: entry.id.clone(),
            label: entry.label.clone(),
            kind: ConnectionKind::Remote,
            url: entry.url.clone(),
            instance_id: entry.instance_id.clone(),
            ready: true,
        };
        if let Some(token) = token {
            state.credentials.insert(id.to_string(), token.to_string());
        }
        state.identity.insert(id.to_string(), Identity::Verified);
        if let Err(error) = self.persist(&state) {
            *state = before;
            drop(state);
            if token.is_some() {
                match previous_credential {
                    Some(previous) => self.secrets.set(id, &previous)?,
                    None => self.secrets.delete(id)?,
                }
            }
            return Err(error);
        }
        Ok(info)
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
        self.secrets.set(&replacement_id, token)?;

        let mut state = self.lock();
        let before = state.clone();
        state.connections.remove(id);
        state.credentials.remove(id);
        state.identity.remove(id);
        state.pending_removals.insert(id.to_string());
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
            let _ = self.secrets.delete(&replacement_id);
            return Err(error);
        }

        drop(state);
        self.secrets.delete(id)?;
        let mut state = self.lock();
        state.pending_removals.remove(id);
        self.persist(&state)?;
        Ok(ConnectionInfo {
            id: entry.id,
            label: entry.label,
            kind: ConnectionKind::Remote,
            url: entry.url,
            instance_id: entry.instance_id,
            ready: true,
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
        self.secrets.delete(id)?;
        let mut state = self.lock();
        state.pending_removals.remove(id);
        self.persist(&state)
    }
}

fn clean_label(label: &str) -> Result<String, RegistryError> {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return Err(RegistryError::EmptyLabel);
    }
    Ok(trimmed.chars().take(120).collect())
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
        if entry.instance_id.trim().is_empty() {
            return Err(invalid("a daemon identity is missing"));
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
    use crate::local::{LocalError, LocalProfile, LOCAL_CONNECTION_ID};
    use crate::secrets::{MemorySecretStore, SecretStore};
    use crate::urls::normalize_daemon_url;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use url::Url;

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
            "wisp-instance-local".into(),
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
                "wisp-instance-remote",
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
                "wisp-instance-remote",
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
                "wisp-instance-remote",
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
                "wisp-instance-one",
            )
            .expect("first");
        assert!(matches!(
            h.registry.add_remote(
                "studio",
                &remote("https://two.example.com"),
                "synthetic-token-two",
                "wisp-instance-two",
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
                    &format!("wisp-instance-{index}"),
                )
                .expect("within limit");
        }
        assert_eq!(h.registry.list().len(), MAX_CONNECTIONS);
        assert!(matches!(
            h.registry.add_remote(
                "One too many",
                &remote("https://overflow.example.com"),
                "synthetic-overflow-token",
                "wisp-instance-overflow",
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
                "wisp-instance-remote",
            )
            .expect("add");
        let replacement = h
            .registry
            .replace(
                &original.id,
                &remote("https://wisp-2.example.com"),
                "synthetic-replacement-token",
                "wisp-instance-remote-2",
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
                "wisp-instance-remote",
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
                "wisp-instance-old",
            )
            .expect("add");
        h.registry.remove(&info.id).expect("remove");

        assert!(matches!(
            h.registry
                .refresh(&info.id, Some("synthetic-new-token"), "wisp-instance-new"),
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
                "wisp-instance-remote",
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
                "wisp-instance-remote",
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
    fn a_connection_whose_credential_vanished_is_listed_but_not_ready() {
        let h = harness(true);
        let info = h
            .registry
            .add_remote(
                "Studio",
                &remote("https://wisp.example.com"),
                "synthetic-remote-token",
                "wisp-instance-remote",
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
                "wisp-instance-remote",
            )
            .expect("add");
        assert_eq!(h.registry.identity(&info.id), Identity::Verified);
        h.registry.set_identity(&info.id, Identity::Mismatch);
        assert_eq!(h.registry.identity(&info.id), Identity::Mismatch);
        h.registry.rename(&info.id, "Renamed").expect("rename");
        assert_eq!(h.registry.identity(&info.id), Identity::Mismatch);
        assert_eq!(h.registry.identity("c-never-seen"), Identity::Unchecked);
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
                "wisp-instance-one",
            )
            .expect("add one");
        let second = h
            .registry
            .add_remote(
                "Two",
                &remote("https://two.example.com"),
                "synthetic-token-two",
                "wisp-instance-two",
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
