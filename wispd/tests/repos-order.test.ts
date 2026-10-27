// PUT /api/repos/order through the real dispatcher: a permutation of the
// configured projects is saved in that order, entry objects untouched; any
// other list is a 409 that changes nothing; and the daemon advertises it.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { BUILTIN_ADAPTERS } from "../src/adapters";
import { CONFIG_PATH, type WispConfig } from "../src/config";
import { route } from "../src/daemon";
import { subscribe, type WispEvent } from "../src/events";
import { testRouteContext } from "./helpers/daemon-context";

const ALPHA = { path: "/projects/alpha", name: "Alpha", setupScript: "make setup", copyFiles: [".env"] };
const BETA = "/projects/beta";
const GAMMA = { path: "/projects/gamma", baseBranch: "develop", verify: { harness: "fake" } };

function config(): WispConfig {
  return {
    instanceId: "123e4567-e89b-42d3-a456-426614174000", port: 0, host: "127.0.0.1", token: "test", webhooks: [],
    repos: [structuredClone(ALPHA), BETA, structuredClone(GAMMA)],
    stuckMinutes: 10, logMaxBytes: 5_000_000, setupTimeoutMinutes: 10, envAllowlist: {}, harnessDefaults: {},
  };
}

/** The config on disk, with a key this Wisp does not know, as a newer one might have left it. */
function writeConfig(cfg: WispConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...cfg, fromANewerWisp: { kept: true } }));
}
const savedConfig = () => JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;

async function reorder(cfg: WispConfig, body: unknown): Promise<Response> {
  const url = new URL("http://wisp.test/api/repos/order");
  const req = new Request(url, { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  return (await route(req, url, url.pathname, testRouteContext(cfg, BUILTIN_ADAPTERS)))!;
}

let unsubscribe: (() => void) | null = null;
afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
});

describe("PUT /api/repos/order", () => {
  test("a permutation is saved in that order, every entry object as it was", async () => {
    const cfg = config();
    writeConfig(cfg);
    const events: WispEvent[] = [];
    unsubscribe = subscribe((evt) => events.push(evt));

    // a trailing slash or a `.` segment names the same project, as GET /api/repos resolves it
    const response = await reorder(cfg, { paths: ["/projects/gamma/", BETA, "/projects/./alpha"] });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ paths: ["/projects/gamma", BETA, "/projects/alpha"] });
    expect(cfg.repos).toEqual([GAMMA, BETA, ALPHA]);
    const saved = savedConfig();
    expect(saved.repos).toEqual([GAMMA, BETA, ALPHA]);
    expect(saved.fromANewerWisp).toEqual({ kept: true });
    expect(events).toContainEqual({ type: "project", action: "reorder", paths: ["/projects/gamma", BETA, "/projects/alpha"] });

    const repos = await route(new Request("http://wisp.test/api/repos"), new URL("http://wisp.test/api/repos"), "/api/repos", testRouteContext(cfg, BUILTIN_ADAPTERS));
    const listed = (await repos!.json()) as { repos: { path: string; configured: boolean }[] };
    expect(listed.repos.filter((repo) => repo.configured).map((repo) => repo.path)).toEqual(["/projects/gamma", BETA, "/projects/alpha"]);
  });

  test("a project listed twice in config moves as one, both entries kept", async () => {
    const cfg = config();
    cfg.repos = [BETA, structuredClone(ALPHA), { path: `${BETA}/`, name: "Beta again" }];
    writeConfig(cfg);

    const response = await reorder(cfg, { paths: [ALPHA.path, BETA] });

    expect(response.status).toBe(200);
    expect(cfg.repos).toEqual([ALPHA, BETA, { path: `${BETA}/`, name: "Beta again" }]);
  });

  for (const [label, paths, detail] of [
    ["a missing project", [GAMMA.path, BETA], "missing: /projects/alpha"],
    ["an extra project", [GAMMA.path, BETA, ALPHA.path, "/projects/delta"], "not a configured project: /projects/delta"],
    ["a duplicate project", [GAMMA.path, BETA, BETA, ALPHA.path], "a project is listed twice"],
    ["a duplicate standing in for a missing one", [GAMMA.path, BETA, BETA], "a project is listed twice"],
    ["many unknown projects, named a few at a time", [ALPHA.path, BETA, GAMMA.path, "/x/1", "/x/2", "/x/3", "/x/4", "/x/5"], "not a configured project: /x/1, /x/2, /x/3 and 2 more"],
  ] as const) {
    test(`${label} is refused with a 409 that changes nothing`, async () => {
      const cfg = config();
      writeConfig(cfg);
      const before = readFileSync(CONFIG_PATH, "utf8");

      const response = await reorder(cfg, { paths });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: `The project list changed since it was loaded. Reload and try again. (${detail})`,
      });
      expect(cfg.repos).toEqual([ALPHA, BETA, GAMMA]);
      expect(readFileSync(CONFIG_PATH, "utf8")).toBe(before);
    });
  }

  for (const [label, body] of [
    ["no paths", {}],
    ["paths that are not a list", { paths: "/projects/alpha" }],
    ["a path that is not a string", { paths: [ALPHA.path, 7, GAMMA.path] }],
    ["an empty path", { paths: [ALPHA.path, "", GAMMA.path] }],
  ] as const) {
    test(`${label} is a 400`, async () => {
      const cfg = config();
      writeConfig(cfg);
      const response = await reorder(cfg, body);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toStartWith("paths must be an array of project paths");
      expect(cfg.repos).toEqual([ALPHA, BETA, GAMMA]);
    });
  }

  test("the daemon advertises it", async () => {
    const url = new URL("http://wisp.test/api/harnesses");
    const response = await route(new Request(url), url, url.pathname, testRouteContext(config(), BUILTIN_ADAPTERS));
    const { features } = (await response!.json()) as { features: Record<string, boolean> };
    expect(features.projectOrder).toBe(true);
  });
});
