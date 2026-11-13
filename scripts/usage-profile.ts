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
 * Tasks are profiled in three cohorts so everyday use is never drowned out by
 * one heavy workflow: standalone (no parent, no subtasks: most tasks),
 * orchestrator (has subtasks) and subtask. Per cohort: what starts each turn
 * (a person, a steer, a subtask report, autopilot, a workflow), how long each
 * signal waits before its turn, how big signals are, where a turn's time goes
 * (spawn, harness boot, first model output, tools, the agent's own `wisp`
 * CLI calls), and how context grows. The biggest orchestrators get a timeline
 * of their own, and the live probes price what each `wisp wait` poll and UI
 * refetch costs today.
 *
 * Options:
 *   --home <dir>        Wisp home (default: $WISP_HOME or ~/.wisp)
 *   --days <n>          only turns started in the last n days (default: all)
 *   --max-diagnostic-turns <n>   newest turns whose diagnostic timing is read (default 600)
 *   --no-live           skip the read-only GETs against the running daemon
 *   --out <file>        output path (default ./wisp-profile-<date>.json)
 *
 * What it writes: counts, byte sizes, durations, token counts, and the names
 * of wisp CLI subcommands and built-in tools. What it never writes: prompt,
 * result, message or tool text, titles, paths, branch names, repo names, MCP
 * server names, or real task ids (tasks are T1, T2, … by turn count). The
 * T-label → task-id mapping goes to a separate *.ids.local.json beside the
 * output: keep that one, do not send it.
 *
 * Nothing is written to the Wisp home. The database is opened read-only, and
 * the live probes are GETs.
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const PROFILE_VERSION = 1;

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
type Dist = { n: number; p50: number | null; p90: number | null; p99: number | null; max: number | null; sum: number };
function dist(values: number[]): Dist {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const q = (p: number) => (v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))]! : null);
  return { n: v.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: v.length ? v[v.length - 1]! : null, sum: Math.round(v.reduce((a, b) => a + b, 0)) };
}
const ms = (a: string | null | undefined, b: string | null | undefined): number => (a && b ? Date.parse(b) - Date.parse(a) : NaN);
const bytes = (s: string | null | undefined) => (s ? Buffer.byteLength(s) : 0);
function columns(table: string): Set<string> {
  try {
    return new Set((db.query(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((r) => r.name));
  } catch {
    return new Set();
  }
}
const has = (table: string, col: string) => columns(table).has(col);
function section<T>(name: string, fn: () => T): T | { unavailable: string } {
  try {
    return fn();
  } catch (e) {
    return { unavailable: `${name}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` };
  }
}
function count<K extends string>(into: Record<string, number>, key: K, by = 1) {
  into[key] = (into[key] ?? 0) + by;
}
function dirStats(dir: string): { files: number; bytes: number } {
  let files = 0, total = 0;
  if (!existsSync(dir)) return { files, bytes: total };
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { files++; total += statSync(p).size; }
    }
  };
  walk(dir);
  return { files, bytes: total };
}

// ---------- load rows ----------
type TaskRow = { id: string; state: string; harness: string; mode: string | null; archived: number; parent_task_id: string | null; subtask_kind: string | null; created_at: string; turn_count: number; context_n: number | null; context_tokens: number | null };
type TurnRow = { id: number; task_id: string; n: number; status: string; started_at: string; ended_at: string | null; harness: string | null; origin: string | null; source_message_id: string | null; usage_json: string | null; prompt: string | null; result: string | null; failure_detail: string | null; context_n: number | null; log_file: string | null; exit_code: number | null };
type MsgRow = { id: string; task_id: string; status: string; delivery: string | null; turn_n: number | null; created_at: string; updated_at: string; origin: string | null; source_json: string | null; workflow_id: string | null; text: string | null; deferred: number | null };

