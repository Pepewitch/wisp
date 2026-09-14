//! Connection route generations and pinned daemon identity state.

use serde::{Deserialize, Serialize};
use url::Url;

use crate::local::{LocalProfile, LOCAL_CONNECTION_ID};
use crate::urls::normalize_daemon_url;

use super::persistence::StoredLocalTarget;
use super::{ConnectionInfo, Registry, RegistryError, State};

/// Connection IDs are ASCII path segments — they appear literally in proxy
/// routes and in query-cache keys, so anything needing encoding is out.
pub fn is_valid_connection_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionKind {
    Local,
    Remote,
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

impl Registry {
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
}

pub(super) fn target_is_current(state: &State, target: &Target) -> bool {
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
