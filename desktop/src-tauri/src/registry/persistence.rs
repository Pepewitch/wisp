//! Non-secret registry persistence and metadata validation.

use std::collections::BTreeSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::local::{LocalProfile, LOCAL_CONNECTION_ID, LOCAL_CONNECTION_LABEL};
use crate::urls::normalize_daemon_url;

use super::{
    is_valid_connection_id, ConnectionInfo, ConnectionKind, Registry, RegistryError, State,
    MAX_CONNECTIONS,
};

/// Current on-disk schema version of `connections.json`.
const FILE_VERSION: u32 = 1;

pub(super) fn default_local_label() -> String {
    LOCAL_CONNECTION_LABEL.to_string()
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
pub(super) struct StoredLocalTarget {
    url: String,
    instance_id: String,
}

impl StoredLocalTarget {
    pub(super) fn from_profile(profile: &LocalProfile) -> Self {
        Self {
            url: profile.base().to_string(),
            instance_id: profile.instance_id().to_string(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RegistryFile {
    pub(super) version: u32,
    #[serde(default = "default_local_label")]
    pub(super) local_label: String,
    #[serde(default)]
    pub(super) local_target: Option<StoredLocalTarget>,
    #[serde(default)]
    pub(super) local_route_revision: u32,
    #[serde(default)]
    pub(super) connections: Vec<StoredConnection>,
    /// Non-secret removal tombstones. An ID here has already lost its route.
    #[serde(default)]
    pub(super) pending_removals: Vec<String>,
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

impl Registry {
    pub(super) fn persist(&self, state: &State) -> Result<(), RegistryError> {
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
    pub(super) fn fail_persist_after(&self, successful_calls: usize) {
        *self
            .persist_failure_countdown
            .lock()
            .expect("persist failure mutex") = Some(successful_calls);
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
}

pub(super) fn clean_label(label: &str) -> Result<String, RegistryError> {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return Err(RegistryError::EmptyLabel);
    }
    Ok(trimmed.chars().take(120).collect())
}

fn label_key(label: &str) -> String {
    label.trim().to_lowercase()
}

pub(super) fn ensure_label_available(
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

/// A genuinely absent file is a fresh registry. Existing metadata fails closed
/// if it cannot be read or decoded, so corruption never silently orphans the
/// corresponding Keychain credentials.
pub(super) fn read_file(path: &Path) -> Result<RegistryFile, RegistryError> {
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

pub(super) fn validate_file(path: &Path, file: &RegistryFile) -> Result<(), RegistryError> {
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
pub(super) fn write_file(path: &Path, file: &RegistryFile) -> Result<(), RegistryError> {
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
