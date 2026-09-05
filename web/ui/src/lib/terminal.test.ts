import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SHELL_TABS,
  loadShellTabs,
  saveShellTabs,
  SHELL_TABS_KEY,
  SHELL_TABS_MAX_TASKS,
  TerminalConnection,
  terminalSocketUrl,
  type TerminalClientHandlers,
  type TerminalSocketLike,
} from "./terminal";

/**
 * The WS wrapper's contract (S3.5): JSON framing of the two client→server
 * messages, exact dispatch of the four server→client frames, the generation
 * guard (a stale socket never delivers into a new session), and a clean
 * dispose. No real socket, no DOM — a scripted mock drives the events.
 */

/** A scripted mock socket: records sends, lets the test fire events by hand. */
class MockSocket implements TerminalSocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockSocket.CONNECTING;
  readonly sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = MockSocket.CLOSED;
  }

  // --- test drivers ---
  open(): void {
    this.readyState = MockSocket.OPEN;
    this.onopen?.();
  }
  message(body: unknown): void {
    this.onmessage?.({ data: typeof body === "string" ? body : JSON.stringify(body) });
  }
  closeFromServer(code = 1000): void {
    this.readyState = MockSocket.CLOSED;
    this.onclose?.({ code });
  }
}

function handlers(): TerminalClientHandlers & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = { hello: [], out: [], exit: [], error: [], close: [] };
  return {
    calls,
    onHello: vi.fn((h) => calls.hello.push([h])),
    onOutput: vi.fn((d) => calls.out.push([d])),
    onExit: vi.fn((c) => calls.exit.push([c])),
    onError: vi.fn((m) => calls.error.push([m])),
    onClose: vi.fn((code, beforeHello) => calls.close.push([code, beforeHello])),
  };
}

/** Build a connection + the mock socket its factory will hand out. */
function setup(current: () => boolean = () => true) {
  const h = handlers();
  let socket: MockSocket | null = null;
  const conn = new TerminalConnection(
    "t1",
    0,
    h,
    (url: string) => {
      socket = new MockSocket(url);
      return socket;
    },
    current,
  );
  return { conn, h, socket: () => socket! };
}

describe("terminalSocketUrl", () => {
  it("targets the daemon's WS route for the task, same-origin", () => {
    // jsdom's location is http://localhost:3000
    const { host } = window.location;
    expect(terminalSocketUrl("tabc", 0)).toBe(`ws://${host}/api/tasks/tabc/terminal?shell=0`);
  });

  it("addresses the tab, so the same id reattaches to the same daemon shell", () => {
    const { host } = window.location;
    expect(terminalSocketUrl("tabc", 3)).toBe(`ws://${host}/api/tasks/tabc/terminal?shell=3`);
  });
});

describe("hello replay", () => {
  it("passes the daemon's scrollback through so a reattached tab can redraw", () => {
    const { conn, h, socket } = setup();
    conn.connect();
    socket().open();
    socket().message({ type: "hello", pty: true, cwd: "/wt/t1", replay: "$ pwd\r\n/wt/t1\r\n" });
    expect(h.calls.hello).toEqual([[{ pty: true, cwd: "/wt/t1", replay: "$ pwd\r\n/wt/t1\r\n" }]]);
  });

  it("treats a hello with no replay as an empty one — a first attach has nothing to redraw", () => {
    const { conn, h, socket } = setup();
    conn.connect();
    socket().open();
    socket().message({ type: "hello", pty: true, cwd: "/wt/t1" });
    expect(h.calls.hello).toEqual([[{ pty: true, cwd: "/wt/t1", replay: "" }]]);
  });
});

