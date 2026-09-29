import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_PATH } from "../src/config";
import { serve } from "../src/daemon";
import type { CommandResult, UpdateStatus } from "../src/update";
import {
  compareVersions,
  isHomebrewServiceProcess,
  isSupervisordServiceProcess,
  runUpdateCommand,
  UPDATE_COMMAND_MAX_BYTES,
  UpdateInterruptsTasksError,
  UpdateManager,
} from "../src/update";
import { createTask, createTurn, db, freeSlot, newTaskId, transition } from "../src/store";
import { updateRoute } from "../src/routes/update";
import { API_PROTOCOL_VERSION } from "../src/version";

const homes: string[] = [];
let server: Awaited<ReturnType<typeof serve>> | null = null;

afterEach(async () => {
  if (server) await server.stop(true);
  server = null;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function daemonChannel(
  version: string,
  apiProtocolVersion: unknown = API_PROTOCOL_VERSION,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    product: "wisp",
    version,
    apiProtocolVersion,
    publishedAt: "2026-09-05T12:00:00.000Z",
  };
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** GitHub redirects release downloads here; a real fetch reports it as `response.url`. */
const ASSET_HOST = "https://release-assets.githubusercontent.com";

/** A constructed Response has no final URL; give it the one a real fetch would report. */
function servedFrom(url: string, response: Response): Response {
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function linuxManifest(commit: string, sha256: string, size: number): Record<string, unknown> {
  return {
    schemaVersion: 1,
    product: "wisp",
    version: "0.4.0-alpha.8",
    apiProtocolVersion: 1,
    commit,
    dirty: false,
    target: { os: "linux", arch: "x86_64", libc: "glibc" },
    artifact: { file: "wisp-v0.4.0-alpha.8-linux-x86_64", sha256, size },
  };
}

async function waitFor(manager: UpdateManager, state: UpdateStatus["state"]): Promise<UpdateStatus> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await manager.getStatus();
    if (status.state === state) return status;
    await Bun.sleep(1);
  }
  throw new Error(`update never reached ${state}`);
}

/**
 * A restart callback and a promise that settles once it has run. The manager
 * reports "restarting" one `restartDelayMs` before it calls restart(), so
 * seeing the state is not seeing the call.
 */
function restartProbe() {
  let count = 0;
  let ran!: () => void;
  const called = new Promise<void>((resolve) => { ran = resolve; });
  return { restart: () => { count++; ran(); }, called, count: () => count };
}

describe("release selection", () => {
  test("compares stable and prerelease versions with SemVer precedence", () => {
    expect(compareVersions("0.4.0-alpha.10", "0.4.0-alpha.9")).toBe(1);
    expect(compareVersions("0.4.0-alpha.1", "0.4.0-alpha.1")).toBe(0);
    expect(compareVersions("0.4.0", "0.4.0-alpha.99")).toBe(1);
    expect(compareVersions("0.4.1-alpha.1", "0.4.0-alpha.99")).toBe(1);
    expect(compareVersions("0.4.0-alpha.1", "0.4.0-beta.1")).toBe(-1);
    expect(compareVersions("0.4.0-alpha.9007199254740993", "0.4.0-alpha.9007199254740992")).toBe(1);
    expect(() => compareVersions("0.4.0-alpha.01", "0.4.0-alpha.1")).toThrow("invalid release version");
    expect(() => compareVersions("0.4.0-alpha..1", "0.4.0-alpha.1")).toThrow("invalid release version");
  });

});

describe("supervisor detection", () => {
  test("recognizes both Homebrew service label generations by their exact pid", () => {
    const labels: string[] = [];
    const run = (cmd: string[]): CommandResult => {
      labels.push(cmd.at(-1)!);
      return cmd.at(-1)!.endsWith("/homebrew.mxcl.wisp")
        ? { exitCode: 0, stdout: "state = running\npid = 42\n", stderr: "" }
        : { exitCode: 113, stdout: "", stderr: "Could not find service" };
    };
    expect(isHomebrewServiceProcess(501, 42, run)).toBe(true);
    expect(labels).toEqual(["gui/501/sh.brew.wisp", "gui/501/homebrew.mxcl.wisp"]);
    expect(isHomebrewServiceProcess(501, 41, run)).toBe(false);
  });

  test("recognizes an explicitly opted-in Supervisor program by its exact pid", () => {
    const commands: string[][] = [];
    const run = (cmd: string[]): CommandResult => {
      commands.push(cmd);
      return { exitCode: 0, stdout: "42", stderr: "" };
    };
    const env = {
      WISP_UPDATE_SUPERVISOR: "supervisord",
      SUPERVISOR_ENABLED: "1",
      SUPERVISOR_PROCESS_NAME: "wisp",
      SUPERVISOR_GROUP_NAME: "wisp",
    };

    expect(isSupervisordServiceProcess(42, env, run)).toBe(true);
    expect(isSupervisordServiceProcess(41, env, run)).toBe(false);
    expect(commands).toEqual([
      ["supervisorctl", "pid", "wisp"],
      ["supervisorctl", "pid", "wisp"],
    ]);
  });

  test("refuses Supervisor without both the opt-in and injected identity", () => {
    const run = () => {
      throw new Error("supervisorctl must not run");
    };
    expect(isSupervisordServiceProcess(42, {}, run)).toBe(false);
    expect(isSupervisordServiceProcess(42, {
      WISP_UPDATE_SUPERVISOR: "supervisord",
      SUPERVISOR_ENABLED: "1",
      SUPERVISOR_PROCESS_NAME: "other",
      SUPERVISOR_GROUP_NAME: "other",
    }, run)).toBe(false);
  });

  test("treats a failed Supervisor query as unsupervised", () => {
    const env = {
      WISP_UPDATE_SUPERVISOR: "supervisord",
      SUPERVISOR_ENABLED: "1",
      SUPERVISOR_PROCESS_NAME: "wisp",
      SUPERVISOR_GROUP_NAME: "wisp",
    };
    expect(isSupervisordServiceProcess(42, env, () => ({
      exitCode: 3,
      stdout: "",
      stderr: "wisp: ERROR (no such process)",
    }))).toBe(false);
    expect(isSupervisordServiceProcess(42, env, () => {
      throw new Error("supervisor socket unavailable");
    })).toBe(false);
  });
});

describe("UpdateManager", () => {
  test("production update commands stop on output floods", async () => {
    const error = await runUpdateCommand(
      ["bash", "-c", `head -c ${UPDATE_COMMAND_MAX_BYTES + 1} /dev/zero | tr '\\0' x`],
    ).catch((value) => value instanceof Error ? value.message : String(value));
    expect(error).toContain("output budget");
  });

  test("coalesces concurrent release refreshes", async () => {
    let requests = 0;
    let complete!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      complete = resolve;
    });
    const manager = new UpdateManager({
      currentVersion: "0.4.0-alpha.6",
      dirty: false,
      fetch: async () => {
        requests++;
        return response;
      },
      detectInstallation: () => ({ method: "unsupported", supervised: false, reason: "manual" }),
    });

    const first = manager.getStatus();
    const second = manager.getStatus();
    await Bun.sleep(0);
    expect(requests).toBe(1);
    complete(jsonResponse(daemonChannel("0.4.0-alpha.8")));
    expect((await first).latestVersion).toBe("0.4.0-alpha.8");
    expect((await second).latestVersion).toBe("0.4.0-alpha.8");
    expect(requests).toBe(1);
  });

  test("caches the promoted daemon channel and reports unsupported builds honestly", async () => {
    let requests = 0;
    const manager = new UpdateManager({
      currentVersion: "0.4.0-alpha.6",
      dirty: false,
      fetch: async () => {
        requests++;
        return jsonResponse(daemonChannel("0.4.0-alpha.8"), 200, {
          etag: '"release-7"',
        });
      },
      detectInstallation: () => ({
        method: "unsupported",
        supervised: false,
        reason: "run the platform installer manually",
      }),
    });

    expect(await manager.getStatus()).toEqual({
      currentVersion: "0.4.0-alpha.6",
      currentApiProtocolVersion: API_PROTOCOL_VERSION,
      latestVersion: "0.4.0-alpha.8",
      latestApiProtocolVersion: API_PROTOCOL_VERSION,
      state: "available",
      installMethod: "unsupported",
      canAutoUpdate: false,
      message: "run the platform installer manually",
      checkedAt: expect.any(String),
    });
    await manager.getStatus();
    expect(requests).toBe(1);
  });

  test("an explicit refresh bypasses caches and conditional channel requests", async () => {
    let latest = "0.4.0-alpha.8";
    let now = new Date("2026-09-05T12:00:00Z");
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const manager = new UpdateManager({
      currentVersion: "0.4.0-alpha.6",
      dirty: false,
      now: () => now,
      fetch: async (input, init) => {
        requests.push({ url: String(input), init });
        return jsonResponse(daemonChannel(latest), 200, {
          etag: `"${latest}"`,
        });
      },
      detectInstallation: () => ({ method: "homebrew", supervised: true, reason: null }),
    });

    expect((await manager.getStatus()).latestVersion).toBe("0.4.0-alpha.8");
    latest = "0.4.0-alpha.9";
    expect((await manager.getStatus()).latestVersion).toBe("0.4.0-alpha.8");
    expect(requests).toHaveLength(1);

    now = new Date("2026-09-05T12:00:01Z");
    expect((await manager.refreshStatus()).latestVersion).toBe("0.4.0-alpha.9");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.url).toEndWith(`?refresh=${now.getTime()}`);
    expect(requests[1]!.init?.cache).toBe("no-store");
    expect(requests[1]!.init?.headers).toMatchObject({
      "cache-control": "no-cache",
      pragma: "no-cache",
    });
    expect(requests[1]!.init?.headers).not.toHaveProperty("if-none-match");
  });

  test("rejects malformed daemon channel metadata instead of guessing", async () => {
    const valid = daemonChannel("0.4.0-alpha.8");
    const cases: Array<[string, unknown]> = [
      ["missing protocol", { ...valid, apiProtocolVersion: undefined }],
      ["numeric string", { ...valid, apiProtocolVersion: "1" }],
      ["zero", { ...valid, apiProtocolVersion: 0 }],
      ["fraction", { ...valid, apiProtocolVersion: 1.5 }],
      ["unsafe integer", { ...valid, apiProtocolVersion: Number.MAX_SAFE_INTEGER + 1 }],
      ["wrong schema", { ...valid, schemaVersion: 2 }],
      ["wrong product", { ...valid, product: "other" }],
      ["invalid version", { ...valid, version: "0.4.0-alpha.01" }],
      ["bad date", { ...valid, publishedAt: "yesterday" }],
      ["unknown field", { ...valid, extra: true }],
      ["list", [valid]],
    ];

    for (const [label, channel] of cases) {
      const manager = new UpdateManager({
        currentVersion: "0.4.0-alpha.6",
        dirty: false,
        fetch: async () => jsonResponse(channel),
        detectInstallation: () => ({ method: "unsupported", supervised: false, reason: "manual installation" }),
      });
      const status = await manager.getStatus();
      expect(status, label).toMatchObject({
        latestVersion: null,
        latestApiProtocolVersion: null,
        state: "unavailable",
        canAutoUpdate: false,
      });
      expect(status.message, label).toContain("daemon update channel");
    }
  });

  test("retains channel metadata when a routine conditional request is unchanged", async () => {
    let now = new Date("2026-09-05T12:00:00Z");
    let requests = 0;
    const headers: Array<RequestInit["headers"]> = [];
    const manager = new UpdateManager({
      currentVersion: "0.4.0-alpha.6",
      dirty: false,
      releaseCacheMs: 1,
      now: () => now,
      fetch: async (_input, init) => {
        headers.push(init?.headers);
        requests++;
        return requests === 1
          ? jsonResponse(daemonChannel("0.4.0-alpha.8"), 200, {
              etag: '"release-7"',
            })
          : new Response(null, { status: 304 });
      },
      detectInstallation: () => ({ method: "unsupported", supervised: false, reason: "manual" }),
    });

    expect((await manager.getStatus()).latestApiProtocolVersion).toBe(API_PROTOCOL_VERSION);
    now = new Date("2026-09-05T12:00:01Z");
    expect((await manager.getStatus()).latestApiProtocolVersion).toBe(API_PROTOCOL_VERSION);
    expect(requests).toBe(2);
    expect(headers[1]).toMatchObject({ "if-none-match": '"release-7"' });
  });

  test("updates a Homebrew installation without replacing its binary directly", async () => {
    const commands: string[][] = [];
    const probe = restartProbe();
    const run = async (cmd: string[]): Promise<CommandResult> => {
      commands.push(cmd);
      if (cmd.join(" ") === "brew --prefix wisp") {
        return { exitCode: 0, stdout: "/opt/homebrew/opt/wisp", stderr: "" };
      }
      if (cmd.at(-2) === "version") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ version: "0.4.0-alpha.8", commit: "b".repeat(40), dirty: false }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const manager = new UpdateManager({
      currentVersion: "0.4.0-alpha.6",
      dirty: false,
      fetch: async () => jsonResponse(daemonChannel("0.4.0-alpha.8")),
      run,
      detectInstallation: () => ({ method: "homebrew", supervised: true, reason: null }),
      restart: probe.restart,
      restartDelayMs: 0,
    });

    expect(await manager.start("0.4.0-alpha.8")).toMatchObject({
      state: "installing",
      canAutoUpdate: true,
      installMethod: "homebrew",
      latestApiProtocolVersion: API_PROTOCOL_VERSION,
    });
    await waitFor(manager, "restarting");
    await probe.called;
    expect(commands).toEqual([
      ["brew", "update"],
      ["brew", "upgrade", "Pepewitch/tap/wisp"],
      ["brew", "--prefix", "wisp"],
      ["/opt/homebrew/opt/wisp/bin/wisp", "version", "--json"],
    ]);
    expect(probe.count()).toBe(1);
  });

  test("reports a package-manager failure without restarting", async () => {
    let restarted = false;
    const manager = new UpdateManager({
      currentVersion: "0.4.0-alpha.6",
      dirty: false,
      fetch: async () => jsonResponse(daemonChannel("0.4.0-alpha.8")),
      run: async () => ({ exitCode: 1, stdout: "", stderr: "tap unavailable" }),
      detectInstallation: () => ({ method: "homebrew", supervised: true, reason: null }),
      restart: () => {
        restarted = true;
      },
      restartDelayMs: 0,
    });

    await manager.start("0.4.0-alpha.8");
    expect(await waitFor(manager, "failed")).toMatchObject({
      latestVersion: "0.4.0-alpha.8",
      message: "update failed: brew update exited 1: tap unavailable",
    });
    expect(restarted).toBe(false);
  });

  test("verifies and atomically activates a managed Linux release", async () => {
    const root = mkdtempSync(join(tmpdir(), "wisp-update-"));
    homes.push(root);
    const oldBinary = join(root, "versions/0.4.0-alpha.6/wisp");
    mkdirSync(join(root, "versions/0.4.0-alpha.6"), { recursive: true });
    writeFileSync(join(root, ".managed-by-wisp"), "wisp-managed-install-v1\n");
    writeFileSync(oldBinary, "old");
    symlinkSync(oldBinary, join(root, "current"));

    const artifact = new TextEncoder().encode("verified executable");
    const checksum = new Bun.CryptoHasher("sha256").update(artifact).digest("hex");
    const commit = "c".repeat(40);
    const probe = restartProbe();
    const manager = new UpdateManager({
      currentVersion: "0.4.0-alpha.6",
      executablePath: oldBinary,
      dirty: false,
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("wisp-daemon.json")) {
          return jsonResponse(daemonChannel("0.4.0-alpha.8"));
        }
        if (url.endsWith("/release-manifest.json")) {
          return servedFrom(url, jsonResponse(linuxManifest(commit, checksum, artifact.byteLength)));
        }
        return servedFrom(`${ASSET_HOST}/artifact`, new Response(artifact));
      },
      run: async (_cmd) => ({
        exitCode: 0,
        stdout: JSON.stringify({ version: "0.4.0-alpha.8", commit, dirty: false }),
        stderr: "",
      }),
      detectInstallation: () => ({
        method: "managed-linux",
        supervised: true,
        reason: null,
        installRoot: root,
      }),
      restart: probe.restart,
      restartDelayMs: 0,
    });

    await manager.start("0.4.0-alpha.8");
    await waitFor(manager, "restarting");
    await probe.called;
    const installed = join(root, "versions/0.4.0-alpha.8/wisp");
    expect(readFileSync(installed, "utf8")).toBe("verified executable");
    expect(readlinkSync(join(root, "current"))).toBe(installed);
    expect(readFileSync(oldBinary, "utf8")).toBe("old");
    expect(probe.count()).toBe(1);
  });

  describe("refuses a managed Linux release download that", () => {
    const artifact = new TextEncoder().encode("verified executable");
    const checksum = new Bun.CryptoHasher("sha256").update(artifact).digest("hex");
    const commit = "c".repeat(40);

    /** Runs one update; `respond` may replace the manifest or artifact response. */
    async function attempt(respond: (url: string, standard: () => Response) => Response) {
      const root = mkdtempSync(join(tmpdir(), "wisp-update-"));
      homes.push(root);
      const oldBinary = join(root, "versions/0.4.0-alpha.6/wisp");
      mkdirSync(join(root, "versions/0.4.0-alpha.6"), { recursive: true });
      writeFileSync(join(root, ".managed-by-wisp"), "wisp-managed-install-v1\n");
      writeFileSync(oldBinary, "old");
      symlinkSync(oldBinary, join(root, "current"));
      const executed: string[][] = [];
      const manager = new UpdateManager({
        currentVersion: "0.4.0-alpha.6",
        executablePath: oldBinary,
        dirty: false,
        fetch: async (input) => {
          const url = String(input);
          if (url.includes("wisp-daemon.json")) return jsonResponse(daemonChannel("0.4.0-alpha.8"));
          return respond(url, () =>
            url.endsWith("/release-manifest.json")
              ? servedFrom(url, jsonResponse(linuxManifest(commit, checksum, artifact.byteLength)))
              : servedFrom(`${ASSET_HOST}/artifact`, new Response(artifact)),
          );
        },
        run: async (cmd) => {
          executed.push(cmd);
          return { exitCode: 0, stdout: JSON.stringify({ version: "0.4.0-alpha.8", commit, dirty: false }), stderr: "" };
        },
        detectInstallation: () => ({ method: "managed-linux", supervised: true, reason: null, installRoot: root }),
        restart: () => {},
        restartDelayMs: 0,
      });
      await manager.start("0.4.0-alpha.8");
      const status = await waitFor(manager, "failed");
      expect(executed).toEqual([]);
      expect(readlinkSync(join(root, "current"))).toBe(oldBinary);
      return status.message;
    }

    test("was redirected off GitHub's release hosts", async () => {
      expect(
        await attempt((url, standard) =>
          url.endsWith("/release-manifest.json")
            ? servedFrom(
              "https://mirror.example.invalid/release-manifest.json",
              jsonResponse(linuxManifest(commit, checksum, artifact.byteLength)),
            )
            : standard(),
        ),
      ).toContain("release manifest was served from https://mirror.example.invalid");
      expect(
        await attempt((url, standard) =>
          url.endsWith("/release-manifest.json")
            ? standard()
            : servedFrom("http://release-assets.githubusercontent.com/artifact", new Response(artifact)),
        ),
      ).toContain("release artifact was served from http://release-assets.githubusercontent.com");
    });

    test("has no final URL at all", async () => {
      expect(
        await attempt((url, standard) =>
          url.endsWith("/release-manifest.json") ? jsonResponse(linuxManifest(commit, checksum, artifact.byteLength)) : standard(),
        ),
      ).toContain("release manifest response has no final URL");
    });

    test("serves a manifest larger than any real one, advertised or streamed", async () => {
      const huge = `{"padding":"${"x".repeat(80 * 1024)}"}`;
      const streamed = () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(huge));
              controller.close();
            },
          }),
        );
      for (const body of [() => new Response(huge), streamed]) {
        expect(
          await attempt((url, standard) =>
            url.endsWith("/release-manifest.json") ? servedFrom(url, body()) : standard(),
          ),
        ).toContain("release manifest is too large");
      }
    });
  });
});

