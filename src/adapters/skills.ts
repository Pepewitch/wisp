import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../version";
import { ProbeError } from "./probe";
import type {
  AdapterDef,
  ProbeIo,
  SkillCtx,
  SkillDiscoveryResult,
  SkillEntry,
  SkillStrategy,
} from "./types";

/**
 * Skill discovery (v0.3 A4, settled by SP2). The palette's Tier 3 is the
 * harness's OWN skill list, enumerated cheaply and honestly — not a hardcoded
 * list that rots. SP2 settled the shape: a pure filesystem scan finds 0 of
 * claude's 17 skills and 1 of droid's 21 (builtins are not files), so each
 * harness uses its native surface, with the frontmatter scan as the honest
 * PARTIAL fallback — and a partial list always says it is partial.
 *
 * The named failure modes are SP2's and the strategies honor them verbatim:
 * a missing root is zero skills, never an error; a directory without a
 * SKILL.md is not a skill; malformed frontmatter is skipped; a name-only
 * skill (droid allows it) renders a name-only row; disabled skills are
 * filtered out rather than offered and refused.
 */

/**
 * The one thing all three harnesses share (SP2): a skill is a directory with
 * a `SKILL.md` whose frontmatter carries `name` and `description`. Scan the
 * given roots for that shape. A missing root is ZERO SKILLS, never an error
 * (claude proves it: `~/.claude/skills` doesn't exist on the spiked machine
 * and claude reports 17 builtins without complaint). Symlinked skill dirs are
 * followed — droid and codex both do (find-skills reaches them through one).
 */
export function scanSkillDirs(roots: (string | null)[]): SkillEntry[] {
  const found = new Map<string, SkillEntry>();
  for (const root of roots) {
    if (!root) continue;
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue; // absent, unreadable, or not a directory — all mean "no skills here"
    }
    for (const name of names) {
      if (name.startsWith(".")) continue; // .system, .trash — the harnesses' own internals
      const file = join(root, name, "SKILL.md");
      let text: string;
      try {
        if (!statSync(file).isFile()) continue; // stat follows the symlink; no SKILL.md = not a skill
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const entry = frontmatter(text, name);
      if (entry && !found.has(entry.name)) found.set(entry.name, entry); // first root wins: personal over project is the harnesses' order too
    }
  }
  // a palette list is scanned by a person — readdir order is the filesystem's
  // business, so the answer is sorted here, once
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The frontmatter's name and description — nothing else is wisp's business.
 * Malformed frontmatter skips the skill, exactly like all three harnesses do
 * (SP2: only codex reports the skip back, and that arrives via its RPC, not
 * this scan). The directory name stands in for a missing `name:` — the
 * convention `<name>/SKILL.md` IS the invoke name — but a block with NEITHER
 * key is junk, not a skill.
 */
function frontmatter(text: string, dirName: string): SkillEntry | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  let name: string | null = null;
  let description: string | null = null;
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!kv) continue; // a nested or continuation line — not ours
    const value = kv[2]!.trim().replace(/^["']|["']$/g, "");
    if (kv[1] === "name" && value) name = value;
    if (kv[1] === "description" && value) description = value;
  }
  if (name === null && description === null) return null;
  return { name: name ?? dirName, description };
}

/** The fields a record must carry to be a skill row at all; everything else is optional and copied, never invented. */
function skillRow(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  return typeof r.name === "string" && r.name.length > 0 ? r : null;
}

