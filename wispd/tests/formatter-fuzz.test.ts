/**
 * Display formatters must survive any JSON a harness can write.
 *
 * The recording path (parse, reducers, compactors) was already hardened; the
 * display path was not, and one line whose `message.content` was a string
 * instead of an array threw inside a log stream and took the whole daemon
 * down. This fuzz feeds every builtin event formatter and activity normalizer
 * every captured fixture line, every hand-written seed below, and thousands
 * of deterministic mutations of them: every field replaced by an odd value,
 * every event re-typed as every other type, and seeded random combinations.
 * Nothing may throw. A formatter may render a strange line however it likes
 * (or not at all); it may never take its caller down.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ACTIVITY_NORMALIZERS,
  BUILTIN_ADAPTERS,
  createActivityFormatter,
  createEventFormatter,
  EVENT_FORMATTERS,
  type AdapterDef,
} from "../src/adapters";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Path = (string | number)[];

/** Shapes the formatters switch on that no captured fixture happens to contain. */
const SEEDS: Json[] = [
  { type: "system", subtype: "task_started", task_id: "a1", tool_use_id: "t1", description: "d", task_type: "local_agent", prompt: "p" },
  { type: "system", subtype: "task_notification", tool_use_id: "t1", status: "completed", summary: "s", patch: { status: "completed", end_time: 1 }, usage: { duration_ms: 3 } },
  { type: "assistant", parent_tool_use_id: "t1", message: { model: "m", content: [
    { type: "text", text: "hi" },
    { type: "thinking", thinking: "hmm" },
    { type: "tool_use", id: "t2", name: "Agent", input: { description: "d", prompt: "p", run_in_background: true } },
    { type: "tool_use", id: "t3", name: "Bash", input: { command: "ls" } },
  ] } },
  { type: "user", parent_tool_use_id: "t1", tool_use_result: { agentId: "a", usage: { duration_ms: 1 } }, message: { content: [
    { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "done" }], is_error: false },
    { type: "tool_result", tool_use_id: "t3", content: "out", is_error: true },
  ] } },
  { type: "result", subtype: "success", is_error: true, result: "boom" },
  { type: "message", role: "assistant", id: "m1", text: "Background task completed.\ntask_id: x\nreason: failed\noutput: o" },
  { type: "reasoning", id: "r1", text: "\nthinking" },
  { type: "tool_call", id: "c1", toolName: "Task", parameters: { description: "d", await: false } },
  { type: "tool_call", id: "c2", toolName: "AskUser", parameters: { questionnaire: "1. [question] Which?\n[topic] T\n[option] A\n[option] B" } },
  { type: "tool_call", id: "c3", toolName: "TaskOutput", parameters: { task_id: "x" } },
  { type: "tool_result", id: "c1", value: "task_id: x\nsession_id: y\nreport", isError: false },
  { type: "question", id: "q1", phase: "answered", reason: "stopped", questions: [{ index: 1, topic: "t", question: "q", multiSelect: true, options: ["a"] }], answers: [{ index: 1, answer: "a" }] },
  { type: "completion", finalText: "done", is_error: true },
  { type: "tool_call", subtype: "started", call_id: "k1", tool_call: { taskToolCall: { args: { description: "d", subagentType: { explore: {} } } } } },
  { type: "tool_call", subtype: "completed", call_id: "k1", tool_call: { taskToolCall: { args: {}, result: { success: { agentId: "a", durationMs: 2, conversationSteps: [{ assistantMessage: { text: "r" } }] } } } } },
  { type: "tool_call", subtype: "completed", call_id: "k2", tool_call: { taskToolCall: { result: { error: { message: "no" } } } } },
  { type: "tool_call", subtype: "completed", call_id: "k3", tool_call: { shellToolCall: { args: { command: "ls" }, result: { success: { stdout: "x" } } } } },
  { type: "thread.started", thread_id: "root" },
  { type: "thread.child", thread_id: "child", model: "m", reasoning_effort: "high", agent_role: "r" },
  { type: "subagent.completed", thread_id: "child", status: "failed", error: "e", result: "r", duration_ms: 4 },
  { type: "item.completed", thread_id: "child", item: { id: "i1", type: "collab_tool_call", tool: "spawnAgent", status: "failed", receiver_thread_ids: ["child"], prompt: "line\nmore", error: "e" } },
  { type: "item.completed", item: { id: "i2", type: "collab_tool_call", tool: "wait", agents_states: { child: { status: "completed", message: "m" } } } },
  { type: "item.completed", item: { id: "i3", type: "collab_tool_call", tool: "close_agent", receiver_thread_ids: ["child"] } },
  { type: "item.started", item: { id: "i4", type: "subagent_activity", kind: "started", agent_thread_id: "child", agent_path: "/root/review/" } },
  { type: "item.completed", item: { id: "i5", type: "reasoning", text: "t", summary: "s" } },
  { type: "item.completed", item: { id: "i6", type: "error", message: "m" } },
  { type: "item.completed", item: { id: "i7", type: "file_change", changes: [{ path: "a" }] } },
  { type: "item.started", item: { id: "i8", type: "command_execution", command: "ls" } },
  { type: "item.completed", item: { id: "i8", type: "command_execution", command: "ls", exit_code: 1, aggregated_output: "no\n" } },
  { type: "turn.failed", error: { message: "m" } },
  { type: "error", message: "m", error: { name: "E", data: { message: "m" } } },
  { type: "text", part: { id: "p1", text: "hi" } },
  { type: "tool_use", part: { id: "p2", callID: "c", tool: "bash", state: { status: "error", input: { command: "false" }, error: "x", output: "y" } } },
  { type: "step_finish", part: { reason: "stop" } },
];

