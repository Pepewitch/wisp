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
        "To enable automatic updates with systemd (if available):",
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

export async function updateCommand(
  positional: string[],
  request: Request,
  write: (line: string) => void = console.log,
): Promise<void> {
  const command = wispCommand();
  if (positional.length > 0) {
    throw new Error(`usage: ${command} update`);
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

  await request("/api/update", "POST", { version: status.latestVersion });
  write(
    `Updating Wisp ${status.currentVersion} to ${status.latestVersion}. The daemon will restart automatically.`,
  );
}