describe("update API", () => {
  test("keeps update status and installation behind daemon authentication", async () => {
    const manager = new UpdateManager({
      currentVersion: "0.4.0-alpha.6",
      dirty: false,
      fetch: async () => jsonResponse(daemonChannel("0.4.0-alpha.8")),
      detectInstallation: () => ({ method: "homebrew", supervised: true, reason: null }),
    });
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        port: 18710,
        host: "127.0.0.1",
        token: "update-secret",
        webhooks: [],
        repos: [],
        stuckMinutes: 10,
        logMaxBytes: 5_000_000,
        setupTimeoutMinutes: 10,
        envAllowlist: {},
        harnessDefaults: {},
      }),
    );
    server = await serve({
      port: 0,
      updateManager: manager,
      modelProbeSpawn: () => {
        throw new Error("no model probes in update auth test");
      },
    });
    const base = `http://127.0.0.1:${server.port}`;

    expect((await fetch(`${base}/api/update`)).status).toBe(401);
    expect((await fetch(`${base}/api/update?refresh=1`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/api/update`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: "0.4.0-alpha.8" }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${base}/api/update`, {
          headers: { authorization: "Bearer update-secret" },
        })
      ).status,
    ).toBe(200);
  });

  test("serves update status and validates the requested version", async () => {
    let now = new Date("2026-09-05T12:00:00Z");
    const manager = new UpdateManager({
      currentVersion: "0.4.0-alpha.6",
      dirty: false,
      now: () => now,
      fetch: async () => jsonResponse(daemonChannel("0.4.0-alpha.8")),
      detectInstallation: () => ({
        method: "unsupported",
        supervised: false,
        reason: "manual installation",
      }),
    });
    const url = "http://wisp.test/api/update";
    const status = await updateRoute(new Request(url), "/api/update", "GET", manager);
    expect(status).not.toBeNull();
    expect(status!.status).toBe(200);
    expect(await status!.json()).toMatchObject({
      currentVersion: "0.4.0-alpha.6",
      latestVersion: "0.4.0-alpha.8",
      state: "available",
      canAutoUpdate: false,
      checkedAt: "2026-09-05T12:00:00.000Z",
    });

    now = new Date("2026-09-05T13:00:00Z");
    const refreshed = await updateRoute(
      new Request(`${url}?refresh=1`),
      "/api/update",
      "GET",
      manager,
    );
    expect(refreshed).not.toBeNull();
    expect(await refreshed!.json()).toMatchObject({
      checkedAt: "2026-09-05T13:00:00.000Z",
    });

    const invalid = await updateRoute(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "anything" }),
      }),
      "/api/update",
      "POST",
      manager,
    );
    expect(invalid).not.toBeNull();
    expect(invalid!.status).toBe(400);
    expect(await invalid!.json()).toEqual({ error: "version must name a complete Wisp release" });

    expect(updateRoute(new Request("http://wisp.test/elsewhere"), "/elsewhere", "GET", manager)).toBeNull();
  });
});

