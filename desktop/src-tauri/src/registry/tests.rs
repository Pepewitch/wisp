use super::{
    is_valid_connection_id, ConnectionKind, Identity, Registry, RegistryError, StoredConnection,
    MAX_CONNECTIONS,
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
