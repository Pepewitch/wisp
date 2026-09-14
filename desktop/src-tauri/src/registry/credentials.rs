//! Keychain-backed credential lifecycle and revocation transactions.

use std::collections::{BTreeSet, HashMap};

use serde::Serialize;
use url::Url;

use crate::local::LOCAL_CONNECTION_ID;

use super::persistence::{
    clean_label, default_local_label, ensure_label_available, StoredConnection,
};
use super::routes::{target_is_current, ConnectionKind, Identity, Target};
use super::{ConnectionInfo, Registry, RegistryError, State, MAX_CONNECTIONS};

/// A fresh remote ID. Opaque on purpose: nothing may parse meaning out of it.
fn new_connection_id() -> String {
    format!("c-{}", crate::random::random_hex(12))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupIssue {
    pub connection_id: String,
    pub message: String,
}

impl Registry {
    /// Resume removals that a crash interrupted between the tombstone write and
    /// the credential delete. Deleting an absent credential is a no-op, so this
    /// is safe to run on every launch.
    pub(super) fn finish_pending_removals(&self) -> Result<(), RegistryError> {
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

    pub(super) fn warm_credentials(&self) {
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

fn mint_id(state: &State) -> String {
    loop {
        let id = new_connection_id();
        if !state.connections.contains_key(&id) && !state.pending_removals.contains(&id) {
            return id;
        }
    }
}

fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}