const sel = (table: string, wanted: string[]) => wanted.map((c) => (has(table, c) ? c : `NULL AS ${c}`)).join(", ");
const tasks = db.query(`SELECT ${sel("tasks", ["id", "state", "harness", "mode", "archived", "parent_task_id", "subtask_kind", "created_at", "turn_count", "context_n", "context_tokens"])} FROM tasks`).all() as TaskRow[];
const turns = db.query(`SELECT ${sel("turns", ["id", "task_id", "n", "status", "started_at", "ended_at", "harness", "origin", "source_message_id", "usage_json", "prompt", "result", "failure_detail", "context_n", "log_file", "exit_code"])} FROM turns ${SINCE ? "WHERE started_at >= ?" : ""} ORDER BY task_id, n`).all(...(SINCE ? [SINCE] : [])) as TurnRow[];
const messages = db.query(`SELECT ${sel("task_messages", ["id", "task_id", "status", "delivery", "turn_n", "created_at", "updated_at", "origin", "source_json", "workflow_id", "text", "deferred"])} FROM task_messages ${SINCE ? "WHERE created_at >= ?" : ""}`).all(...(SINCE ? [SINCE] : [])) as MsgRow[];

// ---------- labels and cohorts ----------
const turnsByTask = new Map<string, TurnRow[]>();
for (const t of turns) (turnsByTask.get(t.task_id) ?? turnsByTask.set(t.task_id, []).get(t.task_id)!).push(t);
const childrenOf = new Map<string, TaskRow[]>();
for (const t of tasks) if (t.parent_task_id) (childrenOf.get(t.parent_task_id) ?? childrenOf.set(t.parent_task_id, []).get(t.parent_task_id)!).push(t);
const ranked = [...tasks].sort((a, b) => (turnsByTask.get(b.id)?.length ?? 0) - (turnsByTask.get(a.id)?.length ?? 0));
const label = new Map(ranked.map((t, i) => [t.id, `T${i + 1}`]));

type Cohort = "standalone" | "orchestrator" | "subtask";
/** Everyday use is "standalone": no parent and no subtasks of its own. */
const cohortOf = (t: TaskRow): Cohort => (t.parent_task_id ? "subtask" : childrenOf.has(t.id) ? "orchestrator" : "standalone");
const COHORTS: Cohort[] = ["standalone", "orchestrator", "subtask"];

// ---------- what started each turn ----------
const msgById = new Map(messages.map((m) => [m.id, m]));
type Trigger = string;
const reportKindByMessage = new Map<string, string>();
section("subtask_reports", () => {
  if (!columns("subtask_reports").size) return;
  for (const r of db.query(`SELECT message_id, kind FROM subtask_reports WHERE message_id IS NOT NULL`).all() as { message_id: string; kind: string }[]) reportKindByMessage.set(r.message_id, r.kind);
});
function sourceKind(json: string | null): string | null {
  if (!json) return null;
  try {
    const s = JSON.parse(json) as { by?: string; kind?: string };
    return s.by ? `${s.by}:${s.kind ?? "?"}` : null;
  } catch {
    return null;
  }
}
/** A message's origin as a category; never its text. */
function messageCategory(m: MsgRow): Trigger {
  if (m.origin === "subtask") return `subtask-report:${reportKindByMessage.get(m.id) ?? "?"}`;
  const source = sourceKind(m.source_json);
  if (source) return source; // autopilot:auto-fix, workflow:<kind>, …
  if (m.workflow_id) return "workflow";
  return m.origin ?? "human";
}
function turnTrigger(t: TurnRow): Trigger {
  if (t.origin === "background") return "harness-background";
  if (t.origin === "report") return "report-turn";
  if (t.source_message_id) {
    const m = msgById.get(t.source_message_id);
    return m ? messageCategory(m) : "message(outside window)";
  }
  return t.n === 1 ? "task-create" : "unlinked";
}

// ---------- usage ----------
type Usage = { contextTokens: number; cacheRead: number; cacheCreate: number; input: number; output: number; modelCalls: number };
function usageOf(json: string | null): Usage | null {
  if (!json) return null;
  try {
    const u = JSON.parse(json) as Record<string, any>;
    const iters = Array.isArray(u.iterations) ? u.iterations : [];
    const last = iters.length ? iters[iters.length - 1] : u;
    const ctx = (last.input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0);
    const out = { contextTokens: ctx, cacheRead: u.cache_read_input_tokens ?? 0, cacheCreate: u.cache_creation_input_tokens ?? 0, input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, modelCalls: iters.length || 1 };
    return out.contextTokens + out.output > 0 ? out : null;
  } catch {
    return null;
  }
}

