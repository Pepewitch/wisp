import { describe, expect, test } from "bun:test";
import { BUILTIN_ADAPTERS } from "../src/adapters";
import type { WritableRpcSink } from "../src/adapters/live/json-rpc";
import { CodexLiveProcess } from "../src/live-codex";
import type { LingerHooks, LiveOutputSink, LiveTurn } from "../src/live-input";
import type { Task } from "../src/types";

/**
 * The orderings a Codex Goal's continuations can arrive in, driven by hand:
 * the app-server's frames are fed to the process, and the turn's settle is a
 * promise the test resolves, so a continuation can land at any point of it.
 */

class MemorySink implements WritableRpcSink {
  readonly lines: string[] = [];
  write(data: string): void {
    this.lines.push(data.trimEnd());
  }
  flush(): void {}
  end(): void {}
}

function recorder(): LiveOutputSink & { events: Record<string, any>[] } {
  const events: Record<string, any>[] = [];
  return { events, recordEvent: (event) => events.push(event), recordStdoutLine: () => {}, recordNote: () => {}, recordFrameDrop: () => {} };
}

/** The `nth` request of this method (1-based): a lingering process sends turn/start again. */
async function request(sink: MemorySink, method: string, nth = 1): Promise<Record<string, any>> {
  for (;;) {
    const found = sink.lines.map((line) => JSON.parse(line) as Record<string, any>).filter((frame) => frame.method === method && frame.id !== undefined);
    if (found.length >= nth) return found[nth - 1]!;
    await Bun.sleep(0);
  }
}

/** Let a resolved settle's follow-ups run (a next settle may already be pending). */
const tick = () => Bun.sleep(5);

const THREAD = "goal-thread";
const notify = (method: string, params: Record<string, unknown>) => ({ method, params });
const goal = (status: string) => notify("thread/goal/updated", { threadId: THREAD, goal: { objective: "three steps", status } });
const said = (turnId: string, text: string) => notify("item/completed", { threadId: THREAD, turnId, item: { type: "agentMessage", id: `m-${turnId}`, text } });
const started = (turnId: string) => notify("turn/started", { threadId: THREAD, turn: { id: turnId, status: "inProgress" } });
const completed = (turnId: string) => notify("turn/completed", { threadId: THREAD, turn: { id: turnId, status: "completed", error: null } });

function harness() {
  const sink = new MemorySink();
  const settles: (() => void)[] = [];
  const woke: LiveTurn[] = [];
  let next = 2;
  const hooks: LingerHooks = {
    canLinger: () => true,
    settle: () => new Promise<void>((resolve) => settles.push(resolve)),
    between: () => recorder(),
    wake: () => {
      const turn = { turnId: 100 + next, turn: next, sink: recorder() };
      next += 1;
      woke.push(turn);
      return turn;
    },
    idle: () => {},
  };
  const first = recorder();
  const task = { id: `tgoal${Math.random().toString(36).slice(2, 7)}`, worktree_path: "/tmp", session_id: null, model: null, effort: null, fast: 0 } as unknown as Task;
  const process = new CodexLiveProcess({
    child: {} as never, task, def: BUILTIN_ADAPTERS.codex!, turnId: 1, turn: 1, recorder: first, prompt: "go", attachments: [],
    initialMessageId: "m1", linger: hooks,
  } as never, sink as never);
  const feed = (...frames: Record<string, unknown>[]) => { for (const frame of frames) process.driver.handle(frame as never); };
  return { sink, settles, woke, first, process, feed };
}

async function booted() {
  const h = harness();
  h.feed({ id: (await request(h.sink, "initialize")).id, result: {} });
  h.feed({ id: (await request(h.sink, "thread/start")).id, result: { thread: { id: THREAD } } });
  h.feed({ id: (await request(h.sink, "turn/start")).id, result: { turn: { id: "turn-1" } } });
  await h.process.ready;
  return h;
}

const texts = (sink: { events: Record<string, any>[] }) => sink.events.filter((event) => event.type === "item.completed").map((event) => event.item.text);

