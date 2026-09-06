//! Where a remote daemon token lives: the macOS Keychain, and nowhere else.
//!
//! Not the connection file, not a preference, not the webview's storage, not a
//! log line. The registry file next to it holds only non-secret metadata, which
//! is what lets removal be crash-safe without ever writing a token to a
//! tombstone.

use std::collections::HashMap;
use std::sync::Mutex;

/// Keychain service name. Accounts under it are connection IDs, which are
/// immutable, so a rename never orphans a credential.
pub const KEYCHAIN_SERVICE: &str = "dev.wisp.desktop.connection";

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("macOS Keychain refused the request: {0}")]
    Keychain(String),
    #[error("the stored credential is not valid UTF-8")]
    NotUtf8,
}

/// The credential service seam. Production uses the Keychain; tests use
/// [`MemorySecretStore`] so a `cargo test` run never prompts for, reads, or
/// writes a real login-keychain item.
pub trait SecretStore: Send + Sync {
    fn set(&self, account: &str, secret: &str) -> Result<(), SecretError>;
    fn get(&self, account: &str) -> Result<Option<String>, SecretError>;
    /// Deleting an absent credential succeeds: removal must be replayable.
    fn delete(&self, account: &str) -> Result<(), SecretError>;
}

/// macOS Keychain generic passwords, via Security.framework.
pub struct KeychainSecretStore {
    service: String,
}

impl KeychainSecretStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }
}

impl Default for KeychainSecretStore {
    fn default() -> Self {
        Self::new(KEYCHAIN_SERVICE)
    }
}

/// `errSecItemNotFound` — the only Keychain failure that is a normal answer
/// rather than a problem.
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

impl SecretStore for KeychainSecretStore {
    fn set(&self, account: &str, secret: &str) -> Result<(), SecretError> {
        security_framework::passwords::set_generic_password(
            &self.service,
            account,
            secret.as_bytes(),
        )
        .map_err(|error| SecretError::Keychain(error.to_string()))
    }

    fn get(&self, account: &str) -> Result<Option<String>, SecretError> {
        match security_framework::passwords::get_generic_password(&self.service, account) {
            Ok(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| SecretError::NotUtf8),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(error) => Err(SecretError::Keychain(error.to_string())),
        }
    }

    fn delete(&self, account: &str) -> Result<(), SecretError> {
        match security_framework::passwords::delete_generic_password(&self.service, account) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(error) => Err(SecretError::Keychain(error.to_string())),
        }
    }
}

/// Test and integration double for [`KeychainSecretStore`].
///
/// Public because the crate's integration tests live outside the library and
/// must be able to exercise registry and proxy behavior without touching the
/// developer's login keychain.
#[derive(Default)]
pub struct MemorySecretStore {
    entries: Mutex<HashMap<String, String>>,
    fail_get: Mutex<HashMap<String, usize>>,
    fail_set: Mutex<HashMap<String, usize>>,
    fail_delete: Mutex<HashMap<String, usize>>,
}

impl MemorySecretStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Accounts that still hold a credential — the assertion a removal test needs.
    pub fn accounts(&self) -> Vec<String> {
        let entries = self.entries.lock().expect("secret store mutex");
        let mut accounts: Vec<String> = entries.keys().cloned().collect();
        accounts.sort();
        accounts
    }

    #[doc(hidden)]
    pub fn fail_next_get(&self, account: &str) {
        *self
            .fail_get
            .lock()
            .expect("failure mutex")
            .entry(account.to_string())
            .or_default() += 1;
    }

    #[doc(hidden)]
    pub fn fail_next_set(&self, account: &str) {
        *self
            .fail_set
            .lock()
            .expect("failure mutex")
            .entry(account.to_string())
            .or_default() += 1;
    }

    #[doc(hidden)]
    pub fn fail_next_delete(&self, account: &str) {
        *self
            .fail_delete
            .lock()
            .expect("failure mutex")
            .entry(account.to_string())
            .or_default() += 1;
    }

    fn should_fail(failures: &Mutex<HashMap<String, usize>>, account: &str) -> bool {
        let mut failures = failures.lock().expect("failure mutex");
        let key = if failures.contains_key(account) {
            account
        } else {
            "*"
        };
        let Some(remaining) = failures.get_mut(key) else {
            return false;
        };
        *remaining -= 1;
        if *remaining == 0 {
            failures.remove(key);
        }
        true
    }
}

impl SecretStore for MemorySecretStore {
    fn set(&self, account: &str, secret: &str) -> Result<(), SecretError> {
        if Self::should_fail(&self.fail_set, account) {
            return Err(SecretError::Keychain("synthetic set failure".to_string()));
        }
        self.entries
            .lock()
            .expect("secret store mutex")
            .insert(account.to_string(), secret.to_string());
        Ok(())
    }

    fn get(&self, account: &str) -> Result<Option<String>, SecretError> {
        if Self::should_fail(&self.fail_get, account) {
            return Err(SecretError::Keychain("synthetic get failure".to_string()));
        }
        Ok(self
            .entries
            .lock()
            .expect("secret store mutex")
            .get(account)
            .cloned())
    }

    fn delete(&self, account: &str) -> Result<(), SecretError> {
        if Self::should_fail(&self.fail_delete, account) {
            return Err(SecretError::Keychain(
                "synthetic delete failure".to_string(),
            ));
        }
        self.entries
            .lock()
            .expect("secret store mutex")
            .remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{MemorySecretStore, SecretStore};

    #[test]
    fn round_trips_and_forgets() {
        let store = MemorySecretStore::new();
        assert_eq!(store.get("c1").expect("get"), None);
        store.set("c1", "synthetic-token").expect("set");
        assert_eq!(
            store.get("c1").expect("get").as_deref(),
            Some("synthetic-token")
        );
        store.delete("c1").expect("delete");
        assert_eq!(store.get("c1").expect("get"), None);
    }

    #[test]
    fn deleting_an_absent_credential_is_not_an_error() {
        let store = MemorySecretStore::new();
        store.delete("never-existed").expect("idempotent delete");
    }
}
