//! Native core for the Wisp desktop shell.
//!
//! The desktop application manages several independent Wisp daemons from one
//! webview running the same React bundle the browser build serves. Everything
//! that makes that safe lives here rather than in JavaScript:
//!
//! * [`proxy`] — a loopback, connection-qualified proxy for REST, SSE,
//!   WebSocket terminals, and attachment bytes. It is the only path to a
//!   daemon, and it is where credentials are attached.
//! * [`registry`] — immutable connection IDs, non-secret metadata on disk, and
//!   crash-safe removal.
//! * [`secrets`] — remote tokens in the macOS Keychain, nowhere else.
//! * [`local`] — the built-in Local connection, read from the standard Wisp
//!   profile into native memory and never handed to JavaScript.
//! * [`external`] — the one action that leaves the app: opening a web link in
//!   the machine's browser, which the webview cannot do by itself.
//! * [`navigation`] — what the shell's own webview may navigate to, and what
//!   goes to the browser instead.
//! * [`notifications`] — macOS task notifications and the click that brings
//!   the window back to the task that finished.
//! * [`updater`] — fixed-channel signed application discovery, installation,
//!   status, and explicit relaunch.
//!
//! `docs/DESKTOP-TRANSPORT.md` states the contract these modules implement.

pub mod capability;
pub mod commands;
pub mod core;
pub mod external;
pub mod local;
pub mod navigation;
pub mod notifications;
pub mod output_image;
pub mod probe;
pub mod proxy;
pub mod random;
pub mod registry;
pub mod secrets;
pub mod setup;
pub mod task_export;
pub mod updater;
pub mod urls;
mod window_launch;

use std::sync::Arc;

use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::core::DesktopCore;
use crate::navigation::{Navigation, NavigationPolicy};
use crate::secrets::KeychainSecretStore;

/// The resolved configuration plus the exact documents the packaged webview
/// loads, after Tauri's compile-time rewrite of the shared React bundle.
///
/// Named rather than inlined into [`run`] because that rewrite is a silent
/// behavior change to a bundle the daemon also serves unmodified: it stamps a
/// CSP nonce onto stylesheets, and a nonce is what makes `'unsafe-inline'`
/// stop applying. `tests/webview.rs` asserts what the shell will actually be
/// served; see the webview content policy in `desktop/README.md`.
pub fn context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

/// Boot the shell: open native state, bind the proxy, then show the window.
///
/// Startup is fail-closed. If the registry cannot be opened or the loopback
/// listener cannot bind, there is no safe degraded mode — a window with no
/// transport would just fail every request with a confusing error. So the
/// window is built here, after the transport exists (`tauri.conf.json` marks
/// it `create: false`), and a startup failure is a native message naming the
/// problem, then a clean exit, never a window and never an unexplained crash.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(updater::plugin())
        .setup(|app| {
            let config_dir = match start(app) {
                Ok(config_dir) => config_dir,
                Err(error) => {
                    refuse_to_start(app.handle(), &error.to_string());
                    return Ok(());
                }
            };
            // Must run on the main thread before any notification is posted;
            // `setup` is the one place Tauri guarantees both.
            if !notifications::install(app.handle().clone()) {
                eprintln!(
                    "[wisp-desktop] task notifications are off: this process is not a bundled Wisp.app"
                );
            }
            app.manage(updater::DesktopUpdater::default());
            window_launch::focus_new_version(app.handle(), &config_dir);
            if let Some(recovery) = app.state::<DesktopCore>().registry().recovery() {
                report_registry_recovery(app.handle(), recovery);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::desktop_bootstrap,
            commands::select_desktop_connection,
            commands::probe_remote_connection,
            commands::add_remote_connection,
            commands::rename_connection,
            commands::probe_saved_connection,
            commands::reconnect_connection,
            commands::remove_connection,
            commands::reset_desktop_data,
            commands::pick_local_project,
            commands::save_task_export,
            commands::save_output_image,
            commands::setup_local_wisp,
            commands::apply_local_wisp_setup,
            commands::open_external_url,
            commands::notify_task_transition,
            commands::desktop_update_status,
            commands::check_desktop_update,
            commands::install_desktop_update,
            commands::relaunch_desktop,
            commands::reveal_worktree_file,
        ])
        .run(context())
        .expect("failed to start the Wisp desktop shell");
}

