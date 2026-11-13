#!/usr/bin/env bun
/**
 * Wisp usage profile: read-only, numbers only. It shows what real use costs,
 * so performance work can be ranked by it rather than by guesses.
 *
 * From a checkout: `bun run profile:usage [options]`. The file is
 * self-contained (no imports from this repository), so it also runs on any
 * machine with Wisp installed: copy this one file over and run it with the
 * Bun the wisp binary embeds:
 *
 *   BUN_BE_BUN=1 wisp usage-profile.ts
 *   BUN_BE_BUN=1 wisp usage-profile.ts --days 30 --no-live
 *
 * Cohorts keep everyday use from being drowned out by one heavy workflow:
 * standalone (no parent, no subtasks), orchestrator, subtask. Per cohort:
 * what starts turns, how long signals wait, how big they are. Per cohort and
 * harness, from diagnostic records: where a turn's time goes (spawn, boot,
 * first output, tools, the agent's `wisp` calls against its other shell
 * calls) and the context carried. Orchestrators get a timeline, including why
 * each subtask report waited. Live probes price today's CLI and UI reads.
 *
 * Options: --home <dir> (default $WISP_HOME or ~/.wisp), --days <n>,
 * --max-diagnostic-turns <n> (default 600), --no-live, --out <file>.
 *
 * Writes counts, sizes, durations, tokens, wisp subcommand names and tool
 * categories. Never text, titles, paths, repo/branch/MCP names or real task
 * ids (tasks are T1…Tn by turn count; the mapping goes to *.ids.local.json,
 * which stays on the machine). Read-only: the database is opened read-only
 * and the live probes are GETs.
 *
 * Context is read as wispd reads it (wispd/src/adapters/context.ts): the
 * prompt of the turn's last main-session model call, never the usage blob,
 * which is a billing sum over every call. Droid and cursor state no context,
 * so they report none rather than a wrong number.
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const PROFILE_VERSION = 2;

// ---------- args ----------
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const HOME = opt("home") ?? process.env.WISP_HOME ?? join(homedir(), ".wisp");
const DAYS = opt("days") ? Number(opt("days")) : null;
const MAX_DIAG_TURNS = Number(opt("max-diagnostic-turns") ?? 600);
const LIVE = !flag("no-live");
const OUT = opt("out") ?? `wisp-profile-${new Date().toISOString().slice(0, 10)}.json`;
const SINCE = DAYS ? new Date(Date.now() - DAYS * 86_400_000).toISOString() : null;

const dbPath = join(HOME, "wisp.db");
if (!existsSync(dbPath)) {
  console.error(`no Wisp database at ${dbPath} (pass --home <dir>)`);
  process.exit(1);
}
const db = new Database(dbPath, { readonly: true });

// ---------- helpers ----------
type Dist = { n: number; min: number | null; p50: number | null; p90: number | null; p99: number | null; max: number | null; sum: number };
function dist(values: number[]): Dist {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const q = (p: number) => (v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))]! : null);
  return { n: v.length, min: v.length ? v[0]! : null, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: v.length ? v[v.length - 1]! : null, sum: Math.round(v.reduce((a, b) => a + b, 0)) };
}
const ms = (a: string | null | undefined, b: string | null | undefined): number => (a && b ? Date.parse(b) - Date.parse(a) : NaN);
const bytes = (s: string | null | undefined) => (s ? Buffer.byteLength(s) : 0);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** A section that fails (an older schema, a missing file) reports why instead of ending the profile. */
function section<T>(name: string, fn: () => T): T | { unavailable: string } {
  try { return fn(); } catch (e) { return { unavailable: `${name}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` }; }
}
function columns(table: string): Set<string> {
  try { return new Set((db.query(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((r) => r.name)); } catch { return new Set(); }
}
const has = (table: string, col: string) => columns(table).has(col);
const count = (into: Record<string, number>, key: string, by = 1) => void (into[key] = (into[key] ?? 0) + by);
const push = <V>(into: Record<string, V[]>, key: string, value: V) => void (into[key] ??= []).push(value);
const mapDist = (o: Record<string, number[]>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, dist(v)]));
function dirStats(dir: string): { files: number; bytes: number } {
  const out = { files: 0, bytes: 0 };
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) { out.files++; out.bytes += statSync(join(e.parentPath, e.name)).size; }
  }
  return out;
}

// ---------- load rows ----------
type TaskRow = { id: string; state: string; harness: string; mode: string | null; archived: number; parent_task_id: string | null; subtask_kind: string | null; created_at: string; turn_count: number; context_n: number | null; context_tokens: number | null };
type TurnRow = { id: number; task_id: string; n: number; status: string; started_at: string; ended_at: string | null; harness: string | null; origin: string | null; source_message_id: string | null; usage_json: string | null; prompt: string | null; result: string | null };
type MsgRow = { id: string; task_id: string; status: string; delivery: string | null; turn_n: number | null; created_at: string; updated_at: string; origin: string | null; source_json: string | null; workflow_id: string | null; text: string | null };

