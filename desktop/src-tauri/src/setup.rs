//! Local-daemon diagnosis and explicitly confirmed setup actions.
//!
//! Diagnosis never mutates the machine. A separate command rechecks the exact
//! reported plan before it runs `wisp init` or starts the Homebrew service.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use url::Url;

use crate::local::LocalStatus;
use crate::urls::join_upstream;

/// What the shell should offer next. A closed set, so the frontend branches on
/// a value rather than on prose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NextStep {
    /// Profile present, daemon answering.
    Ready,
    /// No `wisp` executable found.
    InstallCli,
    /// Executable found, no profile yet.
    RunInit,
    /// Profile present, nothing listening.
    StartDaemon,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSetupReport {
    pub status: LocalStatus,
    /// Absolute path of the discovered `wisp` executable, if any.
    pub cli_path: Option<String>,
    pub daemon_reachable: bool,
    pub next_step: NextStep,
    pub message: String,
}

/// Directories a Wisp install lands in, beyond whatever `PATH` says. The
/// packaged app inherits a login `PATH` that often omits all of them.
const EXTRA_BIN_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];

#[derive(Debug, thiserror::Error)]
pub enum SetupError {
    #[error("Wisp is not installed; install the Wisp Desktop Cask again so Homebrew can restore its required Wisp Formula")]
    MissingCli,
    #[error("Homebrew is not available; install the Wisp Formula and start its service manually")]
    MissingHomebrew,
    #[error("could not start the {step} setup step: {source}")]
    Launch {
        step: &'static str,
        #[source]
        source: std::io::Error,
    },
    #[error("the {0} setup step did not complete successfully")]
    Failed(&'static str),
    #[error("the {0} setup step did not finish within 30 seconds")]
    TimedOut(&'static str),
}

/// Find an executable by name. Pure in its inputs so the search order is
/// testable without a real filesystem layout on `PATH`.
pub fn find_executable(
    name: &str,
    path_var: Option<&str>,
    extra_dirs: &[PathBuf],
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let from_path = path_var
        .unwrap_or_default()
        .split(':')
        .filter(|entry| !entry.is_empty())
        .map(PathBuf::from);
    for dir in from_path.chain(extra_dirs.iter().cloned()) {
        let candidate = dir.join(name);
        if exists(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn is_executable_file(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// Locate the `wisp` CLI the same way a login shell would, plus the two package
/// manager prefixes a GUI process usually cannot see.
pub fn find_wisp_cli(home: Option<&Path>) -> Option<PathBuf> {
    let mut extra: Vec<PathBuf> = EXTRA_BIN_DIRS.iter().map(PathBuf::from).collect();
    if let Some(home) = home {
        extra.push(home.join(".local/bin"));
    }
    let path_var = std::env::var("PATH").ok();
    find_executable("wisp", path_var.as_deref(), &extra, &is_executable_file)
}

fn find_homebrew() -> Option<PathBuf> {
    let extra: Vec<PathBuf> = EXTRA_BIN_DIRS.iter().map(PathBuf::from).collect();
    let path_var = std::env::var("PATH").ok();
    find_executable("brew", path_var.as_deref(), &extra, &is_executable_file)
}

fn run_step(program: &Path, args: &[&str], step: &'static str) -> Result<(), SetupError> {
    let mut child = Command::new(program)
        .args(args)
        .env_remove("WISP_HOME")
        .env_remove("WISP_COMMAND_NAME")
        .env("HOMEBREW_NO_AUTO_UPDATE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|source| SetupError::Launch { step, source })?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => return Err(SetupError::Failed(step)),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(SetupError::TimedOut(step));
            }
            Err(source) => return Err(SetupError::Launch { step, source }),
        }
    }
}

/// Apply only the exact repair the report offered and the user confirmed.
/// No shell is involved, output is discarded so credentials cannot become UI
/// error text, and the app never downloads or embeds a second Wisp binary.
pub fn apply(report: &LocalSetupReport) -> Result<(), SetupError> {
    match report.next_step {
        NextStep::Ready => return Ok(()),
        NextStep::InstallCli => return Err(SetupError::MissingCli),
        NextStep::RunInit => {
            let cli = report
                .cli_path
                .as_deref()
                .map(Path::new)
                .ok_or(SetupError::MissingCli)?;
            run_step(cli, &["init"], "wisp init")?;
        }
        NextStep::StartDaemon => {}
    }
    let brew = find_homebrew().ok_or(SetupError::MissingHomebrew)?;
    run_step(&brew, &["services", "start", "wisp"], "Homebrew service")
}

/// Unauthenticated liveness probe. `/api/health` is one of the two routes that
/// does not need the daemon token, which is what makes it usable before a
/// credential is known to be good.
pub async fn daemon_reachable(client: &reqwest::Client, base: &Url) -> bool {
    let Ok(url) = join_upstream(base, "api/health", None) else {
        return false;
    };
    client
        .get(url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}

/// Turn the three facts into the one decision the shell renders.
pub fn decide(status: &LocalStatus, cli_path: Option<&Path>, reachable: bool) -> LocalSetupReport {
    let (next_step, message) = match (status.available, cli_path.is_some(), reachable) {
        (true, _, true) => (
            NextStep::Ready,
            "The local Wisp daemon is running and this app can reach it.".to_string(),
        ),
        (true, false, false) => (
            NextStep::InstallCli,
            "A local Wisp profile exists, but the `wisp` command is missing. Reinstall the Wisp Desktop Cask so Homebrew can restore it.".to_string(),
        ),
        (true, true, false) => (
            NextStep::StartDaemon,
            "A local Wisp profile exists but nothing is listening. Run `wisp serve` (or start the installed service) and try again.".to_string(),
        ),
        (false, true, _) => (
            NextStep::RunInit,
            "Wisp is installed but has no profile on this machine yet. Run `wisp init` and try again.".to_string(),
        ),
        (false, false, _) => (
            NextStep::InstallCli,
            "No `wisp` command was found. Install Wisp on this machine, then run `wisp init`.".to_string(),
        ),
    };
    LocalSetupReport {
        status: status.clone(),
        cli_path: cli_path.map(|path| path.display().to_string()),
        daemon_reachable: reachable,
        next_step,
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::{decide, find_executable, NextStep};
    use crate::local::LocalStatus;
    use std::path::{Path, PathBuf};

    fn status(available: bool) -> LocalStatus {
        LocalStatus {
            available,
            config_path: "/synthetic/.wisp/config.json".into(),
            base_url: available.then(|| "http://127.0.0.1:18710".to_string()),
            instance_id: available.then(|| "wisp-instance-local".to_string()),
            has_token: available,
            reason: (!available).then(|| "no profile".to_string()),
        }
    }

    #[test]
    fn path_entries_win_over_the_extra_directories() {
        let present: Vec<PathBuf> = vec![
            PathBuf::from("/synthetic/bin/wisp"),
            PathBuf::from("/opt/homebrew/bin/wisp"),
        ];
        let exists = move |path: &Path| present.iter().any(|p| p == path);
        let found = find_executable(
            "wisp",
            Some("/nowhere:/synthetic/bin"),
            &[PathBuf::from("/opt/homebrew/bin")],
            &exists,
        )
        .expect("found");
        assert_eq!(found, PathBuf::from("/synthetic/bin/wisp"));
    }

    #[test]
    fn the_extra_directories_are_searched_when_path_misses_them() {
        let exists = |path: &Path| path == Path::new("/opt/homebrew/bin/wisp");
        let found = find_executable(
            "wisp",
            Some("/nowhere"),
            &[PathBuf::from("/opt/homebrew/bin")],
            &exists,
        )
        .expect("found");
        assert_eq!(found, PathBuf::from("/opt/homebrew/bin/wisp"));
        assert!(find_executable("wisp", None, &[], &exists).is_none());
    }

    #[test]
    fn the_next_step_names_the_one_thing_that_is_missing() {
        assert_eq!(
            decide(&status(true), Some(Path::new("/synthetic/bin/wisp")), true).next_step,
            NextStep::Ready
        );
        assert_eq!(
            decide(&status(true), Some(Path::new("/synthetic/bin/wisp")), false).next_step,
            NextStep::StartDaemon
        );
        assert_eq!(
            decide(&status(true), None, false).next_step,
            NextStep::InstallCli
        );
        assert_eq!(
            decide(
                &status(false),
                Some(Path::new("/synthetic/bin/wisp")),
                false
            )
            .next_step,
            NextStep::RunInit
        );
        assert_eq!(
            decide(&status(false), None, false).next_step,
            NextStep::InstallCli
        );
    }

    #[test]
    fn the_report_carries_no_credential() {
        let report = decide(&status(true), Some(Path::new("/synthetic/bin/wisp")), true);
        let json = serde_json::to_string(&report).expect("serializes");
        assert!(json.contains("\"hasToken\":true"));
        assert!(!json.contains("\"token\""));
    }
}