describe("Codex Goal continuations, in every order", () => {
  test("two continuations that both run during one slow settle are two turns, each with its own words", async () => {
    const h = await booted();
    h.feed(goal("active"), said("turn-1", "one"), completed("turn-1"));
    expect(h.process.phase).toBe("settling");
    // the settle is slow: turns 2 and 3 run, and the goal completes, before it is done
    h.feed(started("turn-2"), said("turn-2", "two"), completed("turn-2"), started("turn-3"), said("turn-3", "three"), goal("complete"), completed("turn-3"));
    expect(h.woke).toHaveLength(0);
    h.settles.shift()!();
    await tick();
    expect(h.woke).toHaveLength(1);
    expect(texts(h.woke[0]!.sink as never)).toEqual(["two"]);
    // turn 2's answer is in, so it settles too, and only then does turn 3 open
    expect(h.process.phase).toBe("settling");
    h.settles.shift()!();
    await tick();
    expect(h.woke).toHaveLength(2);
    expect(texts(h.woke[1]!.sink as never)).toEqual(["three"]);
    expect(texts(h.first)).toEqual(["one"]);
  });

  test("a message taken while it lingers is not mistaken for a continuation, and a refused one is handed back", async () => {
    const h = await booted();
    h.feed(goal("active"), said("turn-1", "one"), completed("turn-1"));
    h.settles.shift()!();
    await h.process.settled();
    expect(h.process.phase).toBe("lingering");
    const mine = { turnId: 50, turn: 2, sink: recorder() };
    const adopting = h.process.adopt(mine, "next step", [], "m2");
    const start = await request(h.sink, "turn/start", 2);
    // the app-server went on by itself first: its turn/started lands before the answer
    h.feed(started("turn-native"), said("turn-native", "native"));
    expect(h.woke).toHaveLength(0);
    h.feed({ id: start.id, error: { code: -32000, message: "a turn is already in progress" } });
    await expect(adopting).rejects.toThrow("a turn is already in progress");
    // no turn opened behind the runner's back, so it can undo the adoption and queue the message again
    expect(h.woke).toHaveLength(0);
    expect(h.process.phase).toBe("closing");
  });

  test("one read carrying turn/start's answer, the whole turn, and the goal's next turn loses none of them", async () => {
    const h = await booted();
    h.feed(goal("active"), said("turn-1", "one"), completed("turn-1"));
    h.settles.shift()!();
    await tick();
    const mine = { turnId: 52, turn: 2, sink: recorder() };
    const adopting = h.process.adopt(mine, "next step", [], "m4");
    const start = await request(h.sink, "turn/start", 2);
    // handled in one go, before the answer's promise resolves
    h.feed(
      { id: start.id, result: { turn: { id: "turn-2" } } },
      started("turn-2"), said("turn-2", "two"), completed("turn-2"),
      started("turn-3"), said("turn-3", "three"), goal("complete"), completed("turn-3"),
    );
    await adopting;
    expect(texts(mine.sink)).toEqual(["two"]);
    // turn 2 settles, then the goal's own turn 3 opens with its words
    h.settles.shift()!();
    await tick();
    expect(h.woke).toHaveLength(1);
    expect(texts(h.woke[0]!.sink as never)).toEqual(["three"]);
  });

  test("its own turn/started arriving before turn/start's answer is the message's turn", async () => {
    const h = await booted();
    h.feed(goal("active"), said("turn-1", "one"), completed("turn-1"));
    h.settles.shift()!();
    await h.process.settled();
    const mine = { turnId: 51, turn: 2, sink: recorder() };
    const adopting = h.process.adopt(mine, "next step", [], "m3");
    const start = await request(h.sink, "turn/start", 2);
    h.feed(started("turn-2"));
    h.feed({ id: start.id, result: { turn: { id: "turn-2" } } });
    await adopting;
    h.feed(said("turn-2", "two"), goal("complete"), completed("turn-2"));
    expect(h.woke).toHaveLength(0);
    expect(texts(mine.sink)).toEqual(["two"]);
  });
});
