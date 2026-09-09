//! The Tauri invoke surface.
//!
//! The narrow command boundary gives JavaScript no way to read a credential or
//! select an arbitrary proxy target. Commands return non-secret metadata or
//! perform one explicit native action.

use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::core::{Bootstrap, CoreError, DesktopCore};
use crate::notifications::{self, TaskNotification};
use crate::probe::DaemonIdentity;
use crate::registry::ConnectionInfo;
use crate::setup::{LocalSetupReport, NextStep};
use crate::updater::{DesktopUpdateError, DesktopUpdateStatus, DesktopUpdater};

/// Hand the webview its per-launch proxy base and the non-secret connection
/// list. Called once, before the shared React app mounts.
#[tauri::command]
pub fn desktop_bootstrap(core: State<'_, DesktopCore>) -> Bootstrap {
    core.bootstrap()
}

/// Keep native-only UI capabilities scoped to the selected connection. Proxy
/// routing remains explicitly connection-qualified and never uses this state.
#[tauri::command]
pub fn select_desktop_connection(
    core: State<'_, DesktopCore>,
    connection_id: String,
) -> Result<(), CoreError> {
    core.select_connection(&connection_id)
}

/// Test, then save. The capability check runs before anything is written, so a
/// connection that exists is a connection that answered.
#[tauri::command]
pub async fn add_remote_connection(
    core: State<'_, DesktopCore>,
    name: String,
    url: String,
    token: String,
    expected_instance_id: String,
) -> Result<ConnectionInfo, CoreError> {
    core.add_remote_checked(&name, &url, &token, Some(&expected_instance_id))
        .await
}

/// Authenticated preview. Nothing is persisted until add re-proves this exact
/// instance identity after the user confirms it.
#[tauri::command]
pub async fn probe_remote_connection(
    core: State<'_, DesktopCore>,
    url: String,
    token: String,
) -> Result<DaemonIdentity, CoreError> {
    core.probe_remote(&url, &token).await
}

/// Change a display label. IDs, routes, cache scopes, and Keychain accounts are
/// untouched by design.
#[tauri::command]
pub fn rename_connection(
    core: State<'_, DesktopCore>,
    connection_id: String,
    name: String,
) -> Result<ConnectionInfo, CoreError> {
    core.rename(&connection_id, &name)
}