function desc(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export const SKILL_STRATEGIES: Record<string, SkillStrategy> = {
  /**
   * claude (SP2): names for free from the session's init event (Wisp already
   * parses it — persisted as `skills_json` at turn finalize), unioned with
   * the `~/.claude/skills` + `.claude/skills` frontmatter scan, which is the
   * only place descriptions live. Before the first turn there IS no init
   * event, so the list is user/project skills only — and says so.
   */
  "claude-init": {
    invoke: "slash", // `--bare`: "skills still resolve via /skill-name" (SP2)
    discover(_def, ctx, _io) {
      const byName = new Map<string, SkillEntry>();
      for (const name of ctx.initSkills ?? []) byName.set(name, { name, description: null });
      for (const s of scanSkillDirs([join(homedir(), ".claude", "skills"), ctx.cwd ? join(ctx.cwd, ".claude", "skills") : null])) {
        byName.set(s.name, s); // disk carries the descriptions (SP2: the init event is names-only)
      }
      return Promise.resolve({
        skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
        errors: [],
        partialNote:
          ctx.initSkills === null
            ? "user and project skills only — no session has reported its builtins yet"
            : null,
      });
    },
  },

  /**
   * droid (SP2): `droid.list_skills` over the same JSON-RPC client A3's probe
   * opens — it is the ONLY complete surface (20 of 21 skills are
   * `builtin:<name>`, invisible to any scan). The response carries `content`
   * (~500 KB of skill bodies) which is projected away HERE, at the boundary,
   * and never stored. `userInvocable` is the harness's own palette filter —
   * the five false ones are exactly the skills that must not appear as
   * `/name` — and `enabled`/`disabledBy` are honored rather than offering a
   * skill that will refuse.
   */
  "factory-jsonrpc": {
    invoke: "slash", // SP1: a slash prompt naming a skill routes to the Skill tool (verified with /review)
    async discover(def, ctx, io) {
      if (!ctx.sessionId) throw new ProbeError("no session yet — the first turn creates one", 409);
      const rpc = io.openRpc([def.bin, "exec", "--input-format", "stream-jsonrpc", "-o", "stream-jsonrpc"], {
        cwd: ctx.cwd ?? undefined,
        envelope: "factory",
        signal: ctx.signal,
      });
      try {
        await rpc.call("droid.load_session", { sessionId: ctx.sessionId });
        const raw = await rpc.call("droid.list_skills", {});
        const r =
          typeof raw === "object" && raw !== null && Array.isArray((raw as Record<string, unknown>).skills)
            ? (raw as { skills: unknown[] })
            : (() => {
                throw new ProbeError("the harness's skill list is not a JSON object — the protocol shape may have changed");
              })();
        const skills = r.skills
          .map(skillRow)
          .filter((s): s is Record<string, unknown> => s !== null)
          .filter((s) => s.userInvocable === true && s.enabled !== false && !s.disabledBy)
          .map((s) => ({ name: s.name as string, description: desc(s.description) }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return { skills, errors: [], partialNote: null };
      } finally {
        rpc.close(); // a read never leaves the harness session running
      }
    },
  },

  /**
   * codex (SP2): `skills/list` on the app-server — the plan's "expect
   * nothing" was refuted (38 skills with real descriptions), but there is no
   * headless `/name` invocation, so `invoke: "prompt"` keeps a pick honest:
   * it prefills a plain-text ask and still costs a turn. The response's
   * `errors[]` (skills codex could not parse) is surfaced verbatim — a
   * malformed skill silently vanishing is the absence this product refuses.
   * Needs no session: the reads are the disk's, not the thread's.
   */
  "codex-app-server": {
    invoke: "prompt",
    async discover(def, ctx, io) {
      const rpc = io.openRpc([def.bin, "app-server"], { envelope: "plain", signal: ctx.signal });
      try {
        await rpc.call("initialize", { clientInfo: { name: "wisp", version: VERSION } });
        const raw = await rpc.call("skills/list", { cwds: ctx.cwd ? [ctx.cwd] : [], forceReload: false });
        if (!Array.isArray(raw)) {
          throw new ProbeError("the harness's skill list is not a JSON array — the protocol shape may have changed");
        }
        const skills: SkillEntry[] = [];
        const errors: string[] = [];
        for (const entry of raw) {
          if (typeof entry !== "object" || entry === null) continue;
          const e = entry as { skills?: unknown; errors?: unknown };
          if (Array.isArray(e.skills)) {
            for (const s of e.skills) {
              const row = skillRow(s);
              if (!row || row.enabled === false) continue;
              skills.push({ name: row.name as string, description: desc(row.description) });
            }
          }
          if (Array.isArray(e.errors)) {
            for (const err of e.errors) {
              const r = err as Record<string, unknown>;
              if (typeof r?.message === "string") {
                errors.push(typeof r.path === "string" ? `${r.path}: ${r.message}` : r.message);
              }
            }
          }
        }
        skills.sort((a, b) => a.name.localeCompare(b.name));
        return { skills, errors, partialNote: null };
      } finally {
        rpc.close();
      }
    },
  },
};

/** Strategy lookup; an unknown name is loud (unreachable through adapters.json, which validates at load). */
export function discoverSkills(def: AdapterDef, ctx: SkillCtx, io: ProbeIo): Promise<SkillDiscoveryResult> {
  const name = def.skillDiscovery;
  const strategy = name ? SKILL_STRATEGIES[name] : undefined;
  if (!name || !strategy) {
    const known = Object.keys(SKILL_STRATEGIES).join(", ");
    throw new ProbeError(
      `adapter skillDiscovery strategy '${name}' is not a known strategy (known: ${known})`,
      500,
    );
  }
  return strategy.discover(def, ctx, io).then((result) => ({ ...result, invoke: strategy.invoke }));
}