const sel = (table: string, wanted: string[]) => wanted.map((c) => (has(table, c) ? c : `NULL AS ${c}`)).join(", ");
const tasks = db.query(`SELECT ${sel("tasks", ["id", "state", "harness", "mode", "archived", "parent_task_id", "subtask_kind", "created_at", "turn_count", "context_n", "context_tokens"])} FROM tasks`).all() as TaskRow[];
const turns = db.query(`SELECT ${sel("turns", ["id", "task_id", "n", "status", "started_at", "ended_at", "harness", "origin", "source_message_id", "usage_json", "prompt", "result"])} FROM turns ${SINCE ? "WHERE started_at >= ?" : ""} ORDER BY task_id, n`).all(...(SINCE ? [SINCE] : [])) as TurnRow[];
const messages = db.query(`SELECT ${sel("task_messages", ["id", "task_id", "status", "delivery", "turn_n", "created_at", "updated_at", "origin", "source_json", "workflow_id", "text"])} FROM task_messages ${SINCE ? "WHERE created_at >= ?" : ""}`).all(...(SINCE ? [SINCE] : [])) as MsgRow[];
/** The daemon's cap on running turns (config.json maxConcurrentTasks; wispd's default is 100). */
const MAX_CONCURRENT = section("config", () => num(rec(JSON.parse(readFileSync(join(HOME, "config.json"), "utf8"))).maxConcurrentTasks) ?? 100);
const maxConcurrent = typeof MAX_CONCURRENT === "number" ? MAX_CONCURRENT : 100;

// ---------- labels and cohorts ----------
const turnsByTask = new Map<string, TurnRow[]>();
for (const t of turns) (turnsByTask.get(t.task_id) ?? turnsByTask.set(t.task_id, []).get(t.task_id)!).push(t);
const childrenOf = new Map<string, TaskRow[]>();
for (const t of tasks) if (t.parent_task_id) (childrenOf.get(t.parent_task_id) ?? childrenOf.set(t.parent_task_id, []).get(t.parent_task_id)!).push(t);
const taskById = new Map(tasks.map((t) => [t.id, t]));
const ranked = [...tasks].sort((a, b) => (turnsByTask.get(b.id)?.length ?? 0) - (turnsByTask.get(a.id)?.length ?? 0));
const label = new Map(ranked.map((t, i) => [t.id, `T${i + 1}`]));
const harnessOf = (t: TurnRow) => t.harness ?? taskById.get(t.task_id)?.harness ?? "?";

type Cohort = "standalone" | "orchestrator" | "subtask";
/** Everyday use is "standalone": no parent and no subtasks of its own. */
const cohortOf = (t: TaskRow): Cohort => (t.parent_task_id ? "subtask" : childrenOf.has(t.id) ? "orchestrator" : "standalone");
const COHORTS: Cohort[] = ["standalone", "orchestrator", "subtask"];

// ---------- what started each turn ----------
const msgById = new Map(messages.map((m) => [m.id, m]));
const reportKindByMessage = new Map<string, string>();
section("subtask_reports", () => {
  if (!columns("subtask_reports").size) return;
  for (const r of db.query(`SELECT message_id, kind FROM subtask_reports WHERE message_id IS NOT NULL`).all() as { message_id: string; kind: string }[]) reportKindByMessage.set(r.message_id, r.kind);
});
/** JSON from a column, or {} when it is empty or unreadable. */
function parsed(json: string | null): Record<string, unknown> {
  try { return json ? rec(JSON.parse(json)) : {}; } catch { return {}; }
}
function sourceKind(json: string | null): string | null {
  const s = parsed(json);
  return typeof s.by === "string" ? `${s.by}:${typeof s.kind === "string" ? s.kind : "?"}` : null;
}
/** A message's origin as a category; never its text. */
function messageCategory(m: MsgRow): string {
  if (m.origin === "subtask") return `subtask-report:${reportKindByMessage.get(m.id) ?? "?"}`;
  const source = sourceKind(m.source_json);
  if (source) return source; // autopilot:auto-fix, workflow:<kind>, …
  if (m.workflow_id) return "workflow";
  return m.origin ?? "human";
}
function turnTrigger(t: TurnRow): string {
  if (t.origin === "background") return "harness-background";
  if (t.origin === "report") return "report-turn";
  if (t.source_message_id) {
    const m = msgById.get(t.source_message_id);
    return m ? messageCategory(m) : "message(outside window)";
  }
  return t.n === 1 ? "task-create" : "unlinked";
}

// ---------- billing (claude only) ----------
/**
 * A turn's usage blob is BILLING: summed over every model call the turn made.
 * Only claude's field names are read, so harnesses whose blobs mean something
 * else are never mixed in. Never used as context.
 */
function claudeBilling(json: string | null): { cacheRead: number; cacheCreate: number; output: number } | null {
  const u = parsed(json);
  const out = { cacheRead: num(u.cache_read_input_tokens) ?? 0, cacheCreate: num(u.cache_creation_input_tokens) ?? 0, output: num(u.output_tokens) ?? 0 };
  return out.cacheRead + out.cacheCreate + out.output > 0 ? out : null;
}

