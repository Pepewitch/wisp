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
    canInstall: true,
    restartsAutomatically: true,
    message: null,
    checkedAt: "2026-09-09T12:00:00.000Z",
    lastAttempt: null,
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
            canInstall: false,
            restartsAutomatically: false,
            installMethod: "unsupported",
            message: "source and development builds update manually",
          }),
        () => {},
      ),
    ).rejects.toThrow("source and development builds update manually");
  });

  /** A daemon from before canInstall: it sends neither field and refuses what it would not restart. */
  function olderDaemon(overrides: Partial<UpdateStatus>): Omit<UpdateStatus, "canInstall" | "restartsAutomatically"> {
    const { canInstall: _canInstall, restartsAutomatically: _restarts, ...older } = status({ canAutoUpdate: false, ...overrides });
    return older;
  }

  test("tells an older managed Linux daemon's user both ways to install the release", async () => {
    await expect(
      updateCommand(
        [],
        async () =>
          olderDaemon({
            installMethod: "managed-linux",
            message: "automatic updates require the running daemon to be managed by wisp.service",
          }),
        () => {},
      ),
    ).rejects.toThrow(
      [
        "automatic updates require the running daemon to be managed by wisp.service",
        "",
        "Either install the release yourself:",
        "  Rerun the installer, then restart the daemon however you started it.",
        "Or let systemd run the daemon, so `wisp update` restarts it after updating:",
        "  1. Open a separate terminal, because stopping Wisp may disconnect this one.",
        "  2. Stop the current daemon using the terminal or supervisor that started it.",
        "  3. systemctl --user enable --now wisp.service",
        "  4. wisp update",
        "Guide: https://github.com/Pepewitch/wisp/blob/main/docs/INSTALL.md#upgrade-and-reinstall",
      ].join("\n"),
    );
  });

  test("tells an older Homebrew daemon's user both ways to install the release", async () => {
    await expect(
      updateCommand(
        [],
        async () =>
          olderDaemon({
            installMethod: "homebrew",
            message: "this Homebrew installation is not running under its launchd service",
          }),
        () => {},
      ),
    ).rejects.toThrow(
      [
        "this Homebrew installation is not running under its launchd service",
        "",
        "Either install the release yourself:",
        "  brew update && brew upgrade Pepewitch/tap/wisp",
        "  Then restart the daemon however you started it.",
        "Or let Homebrew services run the daemon, so `wisp update` restarts it after updating:",
        "  1. Open a separate terminal, because stopping Wisp may disconnect this one.",
        "  2. Stop the current daemon using the terminal or supervisor that started it.",
        "  3. brew services start wisp",
        "  4. wisp update",
        "Guide: https://github.com/Pepewitch/wisp/blob/main/docs/INSTALL-MACOS.md",
      ].join("\n"),
    );
  });

  test("an older daemon that can auto-update still updates", async () => {
    const posts: unknown[] = [];
    const lines: string[] = [];
    await updateCommand(
      [],
      async (_path, method, body) => {
        if (method === "POST") posts.push(body);
        return olderDaemon({ canAutoUpdate: true, state: method === "POST" ? "installing" : "available" });
      },
      (line) => lines.push(line),
    );
    expect(posts).toEqual([{ version: "0.5.1" }]);
    expect(lines).toEqual(["Updating Wisp 0.5.0 to 0.5.1. The daemon will restart automatically."]);
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

describe("wisp update when nothing restarts the daemon", () => {
  const INSTRUCTION =
    "Wisp 0.5.1 is installed. Restart the daemon to finish: stop the running daemon, then run `brew services start wisp` so future updates restart it on their own.";
  const unsupervised = (overrides: Partial<UpdateStatus> = {}) =>
    status({
      canAutoUpdate: false,
      restartsAutomatically: false,
      message: "Homebrew services does not run this daemon, so it will not restart on its own after an update",
      ...overrides,
    });

  test("installs, waits for the install, and prints how to finish", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const lines: string[] = [];
    const states = ["installing", "installing", "restart-required"] as const;
    let reads = 0;
    await updateCommand(
      [],
      async (path, method) => {
        calls.push([path, method]);
        if (path.includes("refresh=1")) return unsupervised();
        if (method === "POST") return unsupervised({ state: "installing" });
        const state = states[Math.min(reads++, states.length - 1)]!;
        return unsupervised({ state, message: state === "restart-required" ? INSTRUCTION : null });
      },
      (line) => lines.push(line),
      {},
      { sleep: async () => undefined },
    );
    expect(calls).toEqual([
      ["/api/update?refresh=1", undefined],
      ["/api/update", "POST"],
      ["/api/update", undefined],
      ["/api/update", undefined],
      ["/api/update", undefined],
    ]);
    expect(lines).toEqual([
      "Installing Wisp 0.5.1. Nothing restarts this daemon automatically, so you will restart it to finish.",
      INSTRUCTION,
    ]);
  });

  test("reports a failed install", async () => {
    await expect(
      updateCommand(
        [],
        async (path, method) => {
          if (path.includes("refresh=1")) return unsupervised();
          if (method === "POST") return unsupervised({ state: "installing" });
          return unsupervised({ state: "failed", message: "update failed: brew update exited 1: offline" });
        },
        () => {},
        {},
        { sleep: async () => undefined },
      ),
    ).rejects.toThrow("update failed: brew update exited 1: offline");
  });

  test("an installed update waiting for its restart is reported, not installed again", async () => {
    const calls: string[] = [];
    const lines: string[] = [];
    await updateCommand(
      [],
      async (path, method) => {
        calls.push(`${method ?? "GET"} ${path}`);
        return unsupervised({ state: "restart-required", message: INSTRUCTION });
      },
      (line) => lines.push(line),
    );
    expect(calls).toEqual(["GET /api/update?refresh=1"]);
    expect(lines).toEqual([INSTRUCTION]);
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
