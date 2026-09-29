import { describe, expect, test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, existsSync, fstatSync, open, openSync, promises as fsp, readFileSync, rmSync, writeSync } from "node:fs";
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
  startPtyOutput,
  stopPtyOutput,
  writePty,
  type PtyHandle,
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
  handle: PtyHandle;
  pid: number;
  stop(): Promise<void>;
}

function start(argv: string[], size: PtySize): Harness {
  const handle = openPty(size);
  const child = Bun.spawn({
    cmd: ptyExecArgv(handle.slavePath, argv),
    cwd: "/tmp",
    env: { ...process.env, TERM: "xterm-256color", COLUMNS: undefined, LINES: undefined },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  let output = "";
  const decoder = new TextDecoder();
  const reader = readPty(
    handle.masterFd,
    (chunk) => (output += decoder.decode(chunk, { stream: true })),
    () => undefined,
  );
  return {
    read: () => output,
    send: (data) => writePty(handle, data),
    resize: (next) => resizePty(handle, next),
    handle,
    pid: child.pid,
    stop: async () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      await child.exited;
      await reader.close();
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

/** Put the pty in raw mode with no echo, so nothing consumes or answers what is written to it. */
function rawNoEcho(handle: PtyHandle): void {
  const flag = process.platform === "darwin" ? "-f" : "-F";
  const result = Bun.spawnSync(["stty", flag, handle.slavePath, "raw", "-echo"], { stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`pty test: stty raw failed: ${result.stderr.toString().trim()}`);
}

/** `promise`'s value, or "timeout" once `ms` have passed. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([promise, Bun.sleep(ms).then(() => "timeout" as const)]);
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
    // The reader has its own duplicate and releases exactly that. Reading the
    // handle's own master meant closePty closed that number a second time,
    // landing on whatever had been opened in between (a spawn pipe, a
    // socket, the next shell's master).
    const handle = openPty({ cols: 80, rows: 24 });
    const reader = readPty(handle.masterFd, () => undefined, () => undefined);
    expect(reader.fd).not.toBe(handle.masterFd);
    expect(await within(reader.close(), 2_000)).not.toBe("timeout");
    expect(() => fstatSync(reader.fd)).toThrow(); // its own duplicate is released
    expect(() => fstatSync(handle.masterFd)).not.toThrow();
    expect(() => resizePty(handle, { cols: 100, rows: 30 })).not.toThrow();
    closePty(handle);
  });

  test(
    "idle ptys hold no file I/O worker, and every one still carries data both ways",
    { timeout: 20_000 },
    async () => {
      // A reader parked in read(2) on a worker thread held that worker for as
      // long as its shell was quiet. With about one worker per CPU, that many
      // idle terminals stopped every async fs call in the daemon (a turn's
      // finalization, log streams, archive) and every keystroke with them.
      // No shell is needed to be idle: the daemon's own slave descriptor
      // keeps each pty open, exactly as it does for a shell at its prompt.
      const count = Math.max(16, availableParallelism() * 2);
      const ptys: { handle: PtyHandle; output(): string; close(): Promise<void> }[] = [];
      try {
        for (let index = 0; index < count; index++) {
          const handle = openPty({ cols: 80, rows: 24 });
          let output = "";
          const reader = readPty(handle.masterFd, (chunk) => (output += Buffer.from(chunk).toString("utf8")), () => undefined);
          ptys.push({ handle, output: () => output, close: () => reader.close() });
        }
        await Bun.sleep(200); // every reader is waiting by now

        expect(await within(fsp.stat(tmpdir()), 3_000)).not.toBe("timeout");
        expect(await within(fsp.readFile(import.meta.path, "utf8"), 3_000)).not.toBe("timeout");

        // Keystrokes reach every pty, and its line discipline's echo comes
        // back through the reader; what a program prints on the slave does too.
        const typed = Promise.all(ptys.map(({ handle }, index) => writePty(handle, `typed-${index}\n`)));
        expect(await within(typed, 3_000)).not.toBe("timeout");
        ptys.forEach(({ handle }, index) => writeSync(handle.slaveFd, `printed-${index}\n`));
        const missing = (): number =>
          ptys.filter(({ output }, index) => !output().includes(`typed-${index}`) || !output().includes(`printed-${index}`))
            .length;
        const deadline = Date.now() + 5_000;
        while (missing() > 0 && Date.now() < deadline) await Bun.sleep(25);
        expect(missing()).toBe(0);
      } finally {
        for (const pty of ptys) closePty(pty.handle);
        await within(Promise.all(ptys.map((pty) => pty.close())), 3_000);
      }
    },
  );

  test("a pty needs no file I/O worker, even when every one is busy", { timeout: 20_000 }, async () => {
    // The other half of the same failure: while the pool is taken, by idle
    // shells or by anything else, typing and output must still flow.
    const workers = await parkFsWorkers();
    const harness = start([sh], { cols: 80, rows: 24 });
    try {
      expect(await within(harness.send("echo parked-$((6*7))\n"), 3_000)).not.toBe("timeout");
      await waitFor(harness, /parked-42/);
    } finally {
      await workers.release();
      await harness.stop();
    }
  });

  test("a paste larger than the pty's buffer waits for room instead of failing", { timeout: 20_000 }, async () => {
    // The master is non-blocking, so a paste bigger than the pty can hold
    // meets EAGAIN part way through. The rest has to be offered again once
    // the program reads, not dropped and not turned into an error.
    const harness = start([sh, "-c", "stty raw -echo; echo PASTE_READY; head -c 262144 > /dev/null; echo PASTE_DONE"], {
      cols: 80,
      rows: 24,
    });
    try {
      await waitFor(harness, /PASTE_READY/); // raw, so no line limit applies to the paste
      await harness.send("x".repeat(262_144));
      await waitFor(harness, /PASTE_DONE/);
    } finally {
      await harness.stop();
    }
  });

  test("a write that outlives its pty stops instead of reaching a reused descriptor", async () => {
    const handle = openPty({ cols: 80, rows: 24 });
    closePty(handle);
    await expect(writePty(handle, "late keystrokes")).rejects.toThrow(/after the pty was closed/);
  });

  test("a write waiting for room when the pty closes cannot land on the number's next owner", async () => {
    // A write the pty has no room for waits and is offered again later. By
    // then the pty may be closed and its number handed to a file; the retry
    // must stop at the closed handle rather than write into that file.
    const path = join(tmpdir(), `wisp-pty-late-write-${process.pid}`);
    let next = -1;
    try {
      const handle = openPty({ cols: 80, rows: 24 });
      rawNoEcho(handle); // nothing reads, so the pty fills and stays full
      const released = handle.masterFd;
      const writing = writePty(handle, Buffer.alloc(4 * 1024 * 1024, 0x61));
      expect(await within(writing, 100)).toBe("timeout"); // it is waiting for room
      closePty(handle);
      next = openSync(path, "w");
      expect(next).toBe(released); // the number really was handed on
      await expect(writing).rejects.toThrow(/after the pty was closed/);
      expect(readFileSync(path, "utf8")).toBe("");
    } finally {
      if (next >= 0) closeSync(next);
      rmSync(path, { force: true });
    }
  });

  test("stopping a pty's output holds the shell until it is started again", { timeout: 20_000 }, async () => {
    // How a client that cannot keep up is kept from having the shell's
    // output queued for it without limit: the shell itself waits.
    // Started by a file, not a keystroke: Darwin's default IXANY lets any
    // typed character restart stopped output (the daemon stops it again on
    // the next congested send), and this asserts the stop itself.
    const go = join(tmpdir(), `wisp-pty-flow-go-${process.pid}`);
    const done = join(tmpdir(), `wisp-pty-flow-done-${process.pid}`);
    for (const path of [go, done]) rmSync(path, { force: true });
    const flood = [
      "echo FLOW_READY",
      `while [ ! -e ${go} ]; do sleep 0.05; done`,
      "head -c 2000000 /dev/zero | tr '\\0' Z",
      `: > ${done}`,
      "echo FLOW_DONE",
    ].join("; ");
    const harness = start([sh, "-c", flood], { cols: 80, rows: 24 });
    try {
      await waitFor(harness, /FLOW_READY/);
      expect(stopPtyOutput(harness.handle)).toBe(true);
      closeSync(openSync(go, "w"));
      await Bun.sleep(1_000);
      expect(existsSync(done)).toBe(false); // the flood is still waiting to be read
      expect(harness.read().length).toBeLessThan(1_000_000);
      expect(startPtyOutput(harness.handle)).toBe(true);
      await waitFor(harness, /FLOW_DONE/);
      expect(harness.read()).toContain("Z".repeat(2_000_000));
    } finally {
      await harness.stop();
      for (const path of [go, done]) rmSync(path, { force: true });
    }
  });

  test("every descriptor the daemon holds for a pty closes on exec", async () => {
    // A process started later that inherited one would hold the pty open
    // after its session ended.
    const handle = openPty({ cols: 80, rows: 24 });
    const reader = readPty(handle.masterFd, () => undefined, () => undefined);
    try {
      for (const fd of [handle.masterFd, handle.slaveFd, reader.fd]) expect(closesOnExec(fd)).toBe(true);
    } finally {
      await within(reader.close(), 2_000);
      closePty(handle);
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
