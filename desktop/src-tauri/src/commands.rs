//! The Tauri invoke surface.
//!
//! Seven commands, and between them no way for JavaScript to name a daemon
//! address, read a credential, or reach the filesystem. A command either
//! returns non-secret metadata or performs a native action and returns a
//! sentence about it.

use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::core::{Bootstrap, CoreError, DesktopCore};
use crate::registry::ConnectionInfo;
use crate::setup::LocalSetupReport;

/// Hand the webview its per-launch proxy base and the non-secret connection
/// list. Called once, before the shared React app mounts.
#[tauri::command]
pub fn desktop_bootstrap(core: State<'_, DesktopCore>) -> Bootstrap {
    core.bootstrap()
}

/// Test, then save. The capability check runs before anything is written, so a
/// connection that exists is a connection that answered.
#[tauri::command]
pub async fn add_remote_connection(
    core: State<'_, DesktopCore>,
    label: String,
    url: String,
    token: String,
) -> Result<ConnectionInfo, CoreError> {
    core.add_remote(&label, &url, &token).await
}

/// Change a display label. IDs, routes, cache scopes, and Keychain accounts are
/// untouched by design.
#[tauri::command]
pub fn rename_connection(
    core: State<'_, DesktopCore>,
    connection_id: String,
    label: String,
) -> Result<ConnectionInfo, CoreError> {
    core.rename(&connection_id, &label)
}

/// Re-prove a connection. A changed URL returns a connection with a *new* ID;
/// the caller must treat it as a replacement rather than an update.
#[tauri::command]
pub async fn reconnect_connection(
    core: State<'_, DesktopCore>,
    connection_id: String,
    url: Option<String>,
    token: Option<String>,
) -> Result<ConnectionInfo, CoreError> {
    core.reconnect(&connection_id, url.as_deref(), token.as_deref())
        .await
}

/// Revoke the route, delete the credential, forget the metadata.
#[tauri::command]
pub fn remove_connection(
    core: State<'_, DesktopCore>,
    connection_id: String,
) -> Result<(), CoreError> {
    core.remove(&connection_id)
}

/// Native folder picker for "add a project". The webview has no filesystem
/// capability of its own; this returns a path string and nothing more.
#[tauri::command]
pub async fn pick_local_project(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |picked| {
        let _ = send.send(picked);
    });
    let picked = receive
        .await
        .map_err(|_| "the folder picker closed unexpectedly".to_string())?;
    Ok(picked.and_then(|path| path.into_path().ok().map(|p| p.display().to_string())))
}

/// Report on the local Wisp install. Reports only — see `setup.rs`.
#[tauri::command]
pub async fn setup_local_wisp(core: State<'_, DesktopCore>) -> Result<LocalSetupReport, CoreError> {
    Ok(core.local_setup().await)
}
