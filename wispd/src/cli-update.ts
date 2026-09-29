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

function blockedUpdateMessage(status: UpdateStatus): string {
  const reason = status.message ?? "this Wisp installation cannot update automatically";
  if (status.installMethod === "managed-linux") {
    return [
      reason,
      "",
      "To enable automatic updates with systemd (if available):",
      "1. Open a separate terminal, because stopping Wisp may disconnect this one.",
      "2. Stop the current daemon using the terminal or supervisor that started it.",
      "3. Start the systemd service:",
      "   systemctl --user enable --now wisp.service",
      "4. Retry:",
      "   wisp update",
      "",
      "If another supervisor intentionally manages Wisp, install the release manually and restart it with that supervisor.",
      `Guide: ${INSTALL_GUIDE}`,
    ].join("\n");
  }
  if (status.installMethod === "homebrew") {
    return [
      reason,
      "",
      "To enable automatic updates with Homebrew services:",
      "1. Open a separate terminal, because stopping Wisp may disconnect this one.",
      "2. Stop the current daemon using the terminal or supervisor that started it.",
      "3. Start the Homebrew service:",
      "   brew services start wisp",
      "4. Retry:",
      "   wisp update",
      "",
      "If another supervisor intentionally manages Wisp, update it manually and restart it with that supervisor.",
      `Guide: ${MACOS_INSTALL_GUIDE}`,
    ].join("\n");
  }
  return reason;
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
): Promise<void> {
  const command = wispCommand();
  if (positional.length > 0) {
    throw new Error(`usage: ${command} update [--yes]`);
  }

  const status = (await request("/api/update?refresh=1")) as UpdateStatus;
  if (status.state === "installing" || status.state === "restarting") {
    write(`Wisp update is already ${status.state}.`);
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
  if (!status.canAutoUpdate) {
    throw new Error(blockedUpdateMessage(status));
  }

  const version = status.latestVersion;
  try {
    await request("/api/update", "POST", { version });
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
    await request("/api/update", "POST", { version, force: true });
  }
  write(
    `Updating Wisp ${status.currentVersion} to ${status.latestVersion}. The daemon will restart automatically.`,
  );
}
