import { QueryClient, type QueryKey } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { qk } from "./query";
import { connectEventsBridge, SSE_CLOSED, type SseLike } from "./sse";
import type { TaskDetail, WispEvent } from "./types";

/** A scriptable EventSource: emit frames, flip readyState, watch lifecycle. */
class FakeSse implements SseLike {
  onmessage: ((ev: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  closed = false;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(): void {
    // the events bridge uses onmessage; named frames belong to the log stream
  }

  close(): void {
    this.closed = true;
    this.readyState = SSE_CLOSED;
  }

  emit(evt: WispEvent): void {
    this.onmessage?.({ data: JSON.stringify(evt) });
  }

  emitRaw(data: string): void {
    this.onmessage?.({ data });
  }

  openUp(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** transient drop: the browser keeps retrying (readyState CONNECTING) */
  transientError(): void {
    this.readyState = 0;
    this.onerror?.();
  }

  /** hard failure (e.g. 401): readyState CLOSED, no browser retry */
  hardError(): void {
    this.readyState = SSE_CLOSED;
    this.onerror?.();
  }
}

interface Harness {
  client: QueryClient;
  sources: FakeSse[];
  ensureSession: ReturnType<typeof vi.fn<() => Promise<void>>>;
  connectionLog: boolean[];
  reconnectCount: () => number;
  close: () => void;
}

function bridge(selectedId: string | null = "t1"): Harness {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const sources: FakeSse[] = [];
  const ensureSession = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const connectionLog: boolean[] = [];
  let reconnects = 0;
  const close = connectEventsBridge({
    client,
    getSelectedId: () => selectedId,
    ensureSession,
    factory: (url) => {
      const src = new FakeSse(url);
      sources.push(src);
      return src;
    },
    onConnectionChange: (live) => connectionLog.push(live),
    onReconnect: () => reconnects++,
    tasksDebounceMs: 0,
    statusDebounceMs: 0,
    detailDebounceMs: 0,
    reconnectDelayMs: 0,
  });
  return { client, sources, ensureSession, connectionLog, reconnectCount: () => reconnects, close };
}

function seed(client: QueryClient): void {
  client.setQueryData(qk.tasksList(false), []);
  client.setQueryData(qk.status, { tasks: {} });
  client.setQueryData(qk.task("t1"), { id: "t1", state: "done", state_detail: null });
  client.setQueryData(qk.diff("t1"), { kind: "ok", diff: "", truncated: false, untracked: [] });
}

const invalidated = (client: QueryClient, key: QueryKey): boolean => client.getQueryState(key)?.isInvalidated === true;

describe("the /api/events → queryClient bridge", () => {
  it("a task event invalidates the list and status, and echoes the selected task's state", () => {
    const h = bridge("t1");
    seed(h.client);
    h.sources[0]!.emit({ type: "task", taskId: "t1", state: "running", stateDetail: "turn 2 running", seq: 9 });

    expect(invalidated(h.client, qk.tasksList(false))).toBe(true);
    expect(invalidated(h.client, qk.status)).toBe(true);
    expect(invalidated(h.client, qk.task("t1"))).toBe(true);
    expect(invalidated(h.client, qk.diff("t1"))).toBe(true);
    // the optimistic echo: the header flips before the refetch lands
    const detail = h.client.getQueryData<TaskDetail>(qk.task("t1"));
    expect(detail?.state).toBe("running");
    expect(detail?.state_detail).toBe("turn 2 running");
    h.close();
  });

  it("a task event for another task touches only the list and status", () => {
    const h = bridge("t1");
    seed(h.client);
    h.sources[0]!.emit({ type: "task", taskId: "t9", state: "done", stateDetail: null, seq: 2 });

    expect(invalidated(h.client, qk.tasksList(false))).toBe(true);
    expect(invalidated(h.client, qk.status)).toBe(true);
    expect(invalidated(h.client, qk.task("t1"))).toBe(false);
    expect(invalidated(h.client, qk.diff("t1"))).toBe(false);
    // no echo onto a task the event wasn't about
    h.client.setQueryData(qk.task("t1"), { id: "t1", state: "creating", state_detail: null });
    h.sources[0]!.emit({ type: "task", taskId: "t9", state: "running", stateDetail: null, seq: 4 });
    expect(h.client.getQueryData<TaskDetail>(qk.task("t1"))?.state).toBe("creating");
    h.close();
  });

  it("a rename event patches task caches without invalidating unrelated data", () => {
    const h = bridge("t1");
    seed(h.client);
    h.client.setQueryData(qk.tasksList(false), [{ id: "t1", title: "Before", updated_at: "before" }]);

    h.sources[0]!.emit({
      type: "task",
      taskId: "t1",
      state: "done",
      stateDetail: null,
      seq: 2,
      title: "After",
      updatedAt: "after",
    });

    expect(h.client.getQueryData<Array<{ title: string }>>(qk.tasksList(false))?.[0]?.title).toBe("After");
    expect(h.client.getQueryData<TaskDetail>(qk.task("t1"))?.title).toBe("After");
    expect(invalidated(h.client, qk.tasksList(false))).toBe(false);
    expect(invalidated(h.client, qk.status)).toBe(false);
    expect(invalidated(h.client, qk.task("t1"))).toBe(false);
    expect(invalidated(h.client, qk.diff("t1"))).toBe(false);
    h.close();
  });

  it("a turn event refreshes the selected task's detail + diff, never the list", () => {
    const h = bridge("t1");
    seed(h.client);
    h.sources[0]!.emit({ type: "turn", taskId: "t1", n: 2, status: "done" });

    expect(invalidated(h.client, qk.task("t1"))).toBe(true);
    expect(invalidated(h.client, qk.diff("t1"))).toBe(true);
    expect(invalidated(h.client, qk.tasksList(false))).toBe(false);
    expect(invalidated(h.client, qk.status)).toBe(true); // badges follow every event
    h.close();
  });

  it("a message event refreshes only the selected transcript detail", () => {
    const h = bridge("t1");
    seed(h.client);
    h.client.setQueryData(qk.skills("t1"), []);
    h.sources[0]!.emit({ type: "message", taskId: "t1", messageId: "message-1" });

    expect(invalidated(h.client, qk.task("t1"))).toBe(true);
    expect(invalidated(h.client, qk.status)).toBe(false);
    expect(invalidated(h.client, qk.diff("t1"))).toBe(false);
    expect(invalidated(h.client, qk.skills("t1"))).toBe(false);
    expect(invalidated(h.client, qk.tasksList(false))).toBe(false);
    h.close();
  });

  it("a turn event for another task touches only status", () => {
    const h = bridge("t1");
    seed(h.client);
    h.sources[0]!.emit({ type: "turn", taskId: "t9", n: 1, status: "running" });

    expect(invalidated(h.client, qk.status)).toBe(true);
    expect(invalidated(h.client, qk.task("t1"))).toBe(false);
    expect(invalidated(h.client, qk.diff("t1"))).toBe(false);
    expect(invalidated(h.client, qk.tasksList(false))).toBe(false);
    h.close();
  });

  it("with nothing selected, detail invalidations are skipped but lists still refresh", () => {
    const h = bridge(null);
    seed(h.client);
    h.sources[0]!.emit({ type: "task", taskId: "t1", state: "running", stateDetail: null, seq: 3 });

    expect(invalidated(h.client, qk.tasksList(false))).toBe(true);
    expect(invalidated(h.client, qk.status)).toBe(true);
    expect(invalidated(h.client, qk.task("t1"))).toBe(false);
    h.close();
  });

  it("a project event invalidates only the repos list (no taskId on the frame)", () => {
    const h = bridge("t1");
    seed(h.client);
    h.client.setQueryData(qk.repos, []);
    h.sources[0]!.emit({ type: "project", action: "add", path: "/tmp/repo" });

    expect(invalidated(h.client, qk.repos)).toBe(true);
    expect(invalidated(h.client, qk.tasksList(false))).toBe(false);
    expect(invalidated(h.client, qk.status)).toBe(false);
    expect(invalidated(h.client, qk.task("t1"))).toBe(false);
    h.close();
  });

  it("unparseable frames are ignored without tearing down the stream", () => {
    const h = bridge("t1");
    seed(h.client);
    h.sources[0]!.emitRaw("not json at all");
    expect(invalidated(h.client, qk.tasksList(false))).toBe(false);
    expect(h.sources[0]!.closed).toBe(false);
    h.close();
  });

  it("a transient drop reports the outage, and the reopen resyncs the world", () => {
    const h = bridge("t1");
    seed(h.client);
    const src = h.sources[0]!;
    src.openUp(); // initial open, not a reconnect
    expect(h.connectionLog).toEqual([]); // fresh open reports nothing
    expect(invalidated(h.client, qk.tasksList(false))).toBe(false);

    src.transientError();
    expect(h.connectionLog).toEqual([false]);

    src.openUp(); // the browser's own auto-reconnect succeeded
    expect(h.connectionLog).toEqual([false, true]);
    expect(invalidated(h.client, qk.tasksList(false))).toBe(true);
    expect(invalidated(h.client, qk.status)).toBe(true);
    expect(invalidated(h.client, qk.task("t1"))).toBe(true);
    expect(invalidated(h.client, qk.diff("t1"))).toBe(true);
    expect(h.reconnectCount()).toBe(1); // the app reopens the log stream too
    expect(h.ensureSession).not.toHaveBeenCalled(); // transient drops retry on their own
    h.close();
  });

  it("a hard failure re-mints the session, then rebuilds the stream once", async () => {
    const h = bridge("t1");
    const first = h.sources[0]!;
    first.hardError();
    expect(h.connectionLog).toEqual([false]);

    await vi.waitFor(() => {
      expect(h.sources.length).toBe(2);
    });
    expect(h.ensureSession).toHaveBeenCalledTimes(1);
    expect(first.closed).toBe(true);
    expect(h.sources[1]!.url).toBe("/api/events");
    h.close();
  });

  it("closing the bridge stops the stream and never reconnects after teardown", async () => {
    const h = bridge("t1");
    const first = h.sources[0]!;
    h.close();
    expect(first.closed).toBe(true);
    first.hardError(); // an error landing after teardown must not rebuild
    await new Promise((r) => setTimeout(r, 20));
    expect(h.sources.length).toBe(1);
    expect(h.ensureSession).not.toHaveBeenCalled();
  });
});
