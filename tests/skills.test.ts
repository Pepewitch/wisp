import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_ADAPTERS,
  discoverSkills,
  parseOutput,
  ProbeError,
  scanSkillDirs,
  SKILL_STRATEGIES,
  validateAdapters,
  type ProbeIo,
  type RpcSession,
  type SkillCtx,
} from "../src/adapters";
import { TaskSkillCache } from "../src/skills";
import { createTask, freeSlot, getTask, newTaskId, setTaskFields } from "../src/store";

const claude = BUILTIN_ADAPTERS.claude!;
const droid = BUILTIN_ADAPTERS.droid!;
const codex = BUILTIN_ADAPTERS.codex!;

const NO_IO: ProbeIo = {
  spawnOnce: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
  openRpc: () => {
    throw new Error("this strategy spawns nothing");
  },
};

function ctx(over: Partial<SkillCtx> = {}): SkillCtx {
  return { sessionId: "s-1", cwd: null, initSkills: null, ...over };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A scripted RPC peer: method → result, calls recorded, close marked. */
function scriptedRpc(table: Record<string, unknown>) {
  const calls: string[] = [];
  const state = { closed: false };
  return {
    calls,
    state,
    io: {
      ...NO_IO,
      openRpc: (): RpcSession => ({
        call(method) {
          calls.push(method);
          if (!(method in table)) return Promise.reject(new ProbeError(`the harness rejected the probe: ${method}`));
          return Promise.resolve(table[method]);
        },
        close() {
          state.closed = true;
        },
      }),
    } satisfies ProbeIo,
  };
}

describe("scanSkillDirs (A4, the SP2 failure modes)", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function skill(root: string, name: string, frontmatter: string | null): void {
    const d = join(root, name);
    mkdirSync(d, { recursive: true });
    if (frontmatter !== null) writeFileSync(join(d, "SKILL.md"), frontmatter);
  }

  test("a missing root is zero skills, never an error", () => {
    expect(scanSkillDirs(["/no/such/root/exists", null])).toEqual([]);
  });

  test("name and description come from the frontmatter; the dir name stands in for a missing name", () => {
    dir = mkdtempSync(join(tmpdir(), "wisp-skills-"));
    skill(dir, "wisp", "---\nname: wisp\ndescription: Run the wisp task loop\n---\n# wisp\n");
    skill(dir, "bare-name", "---\ndescription: only a description\n---\n");
    skill(dir, "no-skillmd", null); // a skill-shaped dir with no SKILL.md is not a skill
    skill(dir, "broken", "---\n::: not yaml :::\n---\n"); // malformed frontmatter: skipped like all three harnesses do
    mkdirSync(join(dir, ".system"), { recursive: true }); // the harnesses' own internals are never skills
    writeFileSync(join(dir, ".system", "SKILL.md"), "---\nname: hidden\ndescription: nope\n---\n");
    // sorted by name: a palette list is scanned by a person, and readdir
    // order is the filesystem's business
    expect(scanSkillDirs([dir])).toEqual([
      { name: "bare-name", description: "only a description" },
      { name: "wisp", description: "Run the wisp task loop" },
    ]);
  });

  test("a symlinked skill dir is followed — droid and codex both do (find-skills reaches them through one)", () => {
    dir = mkdtempSync(join(tmpdir(), "wisp-skills-"));
    const real = mkdtempSync(join(tmpdir(), "wisp-skills-real-"));
    skill(real, "find-skills", "---\nname: find-skills\ndescription: discover skills\n---\n");
    symlinkSync(join(real, "find-skills"), join(dir, "find-skills"));
    expect(scanSkillDirs([dir])).toEqual([{ name: "find-skills", description: "discover skills" }]);
    rmSync(real, { recursive: true, force: true });
  });
});

