import { describe, expect, test } from "bun:test";
import {
  clampDimension,
  closePty,
  isPtySlavePath,
  openPty,
  ptyExecArgv,
  readPty,
  resizePty,
  runPtyExec,
  writePty,
  type PtySize,
} from "../src/pty";

/**
 * These run a REAL shell on a REAL pty, because every property worth having
 * here is a kernel property: the size a shell is born at, whether it owns a
 * controlling terminal, and whether SIGWINCH reaches it. A mocked spawn would
 * assert nothing — the previous implementation's unit tests all passed while
 * every shell was being created at 0x0.
 */

interface Harness {
  read(): string;
  send(data: string): Promise<void>;
  resize(size: PtySize): void;
  pid: number;
  stop(): Promise<void>;
}

function start(argv: string[], size: PtySize): Harness {
  const handle = openPty(size);
  const child = Bun.spawn({
    cmd: ptyExecArgv(handle.slavePath, argv),
    cwd: "/tmp",
    env: { ...process.env, TERM: "xterm-256color", COLUMNS: undefined, LINES: undefined } as Record<string, string>,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  let output = "";
  const reader = readPty(
    handle.masterFd,
    (chunk) => (output += chunk.toString("utf8")),
    () => undefined,
  );
  return {
    read: () => output,
    send: (data) => writePty(handle.masterFd, data),
    resize: (next) => resizePty(handle, next),
    pid: child.pid,
    stop: async () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      await child.exited;
      reader.destroy();
      closePty(handle);
    },
  };
}

async function waitFor(harness: Harness, pattern: RegExp, ms = 8000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const match = pattern.exec(harness.read());
    if (match) return match[0];
    await Bun.sleep(25);
  }
  throw new Error(`pty test: never saw ${pattern} in ${JSON.stringify(harness.read().slice(-400))}`);
}

const sh = "/bin/sh";

describe("pty", () => {
  test(
    "the shell is born at the size the pane asked for",
    { timeout: 20_000 },
    async () => {
      // The bug this module exists to fix: a shell that starts at 0x0 makes
      // zsh fall back to 80 columns and draw a first prompt no pane can fit.
      const harness = start([sh, "-c", "stty size; echo SIZE_DONE"], { cols: 58, rows: 9 });
      try {
        await waitFor(harness, /SIZE_DONE/);
        expect(harness.read()).toContain("9 58");
      } finally {
        await harness.stop();
      }
    },
  );

  test(
    "the shell owns a controlling terminal and is its foreground job",
    { timeout: 20_000 },
    async () => {
      // `s` is session leader and `+` is "in the foreground process group of
      // its controlling terminal". Without both, Ctrl-C reaches nothing —
      // which is exactly what posix_spawn(SETSID) alone produces on Darwin.
      const harness = start([sh, "-c", "ps -o stat= -p $$; echo STAT_DONE"], { cols: 80, rows: 24 });
      try {
        await waitFor(harness, /STAT_DONE/);
        const stat = /^\s*([A-Za-z+<>NsLl]+)/m.exec(harness.read())?.[1] ?? "";
        expect(stat).toContain("s");
        expect(stat).toContain("+");
      } finally {
        await harness.stop();
      }
    },
  );

  test(
    "a resize reaches the shell as a new window size",
    { timeout: 20_000 },
    async () => {
      const harness = start([sh], { cols: 58, rows: 9 });
      try {
        await harness.send("stty size\n");
        await waitFor(harness, /9 58/);
        harness.resize({ cols: 132, rows: 40 });
        await harness.send("stty size\n");
        await waitFor(harness, /40 132/);
      } finally {
        await harness.stop();
      }
    },
  );

  test(
    "output written before the shell exits is not lost",
    { timeout: 20_000 },
    async () => {
      // The daemon holds the slave fd open precisely so this cannot race.
      const harness = start([sh, "-c", "echo LAST_WORDS"], { cols: 80, rows: 24 });
      try {
        await waitFor(harness, /LAST_WORDS/);
      } finally {
        await harness.stop();
      }
    },
  );

  test("a closed pty is not closed twice, whatever failed", () => {
    // openPty unwinds every failure through closePty. If a second close ever
    // reached the same number, it would land on whichever descriptor the
    // process opened next — so closing is idempotent, and this proves it by
    // making the reuse happen: the pty opened after the first close is very
    // likely to be handed the numbers just released.
    const first = openPty({ cols: 80, rows: 24 });
    const released = first.masterFd;
    closePty(first);
    expect(first.masterFd).toBe(-1);
    expect(first.slaveFd).toBe(-1);

    const second = openPty({ cols: 80, rows: 24 });
    expect(second.masterFd).toBe(released); // the number really was recycled
    closePty(first); // the stale handle must do nothing at all
    // still usable: a stray close would have taken this pty's descriptor out
    expect(() => resizePty(second, { cols: 100, rows: 30 })).not.toThrow();
    closePty(second);
  });

  test("the child half refuses a path that is not a terminal device", () => {
    expect(isPtySlavePath("/dev/ttys001")).toBe(true);
    expect(isPtySlavePath("/dev/pts/3")).toBe(true);
    for (const path of ["/etc/passwd", "/dev/null", "/dev/../etc/passwd", "/dev/ptsx/1", "ttys001"]) {
      expect(isPtySlavePath(path)).toBe(false);
    }
    expect(() => runPtyExec(["/etc/passwd", "/bin/sh"])).toThrow(/not a pty slave device/);
  });

  test("a pty may not be zero cells", () => {
    expect(clampDimension(0)).toBe(1);
    expect(clampDimension(-5)).toBe(1);
    expect(clampDimension(Number.NaN)).toBe(1);
    expect(clampDimension(58.7)).toBe(58);
    expect(clampDimension(1e9)).toBe(0xffff);
  });

  test("the child half is addressed through this binary, not a copy of bun", () => {
    const argv = ptyExecArgv("/dev/ttys001", ["/bin/zsh", "-l"]);
    expect(argv).toContain("__pty-exec");
    expect(argv[argv.indexOf("__pty-exec") + 1]).toBe("/dev/ttys001");
    expect(argv.slice(-2)).toEqual(["/bin/zsh", "-l"]);
    expect(argv[0]).toBe(process.execPath);
  });
});