describe("shell tab persistence", () => {
  /** An in-memory Storage — jsdom's localStorage leaks across the whole file. */
  function memoryStorage(seed?: string): Storage {
    const map = new Map<string, string>();
    if (seed !== undefined) map.set(SHELL_TABS_KEY, seed);
    return {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (k: string) => map.get(k) ?? null,
      key: (i: number) => [...map.keys()][i] ?? null,
      removeItem: (k: string) => void map.delete(k),
      setItem: (k: string, v: string) => void map.set(k, v),
    } as Storage;
  }

  it("defaults to one tab for a task it has never seen", () => {
    expect(loadShellTabs("t1", memoryStorage())).toEqual(DEFAULT_SHELL_TABS);
  });

  it("round-trips a task's tabs and active tab", () => {
    const storage = memoryStorage();
    saveShellTabs("t1", { ids: [0, 2, 3], active: 2 }, storage);
    expect(loadShellTabs("t1", storage)).toEqual({ ids: [0, 2, 3], active: 2 });
    expect(loadShellTabs("t2", storage)).toEqual(DEFAULT_SHELL_TABS);
  });

  it("treats absent, unparseable and wrong-shaped records as the default", () => {
    expect(loadShellTabs("t1", memoryStorage("not json"))).toEqual(DEFAULT_SHELL_TABS);
    expect(loadShellTabs("t1", memoryStorage("[1,2,3]"))).toEqual(DEFAULT_SHELL_TABS);
    expect(loadShellTabs("t1", memoryStorage(JSON.stringify({ t1: { ids: [] } })))).toEqual(DEFAULT_SHELL_TABS);
    expect(loadShellTabs("t1", memoryStorage(JSON.stringify({ t1: { ids: ["a", -1, 1.5] } })))).toEqual(
      DEFAULT_SHELL_TABS,
    );
  });

  it("repairs an active tab that is not in the list, rather than dropping the record", () => {
    const storage = memoryStorage(JSON.stringify({ t1: { ids: [1, 2], active: 9 } }));
    expect(loadShellTabs("t1", storage)).toEqual({ ids: [1, 2], active: 1 });
  });

  it("never throws when storage is unavailable", () => {
    const dead = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(loadShellTabs("t1", dead)).toEqual(DEFAULT_SHELL_TABS);
    expect(() => saveShellTabs("t1", { ids: [0], active: 0 }, dead)).not.toThrow();
  });

  it("caps remembered tasks, dropping the least recently written", () => {
    const storage = memoryStorage();
    for (let i = 0; i < SHELL_TABS_MAX_TASKS + 5; i++) {
      saveShellTabs(`task${i}`, { ids: [0, 1], active: 1 }, storage);
    }
    const stored = JSON.parse(storage.getItem(SHELL_TABS_KEY)!) as Record<string, unknown>;
    expect(Object.keys(stored)).toHaveLength(SHELL_TABS_MAX_TASKS);
    expect(stored.task0).toBeUndefined();
    expect(stored[`task${SHELL_TABS_MAX_TASKS + 4}`]).toBeDefined();
  });

  it("re-saving a task keeps it from being evicted by newer ones", () => {
    const storage = memoryStorage();
    saveShellTabs("keeper", { ids: [0], active: 0 }, storage);
    for (let i = 0; i < SHELL_TABS_MAX_TASKS - 1; i++) {
      saveShellTabs(`filler${i}`, { ids: [0], active: 0 }, storage);
    }
    saveShellTabs("keeper", { ids: [0, 1], active: 1 }, storage); // touch it
    saveShellTabs("newcomer", { ids: [0], active: 0 }, storage); // evicts filler0
    expect(loadShellTabs("keeper", storage)).toEqual({ ids: [0, 1], active: 1 });
    expect(loadShellTabs("filler0", storage)).toEqual(DEFAULT_SHELL_TABS);
  });
});

