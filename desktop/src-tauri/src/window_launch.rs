//! First launch of an installed Desktop version, including an updater restart.

use std::io::{self, Write};
use std::path::Path;

use tauri::{AppHandle, Manager, Wry};

use crate::notifications::MAIN_WINDOW_LABEL;

const LAST_WINDOW_VERSION: &str = "last-window-version";

/// The old binary cannot signal a restart when it predates this feature.
/// Remember the version on startup instead, so even the first update *to*
/// this code gets the right window. Later launches of the same version keep
/// the normal size and focus behavior.
fn first_launch_of_version(config_dir: &Path, version: &str) -> io::Result<bool> {
    std::fs::create_dir_all(config_dir)?;
    let path = config_dir.join(LAST_WINDOW_VERSION);
    match std::fs::read_to_string(&path) {
        Ok(previous) if previous == version => return Ok(false),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }

    let mut file = tempfile::NamedTempFile::new_in(config_dir)?;
    file.write_all(version.as_bytes())?;
    file.persist(path).map_err(|error| error.error)?;
    Ok(true)
}

pub fn focus_new_version(app: &AppHandle<Wry>, config_dir: &Path) {
    match first_launch_of_version(config_dir, env!("CARGO_PKG_VERSION")) {
        Ok(true) => {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                // Native zoom fills the usable screen, not a full-screen Space.
                if let Err(error) = window.maximize() {
                    eprintln!("[wisp-desktop] could not zoom the new window: {error}");
                }
                if let Err(error) = window.show() {
                    eprintln!("[wisp-desktop] could not show the new window: {error}");
                }
                if let Err(error) = window.set_focus() {
                    eprintln!("[wisp-desktop] could not focus the new window: {error}");
                }
            }
        }
        Ok(false) => {}
        Err(error) => eprintln!("[wisp-desktop] could not remember the window version: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_version_zooms_only_on_its_first_launch() {
        let dir = tempfile::tempdir().unwrap();
        assert!(first_launch_of_version(dir.path(), "0.6.2").unwrap());
        assert!(!first_launch_of_version(dir.path(), "0.6.2").unwrap());
        assert!(first_launch_of_version(dir.path(), "0.6.3").unwrap());
        assert!(!first_launch_of_version(dir.path(), "0.6.3").unwrap());
    }

    #[test]
    fn version_write_failure_does_not_mark_a_launch_as_handled() {
        let dir = tempfile::tempdir().unwrap();
        let not_a_directory = dir.path().join("file");
        std::fs::write(&not_a_directory, "not a directory").unwrap();
        assert!(first_launch_of_version(&not_a_directory, "0.6.3").is_err());
    }
}
