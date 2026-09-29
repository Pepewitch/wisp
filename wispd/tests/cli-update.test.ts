import { describe, expect, test } from "bun:test";
import { CliApiError } from "../src/cli-api";
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

  test("explains how to recover when a managed Linux daemon is not supervised", async () => {
    await expect(
      updateCommand(
        [],
        async () =>
          status({
            canAutoUpdate: false,
            installMethod: "managed-linux",
            message: "automatic updates require the running daemon to be managed by wisp.service",
          }),
        () => {},
      ),
    ).rejects.toThrow(
      [
        "automatic updates require the running daemon to be managed by wisp.service",
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
        "Guide: https://github.com/Pepewitch/wisp/blob/main/docs/INSTALL.md#upgrade-and-reinstall",
      ].join("\n"),
    );
  });

  test("uses Homebrew recovery instructions for an unsupervised macOS daemon", async () => {
    await expect(
      updateCommand(
        [],
        async () =>
          status({
            canAutoUpdate: false,
            installMethod: "homebrew",
            message: "automatic updates require the running daemon to be managed by Homebrew services",
          }),
        () => {},
      ),
    ).rejects.toThrow(
      [
        "automatic updates require the running daemon to be managed by Homebrew services",
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
        "Guide: https://github.com/Pepewitch/wisp/blob/main/docs/INSTALL-MACOS.md",
      ].join("\n"),
    );
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

describe("wisp update while tasks are running", () => {
  /** The daemon's rule: an unforced start refuses with 409 and the running count. */
  function busyDaemon(running: number) {
    const posts: unknown[] = [];
    const request = async (path: string, method?: string, body?: unknown) => {
      if (method !== "POST") return status();
      posts.push(body);
      if (!(body as { force?: boolean }).force) {
        const error = `${running} tasks have a running turn that restarting Wisp would interrupt`;
        throw new CliApiError(error, `http://127.0.0.1:1${path}`, false, 409, { error, running });
      }
      return status({ state: "installing" });
    };
    return { posts, request };
  }
  const WARNING = "2 tasks have a running turn. Updating restarts the daemon and interrupts them.";
  const UPDATING = "Updating Wisp 0.5.0 to 0.5.1. The daemon will restart automatically.";

  test("on a terminal it names the count, asks, and updates once the answer is yes", async () => {
    const { posts, request } = busyDaemon(2);
    const lines: string[] = [];
    const questions: string[] = [];
    await updateCommand([], request, (line) => lines.push(line), {
      interactive: true,
      ask: async (question) => { questions.push(question); return true; },
    });
    expect(questions).toEqual(["Update anyway? [y/N] "]);
    expect(posts).toEqual([{ version: "0.5.1" }, { version: "0.5.1", force: true }]);
    expect(lines).toEqual([WARNING, UPDATING]);
  });

  test("any other answer cancels without forcing", async () => {
    const { posts, request } = busyDaemon(1);
    const lines: string[] = [];
    await updateCommand([], request, (line) => lines.push(line), { interactive: true, ask: async () => false });
    expect(posts).toEqual([{ version: "0.5.1" }]);
    expect(lines).toEqual([
      "1 task has a running turn. Updating restarts the daemon and interrupts it.",
      "Update cancelled.",
    ]);
  });

  test("without a terminal it refuses unless --yes was given", async () => {
    const refused = busyDaemon(2);
    const lines: string[] = [];
    await expect(
      updateCommand([], refused.request, (line) => lines.push(line), {
        interactive: false,
        ask: async () => { throw new Error("must not ask without a terminal"); },
      }),
    ).rejects.toThrow("not updating while tasks are running; rerun with --yes to interrupt them");
    expect(refused.posts).toEqual([{ version: "0.5.1" }]);
    expect(lines).toEqual([WARNING]);

    const confirmed = busyDaemon(2);
    const confirmedLines: string[] = [];
    await updateCommand([], confirmed.request, (line) => confirmedLines.push(line), {
      yes: true,
      interactive: false,
      ask: async () => { throw new Error("--yes must not ask"); },
    });
    expect(confirmed.posts).toEqual([{ version: "0.5.1" }, { version: "0.5.1", force: true }]);
    expect(confirmedLines).toEqual([WARNING, UPDATING]);
  });

  test("any other refusal is not mistaken for running tasks", async () => {
    await expect(
      updateCommand([], async (path, method) => {
        if (method !== "POST") return status();
        throw new CliApiError("an update is already in progress", `http://127.0.0.1:1${path}`, false, 409, {
          error: "an update is already in progress",
        });
      }, () => {}, { yes: true }),
    ).rejects.toThrow("an update is already in progress");
  });

  test("--help names --yes", () => {
    expect(HELP).toContain("update [--yes]");
  });
});