describe("TerminalConnection framing", () => {
  it("sends {type:'in'} for input and {type:'resize'} for a fit, once open", () => {
    const { conn, socket } = setup();
    conn.connect();
    socket().open();

    conn.sendInput("ls -la\r");
    conn.sendInput("\u007f");
    conn.sendResize(120, 40);

    expect(JSON.parse(socket().sent[0]!)).toEqual({ type: "in", data: "ls -la\r" });
    expect(JSON.parse(socket().sent[1]!)).toEqual({ type: "in", data: "\u007f" });
    expect(JSON.parse(socket().sent[2]!)).toEqual({ type: "resize", cols: 120, rows: 40 });
  });

  it("never sends before the socket is open", () => {
    const { conn, socket } = setup();
    conn.connect(); // still CONNECTING
    conn.sendInput("x");
    conn.sendResize(80, 24);
    expect(socket().sent).toHaveLength(0);
  });

  it("dispatches the four server frames to their handlers", () => {
    const { conn, h, socket } = setup();
    conn.connect();
    socket().open();

    socket().message({ type: "hello", pty: true, cwd: "/wt/t1" });
    socket().message({ type: "out", data: "total 0\n" });
    socket().message({ type: "error", message: "boom" });
    socket().message({ type: "exit", code: 3 });

    expect(h.calls.hello).toEqual([[{ pty: true, cwd: "/wt/t1", replay: "" }]]);
    expect(h.calls.out).toEqual([["total 0\n"]]);
    expect(h.calls.error).toEqual([["boom"]]);
    expect(h.calls.exit).toEqual([[3]]);
  });

  it("flags a malformed frame as a protocol error, not a crash", () => {
    const { conn, h, socket } = setup();
    conn.connect();
    socket().open();
    socket().message("{not json");
    expect(h.calls.error[0]![0]).toMatch(/invalid JSON/);
  });

  it("reports close-before-hello distinctly from a live drop", () => {
    const { conn, h, socket } = setup();
    conn.connect();
    socket().open();
    socket().closeFromServer(1006);
    expect(h.calls.close).toEqual([[1006, true]]);

    // a second connection that saw hello reports beforeHello=false
    const second = setup();
    second.conn.connect();
    second.socket().open();
    second.socket().message({ type: "hello", pty: true, cwd: "/wt" });
    second.socket().closeFromServer(1000);
    expect(second.h.calls.close).toEqual([[1000, false]]);
  });
});

describe("TerminalConnection generation guard", () => {
  it("a stale socket never delivers frames into the session", () => {
    let current = true;
    const { conn, h, socket } = setup(() => current);
    conn.connect();
    socket().open();
    socket().message({ type: "hello", pty: true, cwd: "/wt" });
    expect(h.calls.hello).toHaveLength(1);

    current = false; // the component moved on; this socket is now stale
    socket().message({ type: "out", data: "late bytes" });
    socket().message({ type: "exit", code: 0 });
    socket().closeFromServer(1000);
    expect(h.calls.out).toHaveLength(0);
    expect(h.calls.exit).toHaveLength(0);
    expect(h.calls.close).toHaveLength(0);
  });

  it("a stale connection refuses to send", () => {
    let current = true;
    const { conn, socket } = setup(() => current);
    conn.connect();
    socket().open();
    current = false;
    conn.sendInput("x");
    conn.sendResize(1, 1);
    expect(socket().sent).toHaveLength(0);
  });
});

describe("TerminalConnection dispose", () => {
  it("closes the socket and drops every late event", () => {
    const { conn, h, socket } = setup();
    conn.connect();
    socket().open();
    conn.dispose();

    expect(socket().closed).toBe(true);
    socket().message({ type: "out", data: "late" });
    socket().closeFromServer(1000);
    expect(h.calls.out).toHaveLength(0);
    expect(h.calls.close).toHaveLength(0);
  });

  it("dispose is idempotent and nulls handlers before close", () => {
    const { conn, socket } = setup();
    conn.connect();
    socket().open();
    conn.dispose();
    conn.dispose();
    expect(socket().closed).toBe(true);
    expect(socket().onmessage).toBeNull();
    expect(socket().onclose).toBeNull();
  });
});
