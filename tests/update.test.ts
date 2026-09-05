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
import { compareVersions, isHomebrewServiceProcess, selectLatestRelease, UpdateManager } from "../src/update";
import { updateRoute } from "../src/routes/update";
import { API_PROTOCOL_VERSION } from "../src/version";

const homes: string[] = [];
let server: Awaited<ReturnType<typeof serve>> | null = null;

afterEach(async () => {
  if (server) await server.stop(true);
  server = null;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function release(version: string, options: { draft?: boolean; prerelease?: boolean } = {}) {
  return {
    tag_name: `v${version}`,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? version.includes("-"),
    published_at: "2026-09-05T12:00:00Z",
  };
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function protocolManifest(version: string, apiProtocolVersion: unknown = 1): Record<string, unknown> {
  return {
    schemaVersion: 1,
    product: "wisp",
    version,
    apiProtocolVersion,
    commit: "a".repeat(40),
    dirty: false,
    target: { os: "linux", arch: "x86_64", libc: "glibc" },
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

  test("selects the highest published version, including prereleases", () => {
    expect(
      selectLatestRelease(
        [
          release("0.4.0-alpha.7"),
          release("0.4.0-alpha.10"),
          release("0.4.0-beta.2"),
          release("0.4.0-alpha.99", { draft: true }),
        ],
        "0.4.0-alpha.6",
      ),
    ).toMatchObject({ version: "0.4.0-beta.2", tag: "v0.4.0-beta.2" });
    expect(
      selectLatestRelease(
        [release("0.5.0", { prerelease: false }), release("0.6.0-rc.1")],
        "0.4.0",
      ),
    ).toMatchObject({ version: "0.6.0-rc.1" });
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
});

describe("UpdateManager", () => {
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
    complete(jsonResponse([release("0.4.0-alpha.7")]));
    expect((await first).latestVersion).toBe("0.4.0-alpha.7");
    expect((await second).latestVersion).toBe("0.4.0-alpha.7");
    expect(requests).toBe(2);
  });

  test("caches the GitHub release response and reports unsupported builds honestly", async () => {
    let requests = 0;
    const manager = new UpdateManager({
      currentVersion: "0.4.0-alpha.6",
      dirty: false,
      fetch: async (input) => {
        requests++;
        return String(input).includes("api.github.com")
          ? jsonResponse([release("0.4.0-alpha.7")], 200, { etag: '"release-7"' })
          : jsonResponse(protocolManifest("0.4.0-alpha.7"));
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
      latestVersion: "0.4.0-alpha.7",
      latestApiProtocolVersion: API_PROTOCOL_VERSION,
      state: "available",
      installMethod: "unsupported",
      canAutoUpdate: false,
      message: "run the platform installer manually",
      checkedAt: expect.any(String),
    });
    await manager.getStatus();
    expect(requests).toBe(2);
  });

  test("keeps legacy or invalid release protocol metadata explicitly unknown", async () => {
    const valid = protocolManifest("0.4.0-alpha.7");
    const cases: Array<[string, () => Response | Promise<Response>]> = [
      ["missing", () => jsonResponse({ ...valid, apiProtocolVersion: undefined })],
      ["numeric string", () => jsonResponse({ ...valid, apiProtocolVersion: "1" })],
      ["zero", () => jsonResponse({ ...valid, apiProtocolVersion: 0 })],
      ["fraction", () => jsonResponse({ ...valid, apiProtocolVersion: 1.5 })],
      ["unsafe integer", () => jsonResponse({ ...valid, apiProtocolVersion: Number.MAX_SAFE_INTEGER + 1 })],
      ["wrong schema", () => jsonResponse({ ...valid, schemaVersion: 2 })],
      ["wrong product", () => jsonResponse({ ...valid, product: "other" })],
      ["wrong version", () => jsonResponse({ ...valid, version: "0.4.0-alpha.8" })],
      ["wrong target", () => jsonResponse({ ...valid, target: { os: "darwin", arch: "arm64" } })],
      ["dirty", () => jsonResponse({ ...valid, dirty: true })],
      ["bad commit", () => jsonResponse({ ...valid, commit: "not-a-commit" })],
      ["not found", () => new Response(null, { status: 404 })],
      ["malformed JSON", () => new Response("{", { status: 200 })],
      ["network failure", () => Promise.reject(new Error("offline"))],
    ];

    for (const [label, manifestResponse] of cases) {
      const manager = new UpdateManager({
        currentVersion: "0.4.0-alpha.6",
        dirty: false,
        fetch: async (input) =>
          String(input).includes("api.github.com")
            ? jsonResponse([release("0.4.0-alpha.7")])
            : manifestResponse(),
        detectInstallation: () => ({ method: "unsupported", supervised: false, reason: "manual installation" }),
      });
      const status = await manager.getStatus();
      expect(status, label).toMatchObject({
        latestVersion: "0.4.0-alpha.7",
        latestApiProtocolVersion: null,
        state: "available",
        canAutoUpdate: false,
        message: "manual installation",
      });
    }
  });

  test("retains fetched protocol metadata when the release list is unchanged", async () => {
    let now = new Date("2026-09-05T12:00:00Z");
    let releaseRequests = 0;
    let manifestRequests = 0;
    const manager = new UpdateManager({
      currentVersion: "0.4.0-alpha.6",
      dirty: false,
      releaseCacheMs: 1,
      now: () => now,
      fetch: async (input) => {
        if (String(input).includes("api.github.com")) {
          releaseRequests++;
          return releaseRequests === 1
            ? jsonResponse([release("0.4.0-alpha.7")], 200, { etag: '"release-7"' })
            : new Response(null, { status: 304 });
        }
        manifestRequests++;
        return jsonResponse(protocolManifest("0.4.0-alpha.7", API_PROTOCOL_VERSION));
      },
      detectInstallation: () => ({ method: "unsupported", supervised: false, reason: "manual" }),
    });

    expect((await manager.getStatus()).latestApiProtocolVersion).toBe(API_PROTOCOL_VERSION);
    now = new Date("2026-09-05T12:00:01Z");
    expect((await manager.getStatus()).latestApiProtocolVersion).toBe(API_PROTOCOL_VERSION);
    expect(releaseRequests).toBe(2);
    expect(manifestRequests).toBe(1);
  });

  test("updates a Homebrew installation without replacing its binary directly", async () => {
    const commands: string[][] = [];
    let restarted = 0;
    const run = async (cmd: string[]): Promise<CommandResult> => {
      commands.push(cmd);
      if (cmd.join(" ") === "brew --prefix wisp") {
        return { exitCode: 0, stdout: "/opt/homebrew/opt/wisp", stderr: "" };
      }
      if (cmd.at(-2) === "version") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ version: "0.4.0-alpha.7", commit: "b".repeat(40), dirty: false }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const manager = new UpdateManager({
      currentVersion: "0.4.0-alpha.6",
      dirty: false,
      fetch: async () => jsonResponse([release("0.4.0-alpha.7")]),
      run,
      detectInstallation: () => ({ method: "homebrew", supervised: true, reason: null }),
      restart: () => {
        restarted++;
      },
      restartDelayMs: 0,
    });

    expect(await manager.start("0.4.0-alpha.7")).toMatchObject({
      state: "installing",
      canAutoUpdate: true,
      installMethod: "homebrew",
      latestApiProtocolVersion: null,
    });
    await waitFor(manager, "restarting");
    expect(commands).toEqual([
      ["brew", "update"],
      ["brew", "upgrade", "Pepewitch/tap/wisp"],
      ["brew", "--prefix", "wisp"],
      ["/opt/homebrew/opt/wisp/bin/wisp", "version", "--json"],
    ]);
    expect(restarted).toBe(1);
  });

  test("reports a package-manager failure without restarting", async () => {
    let restarted = false;
    const manager = new UpdateManager({
      currentVersion: "0.4.0-alpha.6",
      dirty: false,
      fetch: async () => jsonResponse([release("0.4.0-alpha.7")]),
      run: async () => ({ exitCode: 1, stdout: "", stderr: "tap unavailable" }),
      detectInstallation: () => ({ method: "homebrew", supervised: true, reason: null }),
      restart: () => {
        restarted = true;
      },
      restartDelayMs: 0,
    });

    await manager.start("0.4.0-alpha.7");
    expect(await waitFor(manager, "failed")).toMatchObject({
      latestVersion: "0.4.0-alpha.7",
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
    let restarted = 0;
    const manager = new UpdateManager({
      currentVersion: "0.4.0-alpha.6",
      executablePath: oldBinary,
      dirty: false,
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("api.github.com")) return jsonResponse([release("0.4.0-alpha.7")]);
        if (url.endsWith("/release-manifest.json")) {
          return jsonResponse({
            schemaVersion: 1,
            product: "wisp",
            version: "0.4.0-alpha.7",
            apiProtocolVersion: 1,
            commit,
            dirty: false,
            target: { os: "linux", arch: "x86_64", libc: "glibc" },
            artifact: {
              file: "wisp-v0.4.0-alpha.7-linux-x86_64",
              sha256: checksum,
              size: artifact.byteLength,
            },
          });
        }
        return new Response(artifact);
      },
      run: async (_cmd) => ({
        exitCode: 0,
        stdout: JSON.stringify({ version: "0.4.0-alpha.7", commit, dirty: false }),
        stderr: "",
      }),
      detectInstallation: () => ({
        method: "managed-linux",
        supervised: true,
        reason: null,
        installRoot: root,
      }),
      restart: () => {
        restarted++;
      },
      restartDelayMs: 0,
    });

    await manager.start("0.4.0-alpha.7");
    await waitFor(manager, "restarting");
    await Bun.sleep(5);
    const installed = join(root, "versions/0.4.0-alpha.7/wisp");
    expect(readFileSync(installed, "utf8")).toBe("verified executable");
    expect(readlinkSync(join(root, "current"))).toBe(installed);
    expect(readFileSync(oldBinary, "utf8")).toBe("old");
    expect(restarted).toBe(1);
  });
});

describe("update API", () => {
  test("keeps update status and installation behind daemon authentication", async () => {
    const manager = new UpdateManager({
      currentVersion: "0.4.0-alpha.6",
      dirty: false,
      fetch: async () => jsonResponse([release("0.4.0-alpha.7")]),
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
    expect(
      (
        await fetch(`${base}/api/update`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: "0.4.0-alpha.7" }),
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
    const manager = new UpdateManager({
      currentVersion: "0.4.0-alpha.6",
      dirty: false,
      fetch: async () => jsonResponse([release("0.4.0-alpha.7")]),
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
      latestVersion: "0.4.0-alpha.7",
      state: "available",
      canAutoUpdate: false,
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