/** What a harness might put where a formatter expects something else. */
const ODD: Json[] = [
  null, true, 0, 7, "", "odd", " \n ", [], [null], [7], ["odd"], [[]], [{}], {}, { type: "text" },
  { type: "tool_use" }, { type: "tool_result" }, { text: 7, type: "text" }, { content: {} },
  // shadows Object.prototype.toString, so String() and template literals throw on it
  { toString: 1 }, { toString: 1, valueOf: 1 },
];

function fixtureEvents(): Json[] {
  const dir = join(import.meta.dir, "fixtures");
  const events: Json[] = [];
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      events.push(JSON.parse(line) as Json);
    }
  }
  return events;
}

/** Every container path, bounded so the corpus stays a few seconds of work. */
function paths(value: Json, prefix: Path = [], out: Path[] = []): Path[] {
  if (prefix.length >= 6 || value === null || typeof value !== "object") return out;
  const entries: [string | number, Json][] = Array.isArray(value)
    ? value.slice(0, 3).map((item, index) => [index, item])
    : Object.entries(value);
  for (const [key, child] of entries) {
    const path = [...prefix, key];
    out.push(path);
    paths(child, path, out);
  }
  return out;
}

function withValue(root: Json, path: Path, value: Json | undefined): Json {
  const copy = structuredClone(root);
  let node: any = copy;
  for (const key of path.slice(0, -1)) node = node[key];
  const last = path[path.length - 1]!;
  if (value === undefined) {
    if (Array.isArray(node)) node.splice(Number(last), 1);
    else delete node[last];
  } else {
    node[last] = value;
  }
  return copy;
}

/** Deterministic, so a failure reproduces on every run and every machine. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function corpus(): string[] {
  const seeds = [...fixtureEvents(), ...SEEDS];
  const lines = new Set<string>();
  const add = (event: Json) => lines.add(JSON.stringify(event));
  const types = new Set<string>();
  const itemTypes = new Set<string>();
  for (const seed of seeds) {
    add(seed);
    const record = seed as Record<string, any>;
    if (typeof record.type === "string") types.add(record.type);
    if (typeof record.item?.type === "string") itemTypes.add(record.item.type);
  }
  for (const seed of seeds) {
    // every field replaced by every odd value, and removed
    for (const path of paths(seed)) {
      for (const value of [...ODD, undefined]) add(withValue(seed, path, value));
    }
    // every event re-typed: one harness's body under another's type
    for (const type of types) add({ ...(seed as object), type });
    if ((seed as Record<string, any>).item) {
      for (const type of itemTypes) add(withValue(seed, ["item", "type"], type));
    }
  }
  // combinations no single replacement reaches
  const random = mulberry32(0x5eed);
  const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)]!;
  for (let round = 0; round < 4_000; round++) {
    let event = pick(seeds);
    const mutations = 1 + Math.floor(random() * 3);
    for (let step = 0; step < mutations; step++) {
      const candidates = paths(event);
      if (candidates.length === 0) break;
      const value = random() < 0.2 ? pick(seeds) : pick([...ODD, undefined]);
      event = withValue(event, pick(candidates), value);
    }
    if (random() < 0.3 && event && typeof event === "object" && !Array.isArray(event)) {
      event = { ...event, type: pick([...types]) };
    }
    add(event);
  }
  // not-quite-events: valid JSON that is not a record, and broken JSON
  for (const odd of ODD) lines.add(JSON.stringify(odd));
  lines.add("{");
  lines.add('{"type":');
  lines.add("plain text");
  return [...lines];
}

const LINES = corpus();

function defFor(name: string, activity: boolean): AdapterDef {
  return {
    bin: "fuzz",
    exec: [],
    parse: { format: "json" },
    events: name in EVENT_FORMATTERS ? name : undefined,
    // `activity: null` is the "render the human formatter as prose" fallback
    activity: activity && name in ACTIVITY_NORMALIZERS ? name : null,
  };
}

function throwSites(render: (line: string, sequence: number) => unknown): string[] {
  const sites = new Map<string, string>();
  LINES.forEach((line, sequence) => {
    try {
      render(line, sequence);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const frame = error instanceof Error ? (error.stack?.split("\n").find((entry) => entry.includes("/src/")) ?? "") : "";
      const key = `${message} ${frame.trim()}`;
      if (!sites.has(key)) sites.set(key, `${key}\n    line: ${line.slice(0, 300)}`);
    }
  });
  return [...sites.values()];
}

const STRATEGIES = [...new Set([...Object.keys(EVENT_FORMATTERS), ...Object.keys(ACTIVITY_NORMALIZERS)])].sort();

describe("display formatters never throw on odd JSON", () => {
  test("the corpus is broad enough to mean something", () => {
    expect(LINES.length).toBeGreaterThan(10_000);
    // every builtin names a strategy this fuzz covers
    for (const def of Object.values(BUILTIN_ADAPTERS)) {
      if (def.events) expect(STRATEGIES).toContain(def.events);
      if (def.activity) expect(STRATEGIES).toContain(def.activity);
    }
  });

  for (const name of STRATEGIES) {
    test(`${name}: human event formatter`, () => {
      const format = createEventFormatter(defFor(name, false));
      expect(throwSites((line) => format(line))).toEqual([]);
    });

    test(`${name}: activity normalizer`, () => {
      // one formatter across the corpus, as a turn has: correlation state
      // built by earlier lines must not make a later odd line throw
      const format = createActivityFormatter(defFor(name, true));
      expect(throwSites((line, sequence) => format(line, sequence))).toEqual([]);
    });

    test(`${name}: activity prose fallback (activity: null)`, () => {
      const format = createActivityFormatter(defFor(name, false));
      expect(throwSites((line) => format(line))).toEqual([]);
    });
  }
});