/// Open native state, bind the proxy, and only then build the main window
/// with its navigation policy. Returns the app configuration directory.
fn start(app: &mut tauri::App) -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    let config_dir = app.path().app_config_dir()?;
    let registry_path = config_dir.join("connections.json");
    let wisp_home = local::wisp_home();
    let core = tauri::async_runtime::block_on(DesktopCore::start(
        registry_path,
        Arc::new(KeychainSecretStore::default()),
        wisp_home,
        proxy::packaged_app_origins(),
    ))?;
    let policy = Arc::new(NavigationPolicy::new(
        app_origins(app.config()),
        core.proxy_base(),
    )?);
    app.manage(core);

    let window = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == notifications::MAIN_WINDOW_LABEL)
        .cloned()
        .ok_or("tauri.conf.json has no main window")?;
    let in_place = policy.clone();
    tauri::WebviewWindowBuilder::from_config(app.handle(), &window)?
        .on_navigation(move |url| follow(in_place.navigation(url)))
        .on_new_window(move |url, _features| {
            follow(policy.new_window(&url));
            tauri::webview::NewWindowResponse::Deny
        })
        .build()?;
    Ok(config_dir)
}

/// The documents the shell itself serves: the packaged origin, plus the
/// configured dev server when this is a `tauri dev` build.
fn app_origins(config: &tauri::Config) -> Vec<url::Url> {
    let mut origins = Vec::new();
    if let Ok(packaged) = url::Url::parse(proxy::PACKAGED_APP_ORIGIN) {
        origins.push(packaged);
    }
    if tauri::is_dev() {
        if let Some(dev) = &config.build.dev_url {
            origins.push(dev.clone());
        }
    }
    origins
}

/// Apply a navigation decision. Returns whether the webview may load it.
fn follow(decision: Navigation) -> bool {
    match decision {
        Navigation::Stay => true,
        Navigation::OpenInBrowser(href) => {
            if let Err(error) = external::open(&href) {
                eprintln!("[wisp-desktop] could not open a link outside the app: {error}");
            }
            false
        }
        Navigation::Refuse => false,
    }
}

/// Say why the shell cannot start, then quit when the message is dismissed.
///
/// `setup` returning an error would become a Tauri panic, and the release
/// profile aborts on panic: the user would see only "Wisp quit unexpectedly".
fn refuse_to_start(app: &tauri::AppHandle, reason: &str) {
    eprintln!("[wisp-desktop] could not start: {reason}");
    let handle = app.clone();
    app.dialog()
        .message(format!(
            "Wisp Desktop could not start.\n\n{reason}\n\nFix the problem above and open Wisp again."
        ))
        .title("Wisp could not start")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCustom("Quit".to_string()))
        .show(move |_| handle.exit(1));
}

/// Tell the user their saved connections could not be read and were set
/// aside, rather than aborting every launch until they find the file.
fn report_registry_recovery(app: &tauri::AppHandle, recovery: &registry::RegistryRecovery) {
    eprintln!(
        "[wisp-desktop] saved connections were unreadable and moved to {}: {}",
        recovery.backup.display(),
        recovery.reason
    );
    app.dialog()
        .message(format!(
            "Wisp Desktop could not read its saved connections, so it started with only the Local connection.\n\n\
             {reason}\n\n\
             The unreadable file was kept as {backup}. Remote tokens were left in the Keychain: \
             add your remote daemons again, or quit Wisp and move that file back to connections.json \
             with a Wisp Desktop version that can read it.",
            reason = recovery.reason,
            backup = recovery.backup.display(),
        ))
        .title("Saved connections were reset")
        .kind(MessageDialogKind::Warning)
        .show(|_| {});
}
