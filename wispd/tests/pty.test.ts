import { describe, expect, test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, fstatSync, open, openSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
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
    send: (data) => writePty(handle, data),
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

let fcntl: ((fd: number, command: number, argument: number) => number) | null = null;

/**
 * FD_CLOEXEC as the kernel reports it. F_GETFD and FD_CLOEXEC are both 1 on
 * Darwin and Linux, and F_GETFD reads no third argument, so calling the
 * variadic fcntl directly is safe here.
 */
function closesOnExec(fd: number): boolean {
  fcntl ??= dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
    fcntl: { args: [FFIType.int, FFIType.int, FFIType.int], returns: FFIType.int },
  }).symbols.fcntl;
  const flags = fcntl(fd, 1, 0);
  if (flags < 0) throw new Error(`pty test: fd ${fd} is not open`);
  return (flags & 1) !== 0;
}

/** The number the next descriptor this process opens will get. */
function lowestFreeFd(): number {
  const fd = openSync("/dev/null", "r");
  closeSync(fd);
  return fd;
}

/**
 * Hold every worker of the runtime's fs pool inside open(2) of a FIFO nobody
 * writes, so an async fs call made now reaches the kernel only after
 * `release()`. Bun runs about one worker per CPU (18 blockers were needed on
 * an 18-core Mac), so twice that leaves none free.
 */
async function parkFsWorkers(): Promise<{ release(): Promise<void> }> {
  const fifo = join(tmpdir(), `wisp-pty-fifo-${process.pid}`);
  rmSync(fifo, { force: true });
  const made = Bun.spawnSync(["mkfifo", fifo], { stderr: "pipe" });
  if (made.exitCode !== 0) throw new Error(`pty test: mkfifo failed: ${made.stderr.toString().trim()}`);
  const parked = Array.from(
    { length: Math.max(32, availableParallelism() * 2) },
    () => new Promise<number>((resolve, reject) => open(fifo, "r", (error, fd) => (error ? reject(error) : resolve(fd)))),
  );
  await Bun.sleep(100);
  let released: Promise<void> | null = null;
  return {
    release: () =>
      (released ??= (async () => {
        const writer = openSync(fifo, "w");
        try {
          for (const fd of await Promise.all(parked)) closeSync(fd);
        } finally {
          closeSync(writer);
          rmSync(fifo, { force: true });
        }
      })()),
  };
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

  test("tearing down the reader never closes a descriptor the handle owns", async () => {
    // A read stream's destroy() closes its fd even with autoClose: false, and
    // does it asynchronously. Reading the handle's own master meant closePty
    // closed that number a second time, landing on whatever had been opened
    // in between (a spawn pipe, a socket, the next shell's master).
    const handle = openPty({ cols: 80, rows: 24 });
    const reader = readPty(handle.masterFd, () => undefined, () => undefined);
    const closed = new Promise<void>((resolve) => reader.once("close", () => resolve()));
    reader.destroy();
    await Promise.race([closed, Bun.sleep(2_000)]);
    expect(reader.closed).toBe(true);
    expect(() => fstatSync(handle.masterFd)).not.toThrow();
    expect(() => resizePty(handle, { cols: 100, rows: 30 })).not.toThrow();
    closePty(handle);
  });

  test("a write that outlives its pty stops instead of reaching a reused descriptor", async () => {
    const handle = openPty({ cols: 80, rows: 24 });
    closePty(handle);
    await expect(writePty(handle, "late keystrokes")).rejects.toThrow(/after the pty was closed/);
  });

  test("a write in flight when the pty closes cannot land on the number's next owner", async () => {
    // fs.write makes its syscall later, on a worker thread, with the number it
    // was handed. Parking the workers holds a write in that gap while the pty
    // closes and its number goes to a file; a write handed `masterFd` itself
    // put its bytes in that file.
    const workers = await parkFsWorkers();
    const path = join(tmpdir(), `wisp-pty-late-write-${process.pid}`);
    let next = -1;
    try {
      const handle = openPty({ cols: 80, rows: 24 });
      const released = handle.masterFd;
      const own = lowestFreeFd(); // where the write's duplicate is about to go
      // EIO is expected, since the pty has no slave by the time the write runs
      const writing = writePty(handle, "late keystrokes").catch(() => undefined);
      expect(closesOnExec(own)).toBe(true);
      closePty(handle);
      next = openSync(path, "w");
      expect(next).toBe(released); // the number really was handed on
      await workers.release();
      await writing;
      expect(readFileSync(path, "utf8")).toBe("");
      expect(() => fstatSync(own)).toThrow(); // and the write closed its duplicate
    } finally {
      await workers.release();
      if (next >= 0) closeSync(next);
      rmSync(path, { force: true });
    }
  });

  test("every descriptor the daemon holds for a pty closes on exec", async () => {
    // A process started later that inherited one would hold the pty open
    // after its session ended.
    const handle = openPty({ cols: 80, rows: 24 });
    const reader = readPty(handle.masterFd, () => undefined, () => undefined);
    const closed = new Promise<void>((resolve) => reader.once("close", () => resolve()));
    try {
      const readerFd = (reader as unknown as { fd: number }).fd;
      for (const fd of [handle.masterFd, handle.slaveFd, readerFd]) expect(closesOnExec(fd)).toBe(true);
    } finally {
      reader.destroy();
      closePty(handle);
      await Promise.race([closed, Bun.sleep(2_000)]);
    }
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