/// Re-prove a connection. A changed URL returns a connection with a *new* ID;
/// the caller must treat it as a replacement rather than an update.
#[tauri::command]
pub async fn reconnect_connection(
    core: State<'_, DesktopCore>,
    connection_id: String,
    url: Option<String>,
    token: Option<String>,
    expected_instance_id: Option<String>,
) -> Result<ConnectionInfo, CoreError> {
    core.reconnect_checked(
        &connection_id,
        url.as_deref(),
        token.as_deref(),
        expected_instance_id.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn probe_saved_connection(
    core: State<'_, DesktopCore>,
    connection_id: String,
    url: Option<String>,
    token: Option<String>,
) -> Result<DaemonIdentity, CoreError> {
    core.probe_reconnect(&connection_id, url.as_deref(), token.as_deref())
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

/// Remove all desktop-owned remote metadata and credentials. The local Wisp
/// profile, daemon service, projects, tasks, and worktrees are untouched.
#[tauri::command]
pub fn reset_desktop_data(core: State<'_, DesktopCore>) -> Result<(), CoreError> {
    core.reset_desktop_data()
}

/// Native folder picker for "add a project". The webview has no filesystem
/// capability of its own; this returns a path string and nothing more.
#[tauri::command]
pub async fn pick_local_project(
    app: tauri::AppHandle,
    core: State<'_, DesktopCore>,
    connection_id: String,
) -> Result<Option<String>, String> {
    let generation = core
        .begin_local_picker(&connection_id)
        .map_err(|error| error.to_string())?;
    let (send, receive) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |picked| {
        let _ = send.send(picked);
    });
    let picked = receive
        .await
        .map_err(|_| "the folder picker closed unexpectedly".to_string())?;
    core.finish_local_picker(generation)
        .map_err(|error| error.to_string())?;
    Ok(picked.and_then(|path| path.into_path().ok().map(|p| p.display().to_string())))
}

/// Report on the local Wisp install without changing it.
#[tauri::command]
pub async fn setup_local_wisp(core: State<'_, DesktopCore>) -> Result<LocalSetupReport, CoreError> {
    core.local_setup().await
}

/// Execute the exact setup action returned by `setup_local_wisp`, after a
/// separate user confirmation in the webview.
#[tauri::command]
pub async fn apply_local_wisp_setup(
    core: State<'_, DesktopCore>,
    expected_step: NextStep,
) -> Result<LocalSetupReport, CoreError> {
    core.apply_local_setup(expected_step).await
}

/// Open a web link in the machine's browser.
///
/// Connection-independent: a link in a task's prose belongs to the internet,
/// not to the daemon that reported it, so this takes no connection ID and
/// reads no native connection state. `external` decides what may open.
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), CoreError> {
    Ok(crate::external::open(&url)?)
}

/// Post one macOS notification for a task the shared UI watched stop running.
///
/// The UI owns the decision and the words; native code checks that the
/// connection is a saved one (its ID travels back on a click and becomes
/// routing input), bounds the text, and refuses outside a packaged bundle.
#[tauri::command]
pub async fn notify_task_transition(
    core: State<'_, DesktopCore>,
    notification: TaskNotification,
) -> Result<(), String> {
    let notification = notification
        .validated()
        .map_err(|error| error.to_string())?;
    if !core.knows_connection(&notification.connection_id) {
        return Err(format!("unknown connection {}", notification.connection_id));
    }
    notifications::deliver(&notification).map_err(|error| error.to_string())
}

/// Return application-update state without performing network I/O.
#[tauri::command]
pub fn desktop_update_status(updater: State<'_, DesktopUpdater>) -> DesktopUpdateStatus {
    updater.status()
}

/// Resolve the one embedded release channel. No caller-controlled endpoint is
/// accepted at this boundary.
#[tauri::command]
pub async fn check_desktop_update(
    app: tauri::AppHandle,
    updater: State<'_, DesktopUpdater>,
) -> Result<DesktopUpdateStatus, DesktopUpdateError> {
    updater.check(&app).await
}

/// Install only the version returned by the most recent native check. The
/// string is a stale-confirmation guard, never a release selector.
#[tauri::command]
pub async fn install_desktop_update(
    app: tauri::AppHandle,
    updater: State<'_, DesktopUpdater>,
    confirmed_version: String,
) -> Result<DesktopUpdateStatus, DesktopUpdateError> {
    updater.download_and_install(&app, &confirmed_version).await
}

/// Relaunch only after the native installer reached its completed state.
#[tauri::command]
pub fn relaunch_desktop(
    app: tauri::AppHandle,
    updater: State<'_, DesktopUpdater>,
) -> Result<(), DesktopUpdateError> {
    updater.relaunch(&app)
}

/// Reveal one file of a Local task's worktree in Finder.
///
/// Local only, like the folder picker: a remote daemon's paths are not on this
/// machine. Reveal, never open — nothing here can run a file.
#[tauri::command]
pub fn reveal_worktree_file(
    core: State<'_, DesktopCore>,
    connection_id: String,
    worktree_path: String,
    path: String,
) -> Result<(), CoreError> {
    core.reveal_local_file(&connection_id, &worktree_path, &path)
}

/// Save a bounded conversation snapshot only to a destination the user picks.
#[tauri::command]
pub async fn save_task_export(
    app: tauri::AppHandle,
    task_id: String,
    data: String,
) -> Result<bool, String> {
    crate::task_export::validate(&task_id, &data)?;
    let (send, receive) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(format!("wisp-task-{task_id}.json"))
        .add_filter("Task export", &["json"])
        .save_file(move |picked| {
            let _ = send.send(picked);
        });
    let Some(path) = receive
        .await
        .map_err(|_| "The Save panel closed unexpectedly. Retry export.".to_string())?
    else {
        return Ok(false);
    };
    let path = path
        .into_path()
        .map_err(|_| "Choose a local file destination.".to_string())?;
    tokio::task::spawn_blocking(move || crate::task_export::save(&path, &data))
        .await
        .map_err(|_| "Export could not finish. Retry saving.".to_string())??;
    Ok(true)
}
