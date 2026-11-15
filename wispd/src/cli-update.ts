import { createInterface } from "node:readline/promises";
import { CliApiError } from "./cli-api";
import { print } from "./cli-print";
import { wispCommand } from "./command";
import { compareVersions, type UpdateStatus } from "./update";

type Request = (
  path: string,
  method?: string,
  body?: unknown,
) => Promise<unknown>;

const INSTALL_GUIDE = "https://github.com/Pepewitch/wisp/blob/main/docs/INSTALL.md#upgrade-and-reinstall";
const MACOS_INSTALL_GUIDE = "https://github.com/Pepewitch/wisp/blob/main/docs/INSTALL-MACOS.md";
const INSTALL_POLL_MS = 1_000;
/** Longer than the daemon's own bound on its package-manager commands. */
const INSTALL_TIMEOUT_MS = 35 * 60 * 1000;

/** GET /api/update from any daemon: one from before `canInstall` sends neither field. */
type AnyDaemonUpdateStatus = Omit<UpdateStatus, "canInstall" | "restartsAutomatically"> &
  Partial<Pick<UpdateStatus, "canInstall" | "restartsAutomatically">>;

/**
 * Why this daemon will not install the release, and how to install it anyway.
 * A current daemon installs any recognized installation, so the per-method
 * steps are for a daemon from before that, which refuses one nothing restarts.
 */
function blockedUpdateMessage(status: AnyDaemonUpdateStatus): string {
  const reason = status.message ?? "this Wisp installation cannot update itself";
  if (status.installMethod === "managed-linux") {
    return [
      reason,
      "",
      "Either install the release yourself:",
      "  Rerun the installer, then restart the daemon however you started it.",
      "Or let systemd run the daemon, so `wisp update` restarts it after updating:",
      "  1. Open a separate terminal, because stopping Wisp may disconnect this one.",
      "  2. Stop the current daemon using the terminal or supervisor that started it.",
      "  3. systemctl --user enable --now wisp.service",
      "  4. wisp update",
      `Guide: ${INSTALL_GUIDE}`,
    ].join("\n");
  }
  if (status.installMethod === "homebrew") {
    return [
      reason,
      "",
      "Either install the release yourself:",
      "  brew update && brew upgrade Pepewitch/tap/wisp",
      "  Then restart the daemon however you started it.",
      "Or let Homebrew services run the daemon, so `wisp update` restarts it after updating:",
      "  1. Open a separate terminal, because stopping Wisp may disconnect this one.",
      "  2. Stop the current daemon using the terminal or supervisor that started it.",
      "  3. brew services start wisp",
      "  4. wisp update",
      `Guide: ${MACOS_INSTALL_GUIDE}`,
    ].join("\n");
  }
  return reason;
}

function restartRequiredMessage(status: AnyDaemonUpdateStatus): string {
  return status.message ?? `Wisp ${status.latestVersion ?? "update"} is installed; restart the daemon to finish.`;
}

export interface UpdateWait {
  /** How long to wait between status reads while an install nothing restarts runs. */
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Follow an install the daemon will not restart after, to the instruction that finishes it. */
async function waitForInstall(request: Request, version: string, wait: UpdateWait): Promise<AnyDaemonUpdateStatus> {
  const sleep = wait.sleep ?? ((ms: number) => Bun.sleep(ms));
  const deadline = Date.now() + (wait.timeoutMs ?? INSTALL_TIMEOUT_MS);
  for (;;) {
    const status = (await request("/api/update")) as AnyDaemonUpdateStatus;
    if (status.state === "restart-required") return status;
    if (status.state === "failed") throw new Error(status.message ?? "update failed");
    if (status.state !== "installing") {
      throw new Error(`the update to ${version} stopped unexpectedly (${status.state}); run wisp update again`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Wisp ${version} is still installing; run wisp update later to see how it ended`);
    }
    await sleep(wait.pollMs ?? INSTALL_POLL_MS);
  }
}

export interface UpdateConfirmation {
  /** --yes / -y: interrupt running tasks without asking. */
  yes?: boolean;
  /** Whether a person can answer the question; defaults to stdin being a terminal. */
  interactive?: boolean;
  /** Ask a yes/no question; resolves true only for an explicit yes. */
  ask?: (question: string) => Promise<boolean>;
}

/** The daemon's refusal to restart over running turns: how many tasks, or null for any other failure. */
function interruptedTaskCount(error: unknown): number | null {
  if (!(error instanceof CliApiError) || error.status !== 409) return null;
  const running = error.data?.running;
  return typeof running === "number" && Number.isSafeInteger(running) && running > 0 ? running : null;
}

async function askOnTerminal(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await prompt.question(question)).trim());
  } finally {
    prompt.close();
  }
}

export async function updateCommand(
  positional: string[],
  request: Request,
  write: (line: string) => void = print,
  confirmation: UpdateConfirmation = {},
  wait: UpdateWait = {},
): Promise<void> {
  const command = wispCommand();
  if (positional.length > 0) {
    throw new Error(`usage: ${command} update [--yes]`);
  }

  const status = (await request("/api/update?refresh=1")) as AnyDaemonUpdateStatus;
  if (status.state === "installing" || status.state === "restarting") {
    write(`Wisp update is already ${status.state}.`);
    return;
  }
  if (status.state === "restart-required") {
    write(restartRequiredMessage(status));
    return;
  }
  if (status.state === "unavailable") {
    throw new Error(status.message ?? "could not check for Wisp updates");
  }
  if (
    status.latestVersion === null ||
    compareVersions(status.latestVersion, status.currentVersion) <= 0
  ) {
    write(`Wisp ${status.currentVersion} is up to date.`);
    return;
  }
  // a daemon from before canInstall installs only what it also restarts
  if (!(status.canInstall ?? status.canAutoUpdate)) {
    throw new Error(blockedUpdateMessage(status));
  }

  const version = status.latestVersion;
  let accepted: AnyDaemonUpdateStatus;
  try {
    accepted = (await request("/api/update", "POST", { version })) as AnyDaemonUpdateStatus;
  } catch (error) {
    // The daemon's one rule: it refuses while turns run and says how many.
    const running = interruptedTaskCount(error);
    if (running === null) throw error;
    const them = running === 1 ? "it" : "them";
    write(
      `${running === 1 ? "1 task has" : `${running} tasks have`} a running turn. Updating restarts the daemon and interrupts ${them}.`,
    );
    if (!confirmation.yes) {
      if (!(confirmation.interactive ?? process.stdin.isTTY === true)) {
        throw new Error(`not updating while tasks are running; rerun with --yes to interrupt ${them}`, {
          cause: error,
        });
      }
      if (!(await (confirmation.ask ?? askOnTerminal)("Update anyway? [y/N] "))) {
        write("Update cancelled.");
        return;
      }
    }
    accepted = (await request("/api/update", "POST", { version, force: true })) as AnyDaemonUpdateStatus;
  }
  if (accepted?.restartsAutomatically ?? status.restartsAutomatically ?? true) {
    write(
      `Updating Wisp ${status.currentVersion} to ${status.latestVersion}. The daemon will restart automatically.`,
    );
    return;
  }
  write(`Installing Wisp ${version}. Nothing restarts this daemon automatically, so you will restart it to finish.`);
  write(restartRequiredMessage(await waitForInstall(request, version, wait)));
}