describe("updating over running turns", () => {
  const brewRun = async (cmd: string[]): Promise<CommandResult> => {
    if (cmd.join(" ") === "brew --prefix wisp") return { exitCode: 0, stdout: "/opt/homebrew/opt/wisp", stderr: "" };
    if (cmd.at(-2) === "version") {
      return { exitCode: 0, stdout: JSON.stringify({ version: "0.4.0-alpha.8", commit: "b".repeat(40), dirty: false }), stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  function brewManager(restart: () => void, latest = "0.4.0-alpha.8") {
    return new UpdateManager({
      currentVersion: "0.4.0-alpha.6",
      dirty: false,
      fetch: async () => jsonResponse(daemonChannel(latest)),
      run: brewRun,
      detectInstallation: () => ({ method: "homebrew", supervised: true, reason: null }),
      restart,
      restartDelayMs: 0,
    });
  }

  test("refuses, naming the count, only an update that would run and only without force", async () => {
    // an update that cannot run anyway says so, rather than asking about tasks
    await expect(brewManager(() => {}, "0.4.0-alpha.6").start("0.4.0-alpha.8", { runningTasks: () => 2 }))
      .rejects.toThrow("Wisp is already up to date");

    const probe = restartProbe();
    const manager = brewManager(probe.restart);
    const refusal = await manager.start("0.4.0-alpha.8", { runningTasks: () => 2 }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(UpdateInterruptsTasksError);
    expect((refusal as UpdateInterruptsTasksError).running).toBe(2);
    expect((refusal as Error).message).toContain("2 tasks have a running turn");
    // nothing started: the same update can still be asked for
    expect((await manager.getStatus()).state).toBe("available");

    expect(await manager.start("0.4.0-alpha.8", { force: true, runningTasks: () => 2 })).toMatchObject({ state: "installing" });
    await probe.called;
    expect(probe.count()).toBe(1);
  });

  test("POST /api/update answers 409 with the running count, and force updates anyway", async () => {
    const ids = [newTaskId(), newTaskId()];
    for (const id of ids) {
      createTask({ id, title: "Update fixture", repo_path: "/fixture/repo", harness: "fake", model: null, slot: freeSlot() });
      transition(id, "running", "turn 1");
      createTurn(id, 1, "prompt", 99999, "/tmp/update-running-test.out.log");
    }
    try {
      const probe = restartProbe();
      const manager = brewManager(probe.restart);
      const post = (body: unknown) => updateRoute(
        new Request("http://wisp.test/api/update", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        "/api/update",
        "POST",
        manager,
      )!;

      const refused = await post({ version: "0.4.0-alpha.8" });
      expect(refused.status).toBe(409);
      const answer = await refused.json() as { error: string; running: number };
      // the test database is shared: at least this file's two tasks
      expect(answer.running).toBeGreaterThanOrEqual(2);
      expect(answer.error).toContain("running turn");

      expect((await post({ version: "0.4.0-alpha.8", force: "yes" })).status).toBe(400);

      const forced = await post({ version: "0.4.0-alpha.8", force: true });
      expect(forced.status).toBe(202);
      expect(await forced.json()).toMatchObject({ state: "installing" });
      await probe.called;
    } finally {
      for (const id of ids) {
        db.run("DELETE FROM turns WHERE task_id = ?", [id]);
        db.run("DELETE FROM tasks WHERE id = ?", [id]);
      }
    }
  });
});
