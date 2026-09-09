import { describe, expect, test } from "bun:test";
import { HELP } from "../src/cli-help";
import { updateCommand } from "../src/cli-update";
import type { UpdateStatus } from "../src/update";

function status(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    currentVersion: "0.5.0",
    currentApiProtocolVersion: 1,
    latestVersion: "0.5.1",
    latestApiProtocolVersion: 1,
    state: "available",
    installMethod: "homebrew",
    canAutoUpdate: true,
    message: null,
    checkedAt: "2026-09-09T12:00:00.000Z",
    ...overrides,
  };
}

describe("wisp update", () => {
  test("is listed in command help", () => {
    expect(HELP).toContain("wisp update");
  });

  test("forces discovery and installs the exact promoted version", async () => {
    const calls: Array<[string, string | undefined, unknown]> = [];
    const lines: string[] = [];
    await updateCommand(
      [],
      async (path, method, body) => {
        calls.push([path, method, body]);
        return path.includes("refresh=1") ? status() : status({ state: "installing" });
      },
      (line) => lines.push(line),
    );

    expect(calls).toEqual([
      ["/api/update?refresh=1", undefined, undefined],
      ["/api/update", "POST", { version: "0.5.1" }],
    ]);
    expect(lines).toEqual([
      "Updating Wisp 0.5.0 to 0.5.1. The daemon will restart automatically.",
    ]);
  });

  test("reports an up-to-date installation without posting", async () => {
    const calls: string[] = [];
    const lines: string[] = [];
    await updateCommand(
      [],
      async (path) => {
        calls.push(path);
        return status({
          latestVersion: "0.5.0",
          state: "up-to-date",
        });
      },
      (line) => lines.push(line),
    );

    expect(calls).toEqual(["/api/update?refresh=1"]);
    expect(lines).toEqual(["Wisp 0.5.0 is up to date."]);
  });

  test("surfaces discovery and installation refusals", async () => {
    await expect(
      updateCommand(
        [],
        async () =>
          status({
            state: "unavailable",
            latestVersion: null,
            latestApiProtocolVersion: null,
            message: "could not check for updates: offline",
          }),
        () => {},
      ),
    ).rejects.toThrow("could not check for updates: offline");

    await expect(
      updateCommand(
        [],
        async () =>
          status({
            canAutoUpdate: false,
            installMethod: "unsupported",
            message: "source and development builds update manually",
          }),
        () => {},
      ),
    ).rejects.toThrow("source and development builds update manually");
  });

  test("does not start a second update or accept positional arguments", async () => {
    const lines: string[] = [];
    await updateCommand(
      [],
      async () => status({ state: "restarting" }),
      (line) => lines.push(line),
    );
    expect(lines).toEqual(["Wisp update is already restarting."]);

    await expect(
      updateCommand(["0.5.1"], async () => status(), () => {}),
    ).rejects.toThrow("usage: wisp update");
  });
});
