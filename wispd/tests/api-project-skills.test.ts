import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS_PATH, CONFIG_PATH, type WispConfig } from "../src/config";
import { serve } from "../src/daemon";

/**
 * GET /api/projects/skills — the same registry as the task route, for a
 * project and a harness with no task behind them: the create composer's `/`
 * palette, which describes a task that does not exist yet.
 *
 * What is pinned here is the CONTRACT: only a configured project may be
 * asked about, the answer carries the task route's shape, a harness that
 * needs a session refuses with its own reason instead of an invented list,
 * and two harnesses never share one cached answer.
 */

const token = "web-test-token";
let server: Awaited<ReturnType<typeof serve>> | null = null;

function projectDir(skills: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "wisp-project-skills-"));
  for (const [name, frontmatter] of Object.entries(skills)) {
    mkdirSync(join(root, ".claude", "skills", name), { recursive: true });
    writeFileSync(join(root, ".claude", "skills", name, "SKILL.md"), frontmatter);
  }
  return root;
}

function writeConfig(repos: string[]): void {
  const cfg: WispConfig = {
    instanceId: "123e4567-e89b-42d3-a456-426614174000",
    port: 18710,
    host: "127.0.0.1",
    token,
    webhooks: [],
    repos,
    stuckMinutes: 10,
    logMaxBytes: 5_000_000,
    setupTimeoutMinutes: 10,
    envAllowlist: {},
    harnessDefaults: {},
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
}

async function startServer(repos: string[], opts: Parameters<typeof serve>[0] = {}): Promise<string> {
  writeConfig(repos);
  server = await serve({
    port: 0,
    modelProbeSpawn: () => {
      throw new Error("contract probe failed");
    },
    modelProbeTimeoutMs: 100,
    ...opts,
  });
  return `http://127.0.0.1:${server.port}`;
}

afterEach(async () => {
  if (server) await server.stop(true);
  server = null;
  rmSync(ADAPTERS_PATH, { force: true });
});

async function api(base: string, path: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

describe("GET /api/projects/skills", () => {
  test("claude answers from the project's own skills, says the list is partial, and caches it", async () => {
    let rpcOpened = false;
    const project = projectDir({
      "code-review": "---\nname: code-review\ndescription: Review the pending changes\n---\n",
      shipit: "---\nname: shipit\n---\n",
    });
    const base = await startServer([project], {
      skillOpenRpc: () => {
        rpcOpened = true;
        return { call: () => Promise.resolve({}), close: () => {} };
      },
    });

    const res = await api(base, `/api/projects/skills?project=${encodeURIComponent(project)}&harness=claude`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skills).toEqual([
      { name: "code-review", description: "Review the pending changes" },
      { name: "shipit", description: null },
    ]);
    expect(body.commands).toEqual([]);
    expect(body.commandError).toBeNull();
    expect(body.invoke).toBe("slash");
    // no task means no session has reported its builtins — the same honest note
    expect(body.partialNote).toBe("user and project skills only — no session has reported its builtins yet");
    expect(body.cached).toBe(false);
    expect(rpcOpened).toBe(false);

    const again = await (await api(base, `/api/projects/skills?project=${encodeURIComponent(project)}&harness=claude`)).json();
    expect(again.cached).toBe(true);
  });

  test("only a configured project, and only a known harness, may be asked about", async () => {
    const project = projectDir();
    const base = await startServer([project]);

    expect((await api(base, "/api/projects/skills?harness=claude")).status).toBe(400);
    expect((await api(base, "/api/projects/skills?project=relative/path&harness=claude")).status).toBe(400);
    expect((await api(base, `/api/projects/skills?project=${encodeURIComponent(project)}`)).status).toBe(400);

    const outside = await api(base, `/api/projects/skills?project=${encodeURIComponent(join(tmpdir(), "not-a-wisp-project"))}&harness=claude`);
    expect(outside.status).toBe(404);
    expect((await outside.json()).error).toContain("not a Wisp project");

    const unknown = await api(base, `/api/projects/skills?project=${encodeURIComponent(project)}&harness=nope`);
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toBe("unknown harness: nope");
  });

  test("a harness that needs a session refuses with its own reason, and spawns nothing", async () => {
    let opened = 0;
    const project = projectDir();
    const base = await startServer([project], {
      skillOpenRpc: () => {
        opened += 1;
        return { call: () => Promise.resolve({}), close: () => {} };
      },
    });

    const res = await api(base, `/api/projects/skills?project=${encodeURIComponent(project)}&harness=droid`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("no session yet — the first turn creates one");
    expect(opened).toBe(0);
  });

  test("codex is asked about the project itself, and each harness gets its own cached answer", async () => {
    const project = projectDir({ "code-review": "---\nname: code-review\ndescription: from disk\n---\n" });
    const cwds: unknown[] = [];
    const base = await startServer([project], {
      skillOpenRpc: () => ({
        call(method: string, params?: unknown) {
          if (method === "initialize") return Promise.resolve({});
          if (method === "skills/list") {
            cwds.push((params as { cwds?: unknown }).cwds);
            return Promise.resolve([
              { cwd: project, skills: [{ name: "openai-docs", description: "Codex docs", enabled: true }], errors: [] },
            ]);
          }
          return Promise.reject(new Error(`unexpected ${method}`));
        },
        close: () => {},
      }),
    });

    const codex = await (await api(base, `/api/projects/skills?project=${encodeURIComponent(project)}&harness=codex`)).json();
    expect(cwds).toEqual([[project]]);
    expect(codex.invoke).toBe("prompt"); // codex has no headless /name — the palette must not pretend
    expect(codex.skills).toEqual([{ name: "openai-docs", description: "Codex docs" }]);

    // the same project, a different harness: its own answer, not codex's
    const claude = await (await api(base, `/api/projects/skills?project=${encodeURIComponent(project)}&harness=claude`)).json();
    expect(claude.cached).toBe(false);
    expect(claude.skills).toEqual([{ name: "code-review", description: "from disk" }]);
  });

  test("each project gets its own answer: one project's list is never served for another", async () => {
    const one = projectDir({ "code-review": "---\nname: code-review\ndescription: project one\n---\n" });
    const two = projectDir({ shipit: "---\nname: shipit\ndescription: project two\n---\n" });
    const base = await startServer([one, two]);

    const first = await (await api(base, `/api/projects/skills?project=${encodeURIComponent(one)}&harness=claude`)).json();
    expect(first.skills).toEqual([{ name: "code-review", description: "project one" }]);

    const second = await (await api(base, `/api/projects/skills?project=${encodeURIComponent(two)}&harness=claude`)).json();
    expect(second.cached).toBe(false); // a second project is a second question, not a cache hit
    expect(second.skills).toEqual([{ name: "shipit", description: "project two" }]);

    // and the first project still answers with its own
    const again = await (await api(base, `/api/projects/skills?project=${encodeURIComponent(one)}&harness=claude`)).json();
    expect(again.cached).toBe(true);
    expect(again.skills).toEqual([{ name: "code-review", description: "project one" }]);
  });

  test("an unloaded harness is 404, including a name that is an Object.prototype key", async () => {
    const project = projectDir();
    const base = await startServer([project]);
    for (const harness of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const res = await api(base, `/api/projects/skills?project=${encodeURIComponent(project)}&harness=${encodeURIComponent(harness)}`);
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe(`unknown harness: ${harness}`);
    }
  });

  test("a harness with no discovery strategy gets an honest empty answer, not an error", async () => {
    writeFileSync(
      ADAPTERS_PATH,
      JSON.stringify({ bare: { bin: "true", exec: [], parse: { format: "text" }, attach: null } }),
    );
    const project = projectDir();
    const base = await startServer([project]);

    const res = await api(base, `/api/projects/skills?project=${encodeURIComponent(project)}&harness=bare`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skills).toEqual([]);
    expect(body.commands).toEqual([]);
    expect(body.invoke).toBeNull();
    expect(body.partialNote).toBe("harness 'bare' declares no skill discovery");
  });
});
