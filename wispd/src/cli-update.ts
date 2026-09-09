import { wispCommand } from "./command";
import { compareVersions, type UpdateStatus } from "./update";

type Request = (
  path: string,
  method?: string,
  body?: unknown,
) => Promise<unknown>;

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
    throw new Error(
      status.message ?? "this Wisp installation cannot update automatically",
    );
  }

  await request("/api/update", "POST", { version: status.latestVersion });
  write(
    `Updating Wisp ${status.currentVersion} to ${status.latestVersion}. The daemon will restart automatically.`,
  );
}