// ---------- diagnostics: per-turn phase timing, tools, wisp CLI calls ----------
// From wispd/src/cli-help.ts (0.8.x), plus a few older or alias names.
const WISP_SUBCOMMANDS = new Set(["serve", "new", "ls", "show", "result", "log", "search", "wait", "report", "send", "interrupt", "workflow", "pr", "review", "verify", "audit", "output", "capture", "fresh", "push", "update", "cleanup", "archive", "export", "purge", "project", "attach", "token", "init", "models", "limits", "version", "doctor", "stream", "subtasks", "merge", "answer", "help", "retention"]);
type Phases = { spawnMs: number; bootMs: number; firstOutputMs: number; wallMs: number; harnessMs: number; apiMs: number; tools: Record<string, number>; toolMs: number; wisp: Record<string, { calls: number; ms: number; outBytes: number }>; resultEvents: number };
const diagDir = join(HOME, "diagnostics");
const diagFiles = new Map<number, string[]>();
section("diagnostic index", () => {
  if (!existsSync(diagDir)) return;
  for (const f of readdirSync(diagDir)) {
    const m = f.match(/^turn-(\d+)-(\d+)\.jsonl$/);
    if (m) { const id = Number(m[1]); (diagFiles.get(id) ?? diagFiles.set(id, []).get(id)!).push(join(diagDir, f)); }
  }
});
function toolBucket(name: string): string {
  if (name.startsWith("mcp__")) return "mcp"; // server names can be company-internal
  return /^[A-Za-z]{1,40}$/.test(name) ? name : "other";
}
/**
 * The subcommand when `wisp` is the program a shell command runs: the first
 * word of a simple command (after `VAR=value` assignments), so a path that
 * merely ends in /wisp (`cd ~/src/wisp && ls`) never counts.
 */