describe("repository skill packages", () => {
  const root = join(import.meta.dir, "../skills");

  test("the operational and contributor skills are both discoverable", () => {
    const skills = scanSkillDirs([root]);
    expect(skills.map((skill) => skill.name)).toContain("wisp");
    expect(skills.map((skill) => skill.name)).toContain("wisp-dev");
    expect(skills.find((skill) => skill.name === "wisp-dev")?.description).toContain("Wisp repository");
  });

  test("wisp-dev's optional references stay colocated and selectively linked", () => {
    const dir = join(root, "wisp-dev");
    const entry = readFileSync(join(dir, "SKILL.md"), "utf8");
    const references = [...entry.matchAll(/\]\((references\/[^)#]+)(?:#[^)]+)?\)/g)].map((match) => match[1]!);

    expect(references.sort()).toEqual([
      "references/frontend.md",
      "references/harness-sync.md",
      "references/releasing.md",
      "references/server.md",
    ]);
    for (const reference of references) expect(existsSync(join(dir, reference))).toBe(true);
  });
});

describe("claude-init (A4)", () => {
  test("before the first turn the list is honestly PARTIAL: disk skills only, and it says so", async () => {
    // the disk scan reads the real ~/.claude/skills here, so the LIST itself
    // is unpinnable — what is pinned is that the answer says it is partial
    const result = await discoverSkills(claude, ctx({ initSkills: null }), NO_IO);
    expect(result.partialNote).toBe("user and project skills only — no session has reported its builtins yet");
    expect(result.invoke).toBe("slash");
    expect(result.errors).toEqual([]);
  });

  test("init names union with disk descriptions; a name-only skill renders name-only", async () => {
    const result = await discoverSkills(claude, ctx({ initSkills: ["code-review", "simplify"] }), NO_IO);
    expect(result.partialNote).toBeNull();
    expect(result.skills).toEqual([
      { name: "code-review", description: null },
      { name: "simplify", description: null },
    ]);
  });

  test("the parse captures the init event's list — names, straight off the captured fixture", () => {
    // tests/fixtures/claude-init.jsonl is a sanitized captured init event
    // (claude-code 2.1.240); its skills array preserves the observed shape
    const parsed = parseOutput(claude, '{"type":"system","subtype":"init","session_id":"s","skills":["a","b"]}\n');
    expect(parsed.skills).toEqual(["a", "b"]);
    const without = parseOutput(claude, '{"type":"result","result":"hi"}\n');
    expect(without.skills).toBeNull(); // no init event is not "no skills"
  });
});

describe("factory-jsonrpc skill discovery (droid)", () => {
  // the shape SP2 captured verbatim from droid.list_skills (fields trimmed)
  const LIST = {
    skills: [
      { name: "review", description: "Review code changes", enabled: true, userInvocable: true, filePath: "builtin:review", content: "…89 KB of skill body…" },
      { name: "agent-browser", description: "Browse", enabled: true, userInvocable: false, filePath: "builtin:agent-browser" },
      { name: "find-skills", description: "Discover skills", enabled: true, userInvocable: true, filePath: "/Users/x/.factory/skills/find-skills/SKILL.md" },
      { name: "off-skill", description: "disabled", enabled: false, userInvocable: true, filePath: "builtin:off-skill" },
      { name: "muted", description: "disabledBy user", enabled: true, userInvocable: true, disabledBy: "user", filePath: "builtin:muted" },
      { name: "nameless-ok", userInvocable: true, filePath: "builtin:nameless-ok" }, // droid allows no description
    ],
    projectAvailable: true,
  };

  test("the harness's own filter is honored: userInvocable and enabled, content projected away", async () => {
    const { io, calls, state } = scriptedRpc({ "droid.load_session": { sessionId: "s-1" }, "droid.list_skills": LIST });
    const result = await discoverSkills(droid, ctx(), io);
    expect(calls).toEqual(["droid.load_session", "droid.list_skills"]);
    expect(state.closed).toBe(true);
    expect(result.invoke).toBe("slash");
    expect(result.skills).toEqual([
      { name: "find-skills", description: "Discover skills" },
      { name: "nameless-ok", description: null }, // name-only renders name-only — dropped would be the lie
      { name: "review", description: "Review code changes" },
    ]);
    // the ~500 KB of skill bodies never crosses the boundary
    expect(JSON.stringify(result)).not.toContain("skill body");
  });

  test("no session is a 409 that opens nothing", async () => {
    const { io, calls } = scriptedRpc({});
    const err = await discoverSkills(droid, ctx({ sessionId: null }), io).catch((e) => e);
    expect((err as ProbeError).status).toBe(409);
    expect(calls).toHaveLength(0);
  });
});

describe("codex-app-server skill discovery (codex)", () => {
  // the shape SP2 captured verbatim from skills/list
  const LIST = [
    {
      cwd: "/tmp/wt",
      skills: [
        { name: "openai-docs", description: "Codex docs", enabled: true, path: "/x/SKILL.md", scope: "system" },
        { name: "browser:control", description: "Browser", enabled: true, path: "/y/SKILL.md", scope: "user" },
        { name: "off", description: "disabled", enabled: false, path: "/z/SKILL.md", scope: "user" },
      ],
      errors: [{ message: "Missing 'description' in frontmatter", path: "/bad/SKILL.md" }],
    },
  ];

  test("entries flatten, disabled are filtered, and errors[] is SURFACED verbatim", async () => {
    const { io, calls, state } = scriptedRpc({ initialize: {}, "skills/list": LIST });
    const result = await discoverSkills(codex, ctx({ sessionId: null }), io); // codex needs no session
    expect(calls).toEqual(["initialize", "skills/list"]);
    expect(state.closed).toBe(true);
    expect(result.invoke).toBe("prompt"); // no headless /name on codex — a pick must not pretend
    expect(result.skills).toEqual([
      { name: "browser:control", description: "Browser" },
      { name: "openai-docs", description: "Codex docs" },
    ]);
    expect(result.errors).toEqual(["/bad/SKILL.md: Missing 'description' in frontmatter"]);
  });

  test("a changed payload shape fails loudly, not silently empty", async () => {
    const { io } = scriptedRpc({ initialize: {}, "skills/list": { not: "an array" } });
    const err = await discoverSkills(codex, ctx(), io).catch((e) => e);
    expect(message(err)).toContain("skill list");
  });
});

describe("skillDiscovery validation (A4)", () => {
  const base = { bin: "x", exec: [], parse: { format: "text" } };

  test("an unknown strategy name throws at load; a real one passes; null clears a builtin's", () => {
    expect(() => validateAdapters({ foo: { ...base, skillDiscovery: "nope" } })).toThrow(
      "adapters.json: adapter 'foo'.skillDiscovery must name a builtin skill-discovery strategy (known: claude-init, factory-jsonrpc, codex-app-server) or null, got \"nope\"",
    );
    expect(validateAdapters({ foo: { ...base, skillDiscovery: "claude-init" } }).foo!.skillDiscovery).toBe(
      "claude-init",
    );
    expect(validateAdapters({ claude: { skillDiscovery: null } }).claude!.skillDiscovery).toBeNull();
  });

  test("every builtin's strategy resolves, and droid/codex delete the hardcoded palette", () => {
    expect(claude.skillDiscovery).toBe("claude-init");
    expect(droid.skillDiscovery).toBe("factory-jsonrpc");
    expect(codex.skillDiscovery).toBe("codex-app-server");
    for (const [name, def] of Object.entries(BUILTIN_ADAPTERS)) {
      if (def.skillDiscovery) expect(SKILL_STRATEGIES[def.skillDiscovery], name).toBeTruthy();
    }
  });
});

describe("TaskSkillCache", () => {
  function skillTask(harness = "claude", session: string | null = "s-1", initSkills: string[] | null = ["a-skill"]) {
    const task = createTask({
      id: newTaskId(),
      title: "skill cache test",
      repo_path: "/tmp/repo",
      harness,
      model: null,
      slot: freeSlot(),
    });
    setTaskFields(task.id, {
      session_id: session,
      ...(initSkills !== null ? { skills_json: JSON.stringify(initSkills) } : {}),
    });
    // re-read: createTask's return is the creation-time snapshot
    return getTask(task.id)!;
  }

  test("a second ask inside the TTL is served cached and discovers nothing new", async () => {
    const { io, calls } = scriptedRpc({ "droid.load_session": {}, "droid.list_skills": { skills: [] } });
    const cache = new TaskSkillCache({ openRpc: io.openRpc, ttlMs: 60_000 });
    const task = skillTask("droid");
    const first = await cache.skills(task, droid);
    const second = await cache.skills(task, droid);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.probedAt).toBe(first.probedAt);
    expect(calls.filter((c) => c === "droid.list_skills")).toHaveLength(1);
  });

  test("the task's stored init names reach the claude strategy — that is the whole capture path", async () => {
    const cache = new TaskSkillCache();
    const answer = await cache.skills(skillTask("claude", null, ["verify", "debug"]), claude);
    expect(answer.result.skills.map((s) => s.name)).toEqual(["debug", "verify"]);
    expect(answer.result.partialNote).toBeNull();
  });

  test("a failure is NOT cached — the next ask retries", async () => {
    let opens = 0;
    const io: ProbeIo = {
      ...NO_IO,
      openRpc: () => {
        opens += 1;
        return {
          call: () => Promise.reject(new ProbeError("the harness rejected the probe")),
          close: () => {},
        };
      },
    };
    const cache = new TaskSkillCache({ openRpc: io.openRpc });
    const task = skillTask("droid");
    await cache.skills(task, droid).catch(() => {});
    await cache.skills(task, droid).catch(() => {});
    expect(opens).toBe(2);
  });

  test("a hung discovery dies at the timeout with a named 504", async () => {
    const io: ProbeIo = {
      ...NO_IO,
      openRpc: () => ({ call: () => new Promise<unknown>(() => {}), close: () => {} }),
    };
    const cache = new TaskSkillCache({ openRpc: io.openRpc, timeoutMs: 40 });
    const err = await cache.skills(skillTask("droid"), droid).catch((e) => e);
    expect((err as ProbeError).status).toBe(504);
    expect(message(err)).toContain("timed out");
  });
});
