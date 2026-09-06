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
//!
//! `docs/DESKTOP-TRANSPORT.md` states the contract these modules implement.

pub mod capability;
pub mod commands;
pub mod core;
pub mod external;
pub mod local;
pub mod probe;
pub mod proxy;
pub mod random;
pub mod registry;
pub mod secrets;
pub mod setup;
pub mod urls;

use std::sync::Arc;

use tauri::Manager;

use crate::core::DesktopCore;
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
/// transport would just fail every request with a confusing error.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let registry_path = app.path().app_config_dir()?.join("connections.json");
            let wisp_home = local::wisp_home();
            let core = tauri::async_runtime::block_on(DesktopCore::start(
                registry_path,
                Arc::new(KeychainSecretStore::default()),
                wisp_home,
                proxy::packaged_app_origins(),
            ))?;
            app.manage(core);
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
            commands::setup_local_wisp,
            commands::apply_local_wisp_setup,
            commands::open_external_url,
        ])
        .run(context())
        .expect("failed to start the Wisp desktop shell");
}