function wispSubcommand(command: string): string | null {
  for (const segment of command.split(/&&|\|\||[;|\n(`]|\$\(/)) {
    const words = segment.trim().split(/\s+/);
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
    if (words[0] === "exec" || words[0] === "time" || words[0] === "command") words.shift();
    const program = words[0]?.split("/").pop();
    if (program !== "wisp" && program !== "wisp-dev") continue;
    const sub = words.slice(1).find((w) => !w.startsWith("-"));
    if (!sub) return "other";
    return WISP_SUBCOMMANDS.has(sub) ? sub : "other";
  }
  return null;
}
/** One harness event, as much of it as the profile reads (Claude stream-json). */
type HarnessEvent = {
  type?: string;
  subtype?: string;
  message?: { content?: Array<{ type?: string; id?: string; name?: string; input?: { command?: unknown }; tool_use_id?: string; content?: unknown }> };
  duration_ms?: unknown;
  duration_api_ms?: unknown;
};

/** Reads one turn's diagnostic records in order and keeps only timings, counts and sizes. */
class TurnTimeline {
  readonly p: Phases;
  private first: string | null = null;
  private init: string | null = null;
  private firstAssistant: string | null = null;
  private readonly open = new Map<string, { at: string; wisp: string | null }>();

  constructor(private readonly turn: TurnRow) {
    this.p = { spawnMs: NaN, bootMs: NaN, firstOutputMs: NaN, wallMs: ms(turn.started_at, turn.ended_at), harnessMs: NaN, apiMs: NaN, tools: {}, toolMs: 0, wisp: {}, resultEvents: 0 };
  }

  record(line: string): void {
    let rec: { recordedAt?: string; source?: string; line?: string };
    try { rec = JSON.parse(line); } catch { return; }
    if (!rec.recordedAt) return;
    this.first ??= rec.recordedAt;
    if (rec.source !== "stdout" || !rec.line) return;
    let ev: HarnessEvent;
    try { ev = JSON.parse(rec.line); } catch { return; }
    if (ev.type === "system" && ev.subtype === "init") this.init ??= rec.recordedAt;
    else if (ev.type === "assistant") this.assistant(ev, rec.recordedAt);
    else if (ev.type === "user") this.toolResults(ev, rec.recordedAt);
    else if (ev.type === "result") this.result(ev);
  }

  private assistant(ev: HarnessEvent, at: string): void {
    this.firstAssistant ??= at;
    for (const c of ev.message?.content ?? []) {
      if (c?.type !== "tool_use" || !c.id) continue;
      count(this.p.tools, toolBucket(String(c.name ?? "")));
      const cmd = typeof c.input?.command === "string" ? c.input.command : "";
      this.open.set(c.id, { at, wisp: cmd ? wispSubcommand(cmd) : null });
    }
  }

  private toolResults(ev: HarnessEvent, at: string): void {
    for (const c of ev.message?.content ?? []) {
      if (c?.type !== "tool_result" || !c.tool_use_id) continue;
      const started = this.open.get(c.tool_use_id);
      if (!started) continue;
      this.open.delete(c.tool_use_id);
      const took = ms(started.at, at);
      if (Number.isFinite(took)) this.p.toolMs += took;
      if (!started.wisp) continue;
      const w = (this.p.wisp[started.wisp] ??= { calls: 0, ms: 0, outBytes: 0 });
      w.calls++;
      if (Number.isFinite(took)) w.ms += took;
      w.outBytes += bytes(typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? ""));
    }
  }

  private result(ev: HarnessEvent): void {
    // The last result is the turn's own; earlier ones (background work) and
    // Claude's API time are not per turn, so neither is summed.
    this.p.resultEvents++;
    if (typeof ev.duration_ms === "number") this.p.harnessMs = ev.duration_ms;
    if (typeof ev.duration_api_ms === "number") this.p.apiMs = ev.duration_api_ms;
  }

  finish(): Phases {
    this.p.spawnMs = ms(this.turn.started_at, this.first);
    this.p.bootMs = ms(this.first, this.init);
    this.p.firstOutputMs = ms(this.init ?? this.first, this.firstAssistant);
    return this.p;
  }
}

function phasesFor(turn: TurnRow): Phases | null {
  const files = diagFiles.get(turn.id);
  if (!files) return null;
  const timeline = new TurnTimeline(turn);
  for (const file of files.sort()) {
    for (const line of readFileSync(file, "utf8").split("\n")) if (line) timeline.record(line);
  }
  return timeline.finish();
}
const diagTurns = new Set(
  [...turns].filter((t) => diagFiles.has(t.id)).sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, MAX_DIAG_TURNS).map((t) => t.id),
);
const phases = new Map<number, Phases>();
for (const t of turns) if (diagTurns.has(t.id)) { const p = section(`diagnostics turn`, () => phasesFor(t)); if (p && !("unavailable" in p)) phases.set(t.id, p); }

// ---------- per-cohort statistics ----------
function cohortStats(cohort: Cohort) {
  const members = tasks.filter((t) => cohortOf(t) === cohort);
  const ids = new Set(members.map((t) => t.id));
  const cTurns = turns.filter((t) => ids.has(t.task_id));
  const cMsgs = messages.filter((m) => ids.has(m.task_id));
  const triggers: Record<string, number> = {};
  const turnWallByTrigger: Record<string, number[]> = {};
  const queueByTrigger: Record<string, number[]> = {};
  const status: Record<string, number> = {};
  const gaps: number[] = [];
  const usage: Usage[] = [];
  for (const [taskId, list] of turnsByTask) {
    if (!ids.has(taskId)) continue;
    for (let i = 1; i < list.length; i++) gaps.push(ms(list[i - 1]!.ended_at, list[i]!.started_at));
  }
  for (const t of cTurns) {
    const trig = turnTrigger(t);
    count(triggers, trig);
    count(status, t.status);
    (turnWallByTrigger[trig] ??= []).push(ms(t.started_at, t.ended_at));
    if (t.source_message_id) {
      const m = msgById.get(t.source_message_id);
      if (m) (queueByTrigger[trig] ??= []).push(ms(m.created_at, t.started_at));
    }
    const u = usageOf(t.usage_json);
    if (u) usage.push(u);
  }
  const steers = cMsgs.filter((m) => m.delivery === "steered");
  const msgBytesByCategory: Record<string, number[]> = {};
  const msgCount: Record<string, number> = {};
  for (const m of cMsgs) {
    const k = messageCategory(m);
    (msgBytesByCategory[k] ??= []).push(bytes(m.text));
    count(msgCount, `${k} ${m.status}${m.delivery ? `/${m.delivery}` : ""}`);
  }
  const ph = cTurns.map((t) => phases.get(t.id)).filter((p): p is Phases => p !== undefined);
  const wisp: Record<string, { calls: number; ms: number; outBytes: number }> = {};
  const tools: Record<string, number> = {};
  for (const p of ph) {
    for (const [k, v] of Object.entries(p.tools)) count(tools, k, v);
    for (const [k, v] of Object.entries(p.wisp)) {
      const w = (wisp[k] ??= { calls: 0, ms: 0, outBytes: 0 });
      w.calls += v.calls; w.ms += v.ms; w.outBytes += v.outBytes;
    }
  }
  const mapDist = (o: Record<string, number[]>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, dist(v)]));
  return {
    tasks: members.length,
    tasksWithTurns: members.filter((t) => turnsByTask.has(t.id)).length,
    turnsPerTask: dist(members.map((t) => turnsByTask.get(t.id)?.length ?? 0).filter((n) => n > 0)),
    turns: cTurns.length,
    turnStatus: status,
    triggers,
    turnWallMsByTrigger: mapDist(turnWallByTrigger),
    /** message created → the turn it started began: how long a signal waited for the agent */
    queueMsByTrigger: mapDist(queueByTrigger),
    /** a message steered into a running turn: created → delivered */
    steerMs: dist(steers.map((m) => ms(m.created_at, m.updated_at))),
    idleBetweenTurnsMs: dist(gaps),
    promptBytes: dist(cTurns.map((t) => bytes(t.prompt))),
    resultBytes: dist(cTurns.map((t) => bytes(t.result))),
    messageBytesByCategory: mapDist(msgBytesByCategory),
    messageOutcomes: msgCount,
    context: {
      /** what the model read on the turn's last call */
      contextTokens: dist(usage.map((u) => u.contextTokens)),
      cacheCreateTokens: dist(usage.map((u) => u.cacheCreate)),
      cacheReadTokens: dist(usage.map((u) => u.cacheRead)),
      outputTokens: dist(usage.map((u) => u.output)),
      modelCallsPerTurn: dist(usage.map((u) => u.modelCalls)),
      turnsWithUsage: usage.length,
    },
    phases: {
      turnsWithDiagnostics: ph.length,
      /** turn row created → first harness output */
      spawnMs: dist(ph.map((p) => p.spawnMs)),
      /** first output → harness init (hooks, MCP servers, session load) */
      bootMs: dist(ph.map((p) => p.bootMs)),
      /** init → first model output */
      firstOutputMs: dist(ph.map((p) => p.firstOutputMs)),
      wallMs: dist(ph.map((p) => p.wallMs)),
      /** the harness's own duration for the turn; wall minus this is Wisp's overhead around it */
      harnessReportedMs: dist(ph.map((p) => p.harnessMs)),
      overheadMs: dist(ph.map((p) => p.wallMs - p.harnessMs)),
      /** Claude's duration_api_ms as reported: can span subagents, so not comparable to wall time */
      harnessApiMs: dist(ph.map((p) => p.apiMs)),
      toolMs: dist(ph.map((p) => p.toolMs)),
      toolCallsPerTurn: dist(ph.map((p) => Object.values(p.tools).reduce((a, b) => a + b, 0))),
    },
    toolCalls: tools,
    /** what the agent ran as `wisp <subcommand>`, how long it blocked, how much it read back */
    wispCli: wisp,
  };
}

// ---------- orchestrator detail ----------
function orchestratorDetail(t: TaskRow) {
  const list = turnsByTask.get(t.id) ?? [];
  const kids = childrenOf.get(t.id) ?? [];
  const usage = list.map((x) => usageOf(x.usage_json));
  const sample = (frac: number) => {
    const i = Math.min(list.length - 1, Math.floor(frac * (list.length - 1)));
    return list.length ? { turn: list[i]!.n, contextTokens: usage[i]?.contextTokens ?? null } : null;
  };
  const span = list.length > 1 ? ms(list[0]!.started_at, list[list.length - 1]!.ended_at ?? list[list.length - 1]!.started_at) : NaN;
  const busy = list.reduce((a, x) => a + (Number.isFinite(ms(x.started_at, x.ended_at)) ? ms(x.started_at, x.ended_at) : 0), 0);
  const triggers: Record<string, number> = {};
  for (const x of list) count(triggers, turnTrigger(x));
  const childKinds: Record<string, number> = {};
  for (const k of kids) count(childKinds, k.subtask_kind ?? "?");
  // Report pipeline: child turn ended → report row → parent turn that took it.
  const reportLatency = section("report latency", () => {
    if (!columns("subtask_reports").size) return null;
    const rows = db.query(`SELECT child_task_id, kind, facts_json, message_id, created_at, state, length(body) AS body_bytes FROM subtask_reports WHERE parent_task_id = ?`).all(t.id) as { child_task_id: string; kind: string; facts_json: string | null; message_id: string | null; created_at: string; state: string; body_bytes: number | null }[];
    const childEndToReport: number[] = [], reportToParentTurn: number[] = [], body: number[] = [];
    const states: Record<string, number> = {};
    for (const r of rows) {
      count(states, `${r.kind}:${r.state}`);
      body.push(r.body_bytes ?? 0);
      try {
        const n = (JSON.parse(r.facts_json ?? "{}") as { turn?: number }).turn;
        const childTurn = n ? turnsByTask.get(r.child_task_id)?.find((x) => x.n === n) : undefined;
        if (childTurn?.ended_at) childEndToReport.push(ms(childTurn.ended_at, r.created_at));
      } catch { /* facts are optional */ }
      const parentTurn = r.message_id ? list.find((x) => x.source_message_id === r.message_id) : undefined;
      const msg = r.message_id ? msgById.get(r.message_id) : undefined;
      if (parentTurn) reportToParentTurn.push(ms(r.created_at, parentTurn.started_at));
      else if (msg?.delivery === "steered") reportToParentTurn.push(ms(r.created_at, msg.updated_at));
    }
    return { reports: rows.length, states, bodyBytes: dist(body), childTurnEndToReportMs: dist(childEndToReport), reportToParentPickupMs: dist(reportToParentTurn) };
  });
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
    triggers,
    contextGrowth: [0, 0.25, 0.5, 0.75, 1].map(sample),
    reportPipeline: reportLatency,
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
    diagnosticTurnsRead: phases.size,
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
    if (pid === String(process.pid)) continue; // this script, run as `BUN_BE_BUN=1 wisp profile.ts`
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
        return { status, ms: dist(runs).p50 !== null ? Number(dist(runs).p50!.toFixed(1)) : null, rawBytes: raw, gzipBytes: gz };
      };
      // Whose detail to read: the biggest tasks, and an ordinary one for comparison.
      const live = ranked.filter((t) => !t.archived);
      const picks = [...live.slice(0, 3), live.find((t) => cohortOf(t) === "standalone" && (turnsByTask.get(t.id)?.length ?? 0) <= 20)].filter((t): t is TaskRow => t !== undefined);
      const perTask = [];
      for (const t of new Set(picks)) {
        perTask.push({
          task: label.get(t.id),
          cohort: cohortOf(t),
          turns: turnsByTask.get(t.id)?.length ?? 0,
          /** what each `wisp wait` / `send` / `result` poll costs today */
          fullDetail: await get(`/api/tasks/${t.id}`),
          conversationPage: await get(`/api/tasks/${t.id}/conversation?limit=50`),
          diff: await get(`/api/tasks/${t.id}/diff`),
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