// ---------- shell commands and tools ----------
// From wispd/src/cli-help.ts (0.8.x), plus a few older or alias names.
const WISP_SUBCOMMANDS = new Set(["serve", "new", "ls", "show", "result", "log", "search", "wait", "report", "send", "interrupt", "workflow", "pr", "review", "verify", "audit", "output", "capture", "fresh", "push", "update", "cleanup", "archive", "export", "purge", "project", "attach", "token", "init", "models", "limits", "version", "doctor", "stream", "subtasks", "merge", "answer", "help", "retention"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish"]);

/**
 * The subcommand when `wisp` is the program a shell command runs: the first
 * word of a simple command (after `VAR=value` assignments), so a path that
 * merely ends in /wisp (`cd ~/src/wisp && ls`) never counts. A command run
 * through a shell (`/bin/zsh -lc "wisp new …"`, as codex wraps every one) is
 * unwrapped first.
 */
function wispSubcommand(command: string, depth = 0): string | null {
  for (const segment of command.split(/&&|\|\||[;|\n(`]|\$\(/)) {
    const words = segment.trim().split(/\s+/);
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
    if (words[0] === "exec" || words[0] === "time" || words[0] === "command") words.shift();
    const program = words[0]?.split("/").pop() ?? "";
    if (depth === 0 && SHELLS.has(program)) {
      const flagIndex = words.findIndex((w) => /^-[a-z]*c$/.test(w));
      if (flagIndex > 0) {
        const inner = segment.trim().split(/\s+-[a-z]*c\s+/).slice(1).join(" ").replace(/^["']|["']$/g, "");
        const sub = wispSubcommand(inner, depth + 1);
        if (sub) return sub;
      }
      continue;
    }
    if (program !== "wisp" && program !== "wisp-dev") continue;
    const sub = words.slice(1).find((w) => !w.startsWith("-"));
    return sub && WISP_SUBCOMMANDS.has(sub) ? sub : "other";
  }
  return null;
}

/** A tool's category across harnesses; MCP server names can be company-internal, so they never appear. */
function toolKind(raw: string): string {
  const name = raw.toLowerCase().replace(/toolcall$/, "");
  if (name.startsWith("mcp")) return "mcp";
  if (/^(bash|shell|execute|run|command_execution|exec|terminal)/.test(name)) return "shell";
  if (/^(read|view|cat|open)/.test(name)) return "read";
  if (/(edit|write|patch|create|file_change|delete|str_replace)/.test(name)) return "edit";
  if (/^(grep|glob|ls|list|search|find|codebase)/.test(name)) return "search";
  if (/^web/.test(name)) return "web";
  if (/(task|agent|subagent|collab|spawn)/.test(name)) return "subagent";
  if (/^(todo|plan)/.test(name)) return "plan";
  return "other";
}

// ---------- diagnostics: one turn's timeline ----------
type ToolCall = { kind: string; ms: number; wisp: string | null; outBytes: number };
type TurnTiming = {
  harness: string;
  spawnMs: number;
  bootMs: number;
  firstOutputMs: number;
  wallMs: number;
  harnessMs: number;
  contextTokens: number | null;
  modelCalls: number | null;
  tools: ToolCall[];
};
type Ev = Record<string, unknown>;
type Content = { type?: string; id?: string; name?: string; input?: { command?: unknown }; tool_use_id?: string; content?: unknown };

/**
 * Reads one turn's diagnostic records in order and keeps only timings,
 * counts, sizes and token numbers. One reader for every harness: the event
 * families do not overlap (claude/cursor `assistant` + `tool_use`, cursor
 * `tool_call` started/completed, droid `tool_call`/`tool_result` and
 * `create_message` notifications, codex `item.*` and `turn.completed`,
 * opencode `step_*` and `tool_use`), and live drivers record the same
 * shapes as their one-shot formats.
 */
class TurnTimeline {
  private first: string | null = null;
  private init: string | null = null;
  private firstOutput: string | null = null;
  private context: number | null = null;
  private harnessMs = NaN;
  private readonly calls = new Set<string>();
  private readonly open = new Map<string, { at: string; kind: string; wisp: string | null }>();
  private readonly tools: ToolCall[] = [];

  constructor(private readonly turn: TurnRow, private readonly harness: string) {}

  record(line: string): void {
    let r: { recordedAt?: string; source?: string; line?: string };
    try { r = JSON.parse(line); } catch { return; }
    if (!r.recordedAt) return;
    this.first ??= r.recordedAt;
    if (r.source !== "stdout" || !r.line) return;
    let ev: Ev;
    try { ev = rec(JSON.parse(r.line)); } catch { return; }
    this.phase(ev, r.recordedAt);
    this.toolEvent(ev, r.recordedAt);
    this.contextEvent(ev);
    if (ev.type === "result" && num(ev.duration_ms) !== null) this.harnessMs = num(ev.duration_ms)!;
  }

  private phase(ev: Ev, at: string): void {
    const type = String(ev.type ?? "");
    if ((type === "system" && ev.subtype === "init") || type === "thread.started" || type === "turn.started" || type === "step_start") {
      this.init ??= at;
      return;
    }
    const droidMessage = rec(rec(rec(ev.params).notification).message);
    const output =
      (type === "assistant" && ev.parent_tool_use_id == null) ||
      type.startsWith("item.") ||
      type === "tool_call" || type === "text" || type === "tool_use" ||
      (type === "notification" && droidMessage.role === "assistant");
    if (output) this.firstOutput ??= at;
  }

  private start(id: string, at: string, name: string, command: unknown): void {
    this.open.set(id, { at, kind: toolKind(name), wisp: typeof command === "string" ? wispSubcommand(command) : null });
  }

  private finish(id: string, at: string, output: unknown): void {
    const started = this.open.get(id);
    if (!started) return;
    this.open.delete(id);
    this.tools.push({ kind: started.kind, ms: ms(started.at, at), wisp: started.wisp, outBytes: bytes(typeof output === "string" ? output : JSON.stringify(output ?? "")) });
  }

  private toolEvent(ev: Ev, at: string): void {
    const type = ev.type;
    if (type === "assistant" || type === "user") this.messageTools(ev, at);
    else if (type === "tool_call" || type === "tool_result") this.callTools(ev, at);
    else if (type === "item.started" || type === "item.completed") this.codexItem(ev, at);
    else if (type === "tool_use") this.tools.push({ kind: toolKind(String(rec(ev.part).tool ?? "")), ms: NaN, wisp: null, outBytes: 0 }); // opencode: finished tools only
    else if (type === "step_finish") this.calls.add(String(rec(ev.part).id ?? this.calls.size));
  }

  /** claude and cursor messages: tool_use / tool_result content, and one id per main-session model call. */
  private messageTools(ev: Ev, at: string): void {
    for (const c of (rec(ev.message).content as Content[] | undefined) ?? []) {
      if (c?.type === "tool_use" && c.id) this.start(c.id, at, String(c.name ?? ""), c.input?.command);
      if (c?.type === "tool_result" && c.tool_use_id) this.finish(c.tool_use_id, at, c.content);
    }
    if (ev.type !== "assistant" || ev.parent_tool_use_id != null) return;
    const id = typeof ev.model_call_id === "string" ? ev.model_call_id : rec(ev.message).id;
    if (typeof id === "string") this.calls.add(id);
  }

  /** cursor `tool_call` started/completed ({ <name>ToolCall: { args, result } }), droid `tool_call` / `tool_result`. */
  private callTools(ev: Ev, at: string): void {
    if (ev.type === "tool_result") return this.finish(String(ev.id ?? ""), at, ev.value);
    if (ev.subtype !== "started" && ev.subtype !== "completed") {
      return this.start(String(ev.id ?? ""), at, String(ev.toolName ?? ev.toolId ?? ""), rec(ev.parameters).command);
    }
    const [name, body] = Object.entries(rec(ev.tool_call))[0] ?? ["", {}];
    if (ev.subtype === "started") this.start(String(ev.call_id ?? ""), at, name, rec(rec(body).args).command);
    else this.finish(String(ev.call_id ?? ""), at, rec(body).result);
  }

  private codexItem(ev: Ev, at: string): void {
    const item = rec(ev.item);
    const kind = String(item.type ?? "");
    if (kind === "agent_message" || kind === "reasoning" || kind === "error" || kind === "subagent_activity") return;
    const id = String(item.id ?? "");
    const name = kind === "collab_tool_call" ? "subagent" : kind === "mcp_tool_call" ? "mcp" : kind;
    if (ev.type === "item.started") this.start(id, at, name, item.command);
    else if (this.open.has(id)) this.finish(id, at, item.aggregated_output);
    else this.tools.push({ kind: toolKind(name), ms: NaN, wisp: typeof item.command === "string" ? wispSubcommand(item.command) : null, outBytes: bytes(String(item.aggregated_output ?? "")) });
  }

  /** wispd/src/adapters/context.ts, read the same way: the last main-session call's prompt. */
  private contextEvent(ev: Ev): void {
    if (ev.type === "system" && ev.subtype === "compact_boundary") {
      const post = num(rec(ev.compact_metadata).post_tokens);
      if (post !== null && post > 0) this.context = post;
    } else if (ev.type === "assistant" && ev.parent_tool_use_id == null && this.harness === "claude") {
      const u = rec(rec(ev.message).usage);
      const used = (num(u.input_tokens) ?? 0) + (num(u.cache_read_input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0);
      if (used > 0) this.context = used;
    } else if (ev.type === "turn.completed") {
      const used = num(rec(Object.keys(rec(ev.last_usage)).length ? ev.last_usage : ev.usage).input_tokens);
      if (used !== null && used > 0) this.context = used; // codex nests cached inside input: never add them
    } else if (ev.type === "step_finish") {
      const tokens = rec(rec(ev.part).tokens);
      const cache = rec(tokens.cache);
      const used = (num(tokens.input) ?? 0) + (num(cache.read) ?? 0) + (num(cache.write) ?? 0);
      if (used > 0) this.context = used;
    }
  }

  summary(): TurnTiming {
    const statesContext = this.harness === "claude" || this.harness === "codex" || this.harness === "opencode";
    return {
      harness: this.harness,
      spawnMs: ms(this.turn.started_at, this.first),
      bootMs: ms(this.first, this.init),
      firstOutputMs: ms(this.init ?? this.first, this.firstOutput),
      wallMs: ms(this.turn.started_at, this.turn.ended_at),
      harnessMs: this.harnessMs,
      contextTokens: statesContext ? this.context : null,
      modelCalls: this.calls.size > 0 ? this.calls.size : null,
      tools: this.tools,
    };
  }
}

const diagDir = join(HOME, "diagnostics");
const diagFiles = new Map<number, string[]>();
section("diagnostic index", () => {
  if (!existsSync(diagDir)) return;
  for (const f of readdirSync(diagDir)) {
    const m = f.match(/^turn-(\d+)-(\d+)\.jsonl$/);
    if (m) {
      const id = Number(m[1]);
      (diagFiles.get(id) ?? diagFiles.set(id, []).get(id)!).push(join(diagDir, f));
    }
  }
});
function timingFor(turn: TurnRow): TurnTiming | null {
  const files = diagFiles.get(turn.id);
  if (!files) return null;
  const timeline = new TurnTimeline(turn, harnessOf(turn));
  for (const file of files.sort()) {
    for (const line of readFileSync(file, "utf8").split("\n")) if (line) timeline.record(line);
  }
  return timeline.summary();
}
const diagTurns = new Set(
  [...turns].filter((t) => diagFiles.has(t.id)).sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, MAX_DIAG_TURNS).map((t) => t.id),
);
const timings = new Map<number, TurnTiming>();
for (const t of turns) {
  if (!diagTurns.has(t.id)) continue;
  const timing = section("diagnostics turn", () => timingFor(t));
  if (timing && !("unavailable" in timing)) timings.set(t.id, timing);
}

// ---------- per-harness timing for a set of turns ----------
function harnessTiming(list: TurnTiming[]) {
  const toolsByKind: Record<string, number[]> = {};
  const wispMs: Record<string, number[]> = {};
  const wispOut: Record<string, number> = {};
  const shellBaseline: number[] = [];
  for (const t of list) {
    for (const call of t.tools) {
      push(toolsByKind, call.kind, call.ms);
      if (call.wisp) {
        push(wispMs, call.wisp, call.ms);
        count(wispOut, call.wisp, call.outBytes);
      } else if (call.kind === "shell") shellBaseline.push(call.ms);
    }
  }
  return {
    turns: list.length,
    /** turn row created → first harness output */
    spawnMs: dist(list.map((t) => t.spawnMs)),
    /** first output → the harness's init/start event (hooks, MCP servers, session load) */
    bootMs: dist(list.map((t) => t.bootMs)),
    /** init → first model output or tool call */
    firstOutputMs: dist(list.map((t) => t.firstOutputMs)),
    wallMs: dist(list.map((t) => t.wallMs)),
    /** the harness's own duration (claude, cursor); wall minus this is Wisp's overhead around it */
    harnessReportedMs: dist(list.map((t) => t.harnessMs)),
    overheadMs: dist(list.map((t) => t.wallMs - t.harnessMs)),
    /** tokens the model carried on the turn's last main-session call (claude, codex, opencode only) */
    contextTokens: dist(list.map((t) => t.contextTokens ?? NaN)),
    modelCallsPerTurn: dist(list.map((t) => t.modelCalls ?? NaN)),
    toolCallsPerTurn: dist(list.map((t) => t.tools.length)),
    toolMsPerCallByKind: mapDist(toolsByKind),
    /** every shell call that was not `wisp`: what a CLI call costs in this harness anyway */
    shellBaselineMsPerCall: dist(shellBaseline),
    /** the agent's own `wisp <subcommand>` calls, per call */
    wispCliMsPerCall: mapDist(wispMs),
    wispCliOutBytes: wispOut,
  };
}

// ---------- per-cohort statistics ----------
function cohortStats(cohort: Cohort) {
  const members = tasks.filter((t) => cohortOf(t) === cohort);
  const ids = new Set(members.map((t) => t.id));
  const cTurns = turns.filter((t) => ids.has(t.task_id));
  const cMsgs = messages.filter((m) => ids.has(m.task_id));
  const triggers: Record<string, number> = {};
  const turnsByHarness: Record<string, number> = {};
  const turnWallByTrigger: Record<string, number[]> = {};
  const queueByTrigger: Record<string, number[]> = {};
  const status: Record<string, number> = {};
  const gaps: number[] = [];
  const billing: { cacheRead: number; cacheCreate: number; output: number }[] = [];
  for (const [taskId, list] of turnsByTask) {
    if (!ids.has(taskId)) continue;
    for (let i = 1; i < list.length; i++) gaps.push(ms(list[i - 1]!.ended_at, list[i]!.started_at));
  }
  for (const t of cTurns) {
    const trig = turnTrigger(t);
    count(triggers, trig);
    count(status, t.status);
    count(turnsByHarness, harnessOf(t));
    push(turnWallByTrigger, trig, ms(t.started_at, t.ended_at));
    const m = t.source_message_id ? msgById.get(t.source_message_id) : undefined;
    if (m) push(queueByTrigger, trig, ms(m.created_at, t.started_at));
    const b = harnessOf(t) === "claude" ? claudeBilling(t.usage_json) : null;
    if (b) billing.push(b);
  }
  const steerByCategory: Record<string, number[]> = {};
  const msgBytesByCategory: Record<string, number[]> = {};
  const msgCount: Record<string, number> = {};
  for (const m of cMsgs) {
    const k = messageCategory(m);
    push(msgBytesByCategory, k, bytes(m.text));
    count(msgCount, `${k} ${m.status}${m.delivery ? `/${m.delivery}` : ""}`);
    if (m.delivery === "steered") push(steerByCategory, k, ms(m.created_at, m.updated_at));
  }
  const timingByHarness: Record<string, TurnTiming[]> = {};
  for (const t of cTurns) {
    const timing = timings.get(t.id);
    if (timing) push(timingByHarness, timing.harness, timing);
  }
  const currentContext: Record<string, number[]> = {};
  for (const t of members) if (t.context_tokens) push(currentContext, t.harness, t.context_tokens);
  return {
    tasks: members.length,
    tasksWithTurns: members.filter((t) => turnsByTask.has(t.id)).length,
    turnsPerTask: dist(members.map((t) => turnsByTask.get(t.id)?.length ?? 0).filter((n) => n > 0)),
    turns: cTurns.length,
    turnsByHarness,
    turnStatus: status,
    triggers,
    turnWallMsByTrigger: mapDist(turnWallByTrigger),
    /** message created → the turn it started began: how long a signal waited for the agent */
    queueMsByTrigger: mapDist(queueByTrigger),
    /** a message steered into a running turn: created → delivered. Reports are held up to 5 min first, on purpose */
    steerMsByCategory: mapDist(steerByCategory),
    idleBetweenTurnsMs: dist(gaps),
    promptBytes: dist(cTurns.map((t) => bytes(t.prompt))),
    resultBytes: dist(cTurns.map((t) => bytes(t.result))),
    messageBytesByCategory: mapDist(msgBytesByCategory),
    messageOutcomes: msgCount,
    /** wispd's own reading of each task's context now (tasks.context_tokens), by harness */
    currentContextTokensByHarness: mapDist(currentContext),
    /** claude turns only: BILLING sums over every model call in a turn, never context */
    claudeBilledPerTurn: {
      turns: billing.length,
      cacheReadTokens: dist(billing.map((b) => b.cacheRead)),
      cacheCreateTokens: dist(billing.map((b) => b.cacheCreate)),
      outputTokens: dist(billing.map((b) => b.output)),
    },
    /** from the newest turns' diagnostic records (--max-diagnostic-turns) */
    timingByHarness: Object.fromEntries(Object.entries(timingByHarness).map(([h, list]) => [h, harnessTiming(list)])),
  };
}

// ---------- orchestrator detail ----------
type ReportRow = { child_task_id: string; kind: string; facts_json: string | null; message_id: string | null; created_at: string; state: string; body_bytes: number | null };
/** Turns running at `at`, across the whole daemon, for the slot check. */
const turnIntervals = turns.map((t) => [Date.parse(t.started_at), t.ended_at ? Date.parse(t.ended_at) : Infinity] as const);
const runningAt = (at: number) => turnIntervals.reduce((n, [s, e]) => (s <= at && at < e ? n + 1 : n), 0);

/**
 * Why a report waited before its parent took it. "parent-busy": a parent
 * turn was running, and reports never interrupt (wispd subtask-delivery.ts;
 * steered in only after 5 min). "no-free-slot": the daemon was at
 * maxConcurrentTasks. "parent-idle": neither, so anything long here is
 * something else holding it (the parent needing the person, a hold after
 * Stop) or a delivery delay worth looking at.
 */
function reportPipeline(parent: TaskRow, list: TurnRow[]) {
  const rows = db.query(`SELECT child_task_id, kind, facts_json, message_id, created_at, state, length(body) AS body_bytes FROM subtask_reports WHERE parent_task_id = ?`).all(parent.id) as ReportRow[];
  const childEndToReport: number[] = [], body: number[] = [];
  const pickupByCause: Record<string, number[]> = {};
  const busyRemainingMs: number[] = [];
  const states: Record<string, number> = {};
  const delivery: Record<string, number> = {};
  for (const r of rows) {
    count(states, `${r.kind}:${r.state}`);
    body.push(r.body_bytes ?? 0);
    // only a turn report follows a turn's end; question/stuck reports land mid-turn
    const n = r.kind === "turn" ? num(parsed(r.facts_json).turn) : null;
    const childTurn = n !== null ? turnsByTask.get(r.child_task_id)?.find((x) => x.n === n) : undefined;
    if (childTurn?.ended_at) childEndToReport.push(ms(childTurn.ended_at, r.created_at));
    const msg = r.message_id ? msgById.get(r.message_id) : undefined;
    const parentTurn = r.message_id ? list.find((x) => x.source_message_id === r.message_id) : undefined;
    const pickedAt = parentTurn?.started_at ?? (msg?.delivery === "steered" ? msg.updated_at : null);
    if (!pickedAt) continue;
    count(delivery, msg?.delivery ?? "started");
    const at = Date.parse(r.created_at);
    const busy = list.find((x) => Date.parse(x.started_at) <= at && (!x.ended_at || at < Date.parse(x.ended_at)));
    const cause = busy ? "parent-busy" : runningAt(at) >= maxConcurrent ? "no-free-slot" : "parent-idle";
    push(pickupByCause, cause, ms(r.created_at, pickedAt));
    if (busy?.ended_at) busyRemainingMs.push(ms(r.created_at, busy.ended_at));
  }
  return {
    reports: rows.length,
    states,
    delivery,
    bodyBytes: dist(body),
    childTurnEndToReportMs: dist(childEndToReport),
    reportToParentPickupMsByCause: mapDist(pickupByCause),
    /** for parent-busy reports: how much of that parent turn was left when the report arrived */
    parentBusyRemainingMs: dist(busyRemainingMs),
  };
}

function orchestratorDetail(t: TaskRow) {
  const list = turnsByTask.get(t.id) ?? [];
  const kids = childrenOf.get(t.id) ?? [];
  const span = list.length > 1 ? ms(list[0]!.started_at, list[list.length - 1]!.ended_at ?? list[list.length - 1]!.started_at) : NaN;
  const busy = list.reduce((a, x) => a + (Number.isFinite(ms(x.started_at, x.ended_at)) ? ms(x.started_at, x.ended_at) : 0), 0);
  const triggers: Record<string, number> = {};
  for (const x of list) count(triggers, turnTrigger(x));
  const childKinds: Record<string, number> = {};
  for (const k of kids) count(childKinds, k.subtask_kind ?? "?");
  const measured = list.map((x) => ({ turn: x.n, contextTokens: timings.get(x.id)?.contextTokens ?? null })).filter((x) => x.contextTokens !== null);
  const sample = (frac: number) => measured[Math.min(measured.length - 1, Math.floor(frac * (measured.length - 1)))] ?? null;
  return {
    task: label.get(t.id),
    harness: t.harness,
    state: t.state,
    turns: list.length,
    subtasks: kids.length,
    subtaskKinds: childKinds,
    subtaskTurns: dist(kids.map((k) => turnsByTask.get(k.id)?.length ?? 0)),
    spanHours: Number.isFinite(span) ? Number((span / 3_600_000).toFixed(1)) : null,
    turnsPerActiveHour: Number.isFinite(span) && span > 0 ? Number((list.length / (span / 3_600_000)).toFixed(2)) : null,
    busyShare: Number.isFinite(span) && span > 0 ? Number((busy / span).toFixed(3)) : null,
    compactions: t.context_n ?? null,
    /** wispd's own reading of the context it carries now */
    currentContextTokens: t.context_tokens ?? null,
    triggers,
    /** context on the turns whose diagnostic records were read, sampled across them */
    contextGrowth: measured.length ? [0, 0.25, 0.5, 0.75, 1].map(sample) : [],
    reportPipeline: columns("subtask_reports").size ? section("report pipeline", () => reportPipeline(t, list)) : null,
  };
}

// ---------- assemble ----------
const profile: Record<string, unknown> = {
  meta: {
    profileVersion: PROFILE_VERSION,
    generatedAt: new Date().toISOString(),
    windowDays: DAYS,
    platform: `${process.platform}-${process.arch}`,
    bun: Bun.version,
    schemaMigrations: section("migrations", () => (db.query(`SELECT count(*) AS n FROM schema_migrations`).get() as { n: number }).n),
    maxConcurrentTasks: maxConcurrent,
    privacy: "numbers only; tasks relabelled T1..Tn by turn count; no text, titles, paths or ids",
  },
  storage: section("storage", () => ({
    dbBytes: statSync(dbPath).size,
    walBytes: existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0,
    logs: dirStats(join(HOME, "logs")),
    diagnostics: dirStats(diagDir),
    turnTextBytes: section("turn_texts", () => (db.query(`SELECT coalesce(sum(bytes),0) AS b, count(*) AS n FROM turn_texts`).get() as { b: number; n: number })),
  })),
  population: {
    tasks: tasks.length,
    live: tasks.filter((t) => !t.archived).length,
    archived: tasks.filter((t) => t.archived).length,
    byCohort: Object.fromEntries(COHORTS.map((c) => [c, tasks.filter((t) => cohortOf(t) === c).length])),
    byHarness: tasks.reduce((o, t) => (count(o, t.harness), o), {} as Record<string, number>),
    byMode: tasks.reduce((o, t) => (count(o, t.mode ?? "worktree"), o), {} as Record<string, number>),
    liveByState: tasks.filter((t) => !t.archived).reduce((o, t) => (count(o, t.state), o), {} as Record<string, number>),
    turnsInWindow: turns.length,
    messagesInWindow: messages.length,
    diagnosticTurnsRead: timings.size,
  },
  cohorts: Object.fromEntries(COHORTS.map((c) => [c, section(`cohort ${c}`, () => cohortStats(c))])),
  orchestrators: section("orchestrators", () =>
    ranked.filter((t) => childrenOf.has(t.id) || (turnsByTask.get(t.id)?.length ?? 0) >= 200).slice(0, 5).map(orchestratorDetail)),
  autoReview: section("auto_review_rounds", () => {
    if (!columns("auto_review_rounds").size) return null;
    const rows = db.query(`SELECT state, created_at, finished_at FROM auto_review_rounds ${SINCE ? "WHERE created_at >= ?" : ""}`).all(...(SINCE ? [SINCE] : [])) as { state: string; created_at: string; finished_at: string | null }[];
    return { rounds: rows.length, states: rows.reduce((o, r) => (count(o, r.state), o), {} as Record<string, number>), durationMs: dist(rows.map((r) => ms(r.created_at, r.finished_at))) };
  }),
  workflows: section("workflows", () => ({
    workflows: (db.query(`SELECT count(*) AS n FROM workflows`).get() as { n: number }).n,
    wakes: columns("workflow_wakes").size ? (db.query(`SELECT count(*) AS n FROM workflow_wakes`).get() as { n: number }).n : null,
  })),
  audit: section("task_audit", () => {
    const rows = db.query(`SELECT action, actor FROM task_audit ${SINCE ? "WHERE at >= ?" : ""}`).all(...(SINCE ? [SINCE] : [])) as { action: string; actor: string }[];
    const out: Record<string, number> = {};
    for (const r of rows) count(out, `${r.action} by ${r.actor.startsWith("agent:") ? "agent" : r.actor.startsWith("workflow:") ? "workflow" : r.actor}`);
    return out;
  }),
  outbox: section("outbox", () => db.query(`SELECT (delivered_at IS NOT NULL) AS delivered, (dead_at IS NOT NULL) AS dead, count(*) AS n, max(attempts) AS maxAttempts FROM outbox GROUP BY 1, 2`).all()),
};

// ---------- processes ----------
profile.processes = section("processes", () => {
  // `cpu` is ps's decaying average, not an instant reading. Only processes
  // whose executable is wisp count: the daemon, and CLI calls in flight right
  // now (a pile of `wait` here is agents polling). The executable comes from
  // `comm`, never from splitting a command line: paths have spaces
  // ("Wisp Daemon.app"), and other programs' arguments can mention wisp.
  const lines = (fields: string) => Bun.spawnSync(["ps", "-axo", `pid=,${fields}`]).stdout.toString().split("\n");
  const exe = new Map<string, string>();
  for (const line of lines("comm=")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (m) exe.set(m[1]!, m[2]!);
  }
  const out = { daemon: [] as { cpu: number; rssMB: number; uptime: string }[], cli: {} as Record<string, number> };
  for (const line of lines("pcpu=,rss=,etime=,args=")) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, cpu, rss, etime, args] = m;
    if (pid === String(process.pid)) continue; // this script, run as `BUN_BE_BUN=1 wisp usage-profile.ts`
    const path = exe.get(pid!) ?? "";
    const program = path.split("/").pop();
    if (program !== "wisp" && program !== "wisp-dev") continue;
    const rest = (args!.startsWith(path) ? args!.slice(path.length) : args!.split(/\s+/).slice(1).join(" ")).trim().split(/\s+/);
    const sub = rest.find((w) => w && !w.startsWith("-")) ?? "";
    if (sub === "serve") out.daemon.push({ cpu: Number(cpu), rssMB: Math.round(Number(rss) / 1024), uptime: etime! });
    else count(out.cli, WISP_SUBCOMMANDS.has(sub) ? sub : "other");
  }
  return out;
});

// ---------- live probes (read-only GETs) ----------
if (LIVE) {
  profile.live = await (async () => {
    try {
      const cfg = JSON.parse(readFileSync(join(HOME, "config.json"), "utf8")) as { host?: string; port?: number; token?: string };
      const origin = `http://${cfg.host && cfg.host !== "0.0.0.0" ? cfg.host : "127.0.0.1"}:${cfg.port}`;
      const health = await fetch(`${origin}/api/health`).then((r) => r.json()).catch(() => null) as { version?: string } | null;
      if (!health) return { unavailable: "daemon not reachable" };
      const get = async (path: string) => {
        const runs: number[] = [];
        let raw = 0, gz = 0, status = 0;
        for (let i = 0; i < 3; i++) {
          const started = performance.now();
          const r = await fetch(origin + path, { headers: { authorization: `Bearer ${cfg.token}`, "accept-encoding": "identity" } });
          const body = new Uint8Array(await r.arrayBuffer());
          runs.push(performance.now() - started);
          raw = body.byteLength; status = r.status;
          if (i === 0) gz = gzipSync(body, { level: 5 }).byteLength;
        }
        const p50 = dist(runs).p50;
        return { status, ms: p50 !== null ? Number(p50.toFixed(1)) : null, rawBytes: raw, gzipBytes: gz };
      };
      // Whose detail to read: the biggest live tasks, the biggest orchestrators
      // (archived or not: what their CLI reads cost), and an ordinary task.
      const live = ranked.filter((t) => !t.archived);
      const orchestrators = ranked.filter((t) => childrenOf.has(t.id)).slice(0, 2);
      const ordinary = live.find((t) => cohortOf(t) === "standalone" && (turnsByTask.get(t.id)?.length ?? 0) <= 20);
      const picks = [...new Set([...orchestrators, ...live.slice(0, 3), ...(ordinary ? [ordinary] : [])])];
      const perTask = [];
      for (const t of picks) {
        perTask.push({
          task: label.get(t.id),
          cohort: cohortOf(t),
          archived: t.archived === 1,
          turns: turnsByTask.get(t.id)?.length ?? 0,
          /** what each `wisp wait` / `send` / `result` / `show` call reads today */
          fullDetail: await get(`/api/tasks/${t.id}`),
          conversationPage: await get(`/api/tasks/${t.id}/conversation?limit=50`),
          diff: t.archived ? null : await get(`/api/tasks/${t.id}/diff`),
          subtasks: childrenOf.has(t.id) ? await get(`/api/tasks/${t.id}/subtasks`) : null,
        });
      }
      return {
        daemonVersion: health.version ?? null,
        taskListLive: await get(`/api/tasks?cleanup=1`),
        taskListArchived: await get(`/api/tasks?archived=1`),
        status: await get(`/api/status`),
        perTask,
      };
    } catch (e) {
      return { unavailable: e instanceof Error ? e.message : String(e) };
    }
  })();
}

// ---------- write ----------
writeFileSync(OUT, `${JSON.stringify(profile, null, 2)}\n`);
const idsFile = OUT.replace(/\.json$/, "") + ".ids.local.json";
writeFileSync(idsFile, `${JSON.stringify(Object.fromEntries([...label].map(([id, l]) => [l, id]).slice(0, 50)), null, 2)}\n`);
const pop = profile.population as { tasks: number; turnsInWindow: number; diagnosticTurnsRead: number; byCohort: Record<string, number> };
console.log(`wrote ${OUT} (${(statSync(OUT).size / 1024).toFixed(1)} KB): ${pop.tasks} tasks (${Object.entries(pop.byCohort).map(([k, v]) => `${v} ${k}`).join(", ")}), ${pop.turnsInWindow} turns, ${pop.diagnosticTurnsRead} with timing`);
console.log(`kept locally, do not send: ${idsFile} (T-label → task id)`);
