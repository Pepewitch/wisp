import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { SpawnResult } from "./doctor";
import { isHomebrewServiceProcess, isSupervisordServiceProcess } from "./update-supervisor";
import { BUILD_DIRTY } from "./version";
import type { InstallMethod } from "../../shared/api/update";

/** What the installer writes into the root it manages, and nothing else does. */
export const MANAGED_INSTALL_MARKER = "wisp-managed-install-v1";

type CommandResult = SpawnResult;

/** How this daemon was installed, and whether anything restarts it after an update. */
export interface Installation {
  method: InstallMethod;
  /** A supervisor restarts the daemon after an install. */
  supervised: boolean;
  reason: string | null;
  installRoot?: string;
  /** Managed Linux only: a wisp.service user unit is installed, whether or not it runs this daemon. */
  serviceUnit?: boolean;
}

function output(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8").trim();
}

function runSync(cmd: string[]): CommandResult {
  const result = Bun.spawnSync({ cmd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: output(result.stdout),
    stderr: output(result.stderr),
  };
}

function homebrewInstallation(): Installation | null {
  if (platform() !== "darwin" || !Bun.which("brew") || !Bun.which("launchctl")) return null;
  const prefix = runSync(["brew", "--prefix", "wisp"]);
  if (prefix.exitCode !== 0 || !prefix.stdout) return null;
  const installed = realpathSync(resolve(prefix.stdout, "bin/wisp"));
  if (installed !== realpathSync(process.execPath)) return null;
  if (typeof process.getuid !== "function") {
    return {
      method: "homebrew",
      supervised: false,
      reason: "Wisp cannot identify the launchd user, so the daemon will not restart on its own after an update",
    };
  }
  const supervised = isHomebrewServiceProcess(process.getuid(), process.pid);
  return {
    method: "homebrew",
    supervised,
    reason: supervised
      ? null
      : "Homebrew services does not run this daemon, so it will not restart on its own after an update",
  };
}

/** What managed-Linux detection reads from the system; tests inject each piece. */
export interface ManagedLinuxProbe {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  /** The running executable; for a managed install, `<root>/versions/<version>/wisp`. */
  executablePath?: string;
  pid?: number;
  isSupervisordService?: (pid: number) => boolean;
  /** Runs `systemctl` with these arguments; null when systemctl is not available. */
  systemctl?: ((args: string[]) => CommandResult) | null;
}

/** A root the installer manages whose `current` link is the running executable. */
function isManagedInstallRoot(root: string, running: string): boolean {
  const marker = join(root, ".managed-by-wisp");
  const current = join(root, "current");
  if (!existsSync(marker) || readFileSync(marker, "utf8").trim() !== MANAGED_INSTALL_MARKER) return false;
  if (!existsSync(current) || !lstatSync(current).isSymbolicLink()) return false;
  return realpathSync(current) === running;
}

/**
 * The managed install root this executable runs from. `WISP_INSTALL_ROOT` wins
 * when it is set and checks out, but the systemd unit the installer writes does
 * not carry it, so the root is otherwise derived from the executable itself:
 * `<root>/versions/<version>/wisp`, three levels up.
 */
function managedInstallRoot(env: NodeJS.ProcessEnv, executablePath: string): string | null {
  const running = realpathSync(executablePath);
  if (env.WISP_INSTALL_ROOT) {
    const configured = resolve(env.WISP_INSTALL_ROOT);
    if (isManagedInstallRoot(configured, running)) return configured;
  }
  const versions = dirname(dirname(running));
  if (basename(running) !== "wisp" || basename(versions) !== "versions") return null;
  const derived = dirname(versions);
  return isManagedInstallRoot(derived, running) ? derived : null;
}

function systemdProperties(stdout: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) properties.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return properties;
}

/** An installer-managed Linux daemon, and who (if anyone) restarts it after an update. */
export function detectManagedLinuxInstallation(probe: ManagedLinuxProbe = {}): Installation | null {
  if ((probe.platform ?? platform()) !== "linux") return null;
  const pid = probe.pid ?? process.pid;
  const installRoot = managedInstallRoot(probe.env ?? process.env, probe.executablePath ?? process.execPath);
  if (installRoot === null) return null;
  if ((probe.isSupervisordService ?? isSupervisordServiceProcess)(pid)) {
    return { method: "managed-linux", supervised: true, reason: null, installRoot };
  }
  const systemctl = probe.systemctl !== undefined
    ? probe.systemctl
    : Bun.which("systemctl")
      ? (args: string[]) => runSync(["systemctl", ...args])
      : null;
  if (!systemctl) {
    return {
      method: "managed-linux",
      supervised: false,
      reason: "systemctl is not available, so the daemon will not restart on its own after an update",
      installRoot,
    };
  }
  const service = systemctl(["--user", "show", "wisp.service", "--property=MainPID", "--property=LoadState"]);
  const properties = service.exitCode === 0 ? systemdProperties(service.stdout) : new Map<string, string>();
  const supervised = Number(properties.get("MainPID")) === pid;
  return {
    method: "managed-linux",
    supervised,
    reason: supervised
      ? null
      : "wisp.service does not run this daemon, so it will not restart on its own after an update",
    installRoot,
    serviceUnit: properties.get("LoadState") === "loaded",
  };
}

export function detectInstallation(): Installation {
  if (BUILD_DIRTY || process.env.WISP_COMMAND_NAME === "wisp-dev") {
    return { method: "unsupported", supervised: false, reason: "source and development builds update manually" };
  }
  try {
    return (
      homebrewInstallation() ??
      detectManagedLinuxInstallation() ?? {
        method: "unsupported",
        supervised: false,
        reason: "Wisp does not recognize this installation",
      }
    );
  } catch (error) {
    return {
      method: "unsupported",
      supervised: false,
      reason: `could not inspect this installation: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
