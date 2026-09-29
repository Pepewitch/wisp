/**
 * A real pty for the embedded terminal, owned by the daemon.
 *
 * Bun has no forkpty binding and the daemon ships as ONE cross-compiled
 * `bun build --compile` binary, so a native addon (node-pty) is not an option:
 * it would mean per-platform prebuilds inside a binary we build for linux-x64
 * from macOS. This module gets the same result out of libc through `bun:ffi`,
 * which works unchanged inside the compiled binary.
 *
 *   parent (daemon)                     child (`wisp __pty-exec`)
 *   ───────────────                     ─────────────────────────
 *   posix_openpt + grantpt + unlockpt
 *   ioctl(TIOCSWINSZ)  ← the size the   setsid()
 *     client already measured           open(slave)
 *   spawn the child ─────────────────▶  ioctl(TIOCSCTTY)   ← controlling tty
 *   read/write the master fd            dup2 → 0,1,2
 *   ioctl(TIOCSWINSZ) to resize         execve(shell)      ← Bun is gone here
 *
 * Two things make this the whole trick, and both were measured rather than
 * assumed (see tests/pty.test.ts):
 *
 * 1. TIOCSCTTY must run IN THE CHILD, after setsid and before exec. Darwin
 *    does not hand a session leader a controlling terminal just because it
 *    opened one, so `posix_spawn(POSIX_SPAWN_SETSID)` alone yields a shell
 *    with tcgetpgrp() == 0 where Ctrl-C never interrupts anything. Since no
 *    JavaScript may run between fork and exec, the child is a second copy of
 *    this binary that does the ioctl and then execve()s the shell in place.
 *    execve keeps the pid, so Bun.spawn's `exited` and `kill()` still address
 *    the real shell.
 *
 * 2. The daemon keeps the SLAVE fd open for the session's lifetime. Closing it
 *    before the child has opened the device leaves the master with no writer
 *    and it reports EOF immediately — a shell that looks dead the instant it
 *    starts. Nothing else reads that fd; it exists to hold the pty open.
 *
 * The old implementation ran the shell under `script(1)` with a `cat` pipe for
 * stdin, which is why every shell was born at 0x0 (script copies its stdin's
 * window size, and a pipe has none) and why resizing meant hunting the shell
 * in `ps` output to run `stty -f` against its tty. Both are gone.
 */
import { CString, dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The hidden subcommand this module spawns as its own child half. */
export const PTY_EXEC_COMMAND = "__pty-exec";

/** Terminal size in character cells; the only geometry a pty has. */
export interface PtySize {
  cols: number;
  rows: number;
}

/**
 * What the daemon holds for one live pty. `slaveFd` is never read or written —
 * see the header: it is the writer that keeps the master from reporting EOF.
 */
export interface PtyHandle {
  masterFd: number;
  /** -1 once released; file descriptors are reused, so closing twice is unsafe */
  slaveFd: number;
  slavePath: string;
}

const DARWIN = process.platform === "darwin";

/**
 * ioctl request numbers and open(2) flags are per-platform ABI constants, not
 * portable names: _IOW('t',103,winsize) on Darwin encodes the struct size into
 * the request, while Linux uses a small fixed number.
 */
const TIOCSWINSZ = DARWIN ? 0x80087467n : 0x5414n;
const TIOCGWINSZ = DARWIN ? 0x40087468n : 0x5413n;
const TIOCSCTTY = DARWIN ? 0x20007461n : 0x540en;
const FIOCLEX = DARWIN ? 0x20006601n : 0x5451n;
const FIONBIO = DARWIN ? 0x8004667en : 0x5421n;
const O_RDWR = 2;
const O_NOCTTY = DARWIN ? 0x00020000 : 0o400;
const O_NONBLOCK = DARWIN ? 0x4 : 0o4000;
const F_GETFL = 3;
/** tcflow(3) actions: suspend and restart output, as ^S and ^Q do. */
const TCOOFF = DARWIN ? 1 : 0;
const TCOON = DARWIN ? 2 : 1;

/**
 * Only POSIX-standard symbols, so one declaration covers both platforms.
 * openpty(3) would have been shorter but lives in libutil on Linux before
 * glibc 2.34, and posix_openpt has been in libc everywhere for far longer.
 */
const LIBC_CANDIDATES = DARWIN
  ? ["libSystem.B.dylib"]
  : ["libc.so.6", "libc.musl-x86_64.so.1", "libc.so"];

/**
 * ioctl(2) is variadic, and Apple's arm64 ABI passes variadic arguments on the
 * stack while every fixed argument goes in a register — so an FFI call, which
 * only knows how to do the latter, hands the kernel a garbage pointer and the
 * pty ends up some random size (measured: asking for 9x58 produced 25712x256,
 * with ioctl still returning 0). `__ioctl` is libSystem's non-variadic stub
 * underneath the wrapper and takes the same three arguments correctly.
 *
 * It is a private symbol, so it is a preference rather than a requirement:
 * `probeWinsizeIoctl` checks that a size actually round-trips before this
 * module trusts any of it, and falls back to stty(1) if it does not. On Linux
 * both the AAPCS64 and x86-64 SysV ABIs pass variadic arguments in registers,
 * so plain ioctl is correct there.
 */
const IOCTL_SYMBOLS = DARWIN ? ["__ioctl", "ioctl"] : ["ioctl"];

const SYMBOLS = {
  posix_openpt: { args: [FFIType.int], returns: FFIType.int },
  grantpt: { args: [FFIType.int], returns: FFIType.int },
  unlockpt: { args: [FFIType.int], returns: FFIType.int },
  ptsname: { args: [FFIType.int], returns: FFIType.ptr },
  open: { args: [FFIType.ptr, FFIType.int, FFIType.u32], returns: FFIType.int },
  close: { args: [FFIType.int], returns: FFIType.int },
  dup: { args: [FFIType.int], returns: FFIType.int },
  setsid: { args: [], returns: FFIType.int },
  dup2: { args: [FFIType.int, FFIType.int], returns: FFIType.int },
  execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.int },
  tcgetpgrp: { args: [FFIType.int], returns: FFIType.int },
  tcflow: { args: [FFIType.int, FFIType.int], returns: FFIType.int },
  // Variadic, so only ever called with a command that reads no third
  // argument (F_GETFL); see IOCTL_SYMBOLS for what goes wrong otherwise.
  fcntl: { args: [FFIType.int, FFIType.int, FFIType.int], returns: FFIType.int },
} as const;

type LibcSymbols = ReturnType<typeof dlopen<typeof SYMBOLS>>["symbols"];

let cachedLibc: LibcSymbols | null = null;

function libc(): LibcSymbols {
  if (cachedLibc) return cachedLibc;
  const failures: string[] = [];
  for (const candidate of LIBC_CANDIDATES) {
    try {
      cachedLibc = dlopen(candidate, SYMBOLS).symbols;
      cachedLibrary = candidate;
      return cachedLibc;
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`pty: no usable libc found (${failures.join("; ")})`);
}

let cachedLibrary: string | null = null;
type IoctlFn = (fd: number, request: bigint, arg: number) => number;
let cachedIoctl: IoctlFn | null = null;

/** ioctl(fd, request, pointer), from the first of IOCTL_SYMBOLS that exists. */
function ioctl(): IoctlFn {
  if (cachedIoctl) return cachedIoctl;
  libc(); // resolves cachedLibrary
  const failures: string[] = [];
  for (const name of IOCTL_SYMBOLS) {
    try {
      const lib = dlopen(cachedLibrary!, {
        [name]: { args: [FFIType.int, FFIType.u64, FFIType.ptr], returns: FFIType.int },
      });
      cachedIoctl = lib.symbols[name] as IoctlFn;
      return cachedIoctl;
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`pty: no usable ioctl found (${failures.join("; ")})`);
}

/** errno, so a failure names the reason instead of just returning -1. */
let cachedErrno: (() => number) | null = null;
function errno(): number {
  if (!cachedErrno) {
    try {
      const name = DARWIN ? "__error" : "__errno_location";
      // cachedLibrary, not the first candidate: on musl the loaded libc is a
      // later entry, and opening the wrong one silently reports errno 0
      libc();
      const lib = dlopen(cachedLibrary!, { [name]: { args: [], returns: FFIType.ptr } });
      const location = lib.symbols[name] as () => number | bigint | null;
      cachedErrno = () => {
        const address = location();
        if (address === null) return 0;
        return new Int32Array(toArrayBuffer(address as never, 0, 4))[0] ?? 0;
      };
    } catch {
      cachedErrno = () => 0;
    }
  }
  return cachedErrno();
}

function fail(operation: string): never {
  const code = errno();
  throw new Error(`pty: ${operation} failed${code ? ` (errno ${code})` : ""}`);
}

/**
 * Every descriptor this module opens is the daemon's alone, and none of
 * posix_openpt, open without O_CLOEXEC, or dup sets close-on-exec. A process
 * started later that inherited one would hold that pty open after its
 * session. FIOCLEX takes no argument, so the variadic ioctl problem described
 * at IOCTL_SYMBOLS does not apply to it.
 */
function closeOnExec(fd: number): void {
  if (ioctl()(fd, FIOCLEX, 0) !== 0) fail("ioctl(FIOCLEX)");
}

/**
 * Put the master in non-blocking mode, which is what lets it be read and
 * written without holding a thread (see `readPty`). The flag belongs to the
 * open file, so every duplicate of the master shares it, while the slave, a
 * separate open of the device, stays blocking for the shell.
 *
 * FIONBIO takes a pointer, and on the fallback `ioctl` Darwin's variadic ABI
 * would hand the kernel a garbage one (see IOCTL_SYMBOLS), so the flag is read
 * back rather than trusted.
 */
function nonBlocking(fd: number): void {
  if (ioctl()(fd, FIONBIO, ptr(new Int32Array([1]))) !== 0) fail("ioctl(FIONBIO)");
  const flags = libc().fcntl(fd, F_GETFL, 0);
  if (flags < 0) fail("fcntl(F_GETFL)");
  if ((flags & O_NONBLOCK) === 0) throw new Error("pty: the master did not become non-blocking");
}

/** A NUL-terminated C string; the Buffer must outlive the call that reads it. */
function cstr(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf8");
}

/** struct winsize — ws_row, ws_col, then the two pixel fields nothing sets. */
function winsize(size: PtySize): Uint8Array {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, clampDimension(size.rows), true);
  view.setUint16(2, clampDimension(size.cols), true);
  return bytes;
}

/**
 * A pty cannot be 0 cells (that is exactly the bug this module exists to fix,
 * since a zero-size tty makes zsh fall back to 80 columns and draw a prompt
 * the pane cannot fit) and the winsize fields are 16-bit.
 */
export function clampDimension(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(0xffff, Math.trunc(value)));
}

/** Open a pty already sized to `size`, before anything can print into it. */
export function openPty(size: PtySize): PtyHandle {
  const c = libc();
  const masterFd = c.posix_openpt(O_RDWR | O_NOCTTY);
  if (masterFd < 0) fail("posix_openpt");
  // ONE owner from here down. Every failure path unwinds through this handle
  // and `closePty`, which blanks what it closes, so no descriptor is closed
  // twice — the number would by then be free for the next open in this
  // process to claim, and closing it again would take out an unrelated fd.
  const handle: PtyHandle = { masterFd, slaveFd: -1, slavePath: "" };
  try {
    closeOnExec(masterFd);
    nonBlocking(masterFd);
    if (c.grantpt(masterFd) !== 0) fail("grantpt");
    if (c.unlockpt(masterFd) !== 0) fail("unlockpt");
    const namePtr = c.ptsname(masterFd);
    if (!namePtr) fail("ptsname");
    handle.slavePath = new CString(namePtr).toString();
    if (!handle.slavePath) throw new Error("pty: ptsname returned an empty device name");
    // Held open for the session: see the header note about EOF on the master.
    // It also has to come BEFORE the size is set — Darwin does not attach a
    // tty to the master until a slave exists, and TIOCSWINSZ on a pty nobody
    // has opened fails with ENOTTY.
    handle.slaveFd = c.open(ptr(cstr(handle.slavePath)), O_RDWR | O_NOCTTY, 0);
    if (handle.slaveFd < 0) fail(`open(${handle.slavePath})`);
    closeOnExec(handle.slaveFd);
    resizePty(handle, size);
    return handle;
  } catch (error) {
    closePty(handle);
    throw error;
  }
}

/**
 * Resize the pty. The kernel raises SIGWINCH in the shell for us, which is the
 * whole point: the old implementation had to find the shell in `ps` output and
 * run stty against a tty it inferred, and could pick the wrong process.
 */
export function resizePty(handle: PtyHandle, size: PtySize): void {
  if (ioctlUsable === null) ioctlUsable = probeWinsizeIoctl(handle.masterFd);
  if (ioctlUsable) {
    if (setWinsizeIoctl(handle.masterFd, size) !== 0) fail("ioctl(TIOCSWINSZ)");
    return;
  }
  // The device is ours and named, so this is one deterministic command — not
  // the process-table search the pre-pty implementation needed.
  const flag = DARWIN ? "-f" : "-F";
  const result = Bun.spawnSync({
    cmd: ["stty", flag, handle.slavePath, "rows", String(clampDimension(size.rows)), "cols", String(clampDimension(size.cols))],
    stdout: "ignore",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`pty: stty resize failed: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`);
  }
}

function setWinsizeIoctl(masterFd: number, size: PtySize): number {
  return ioctl()(masterFd, TIOCSWINSZ, ptr(winsize(size)));
}

/** null until measured; see IOCTL_SYMBOLS for why this is measured at all. */
let ioctlUsable: boolean | null = null;

/**
 * Does a window size actually survive the trip through ioctl on this build?
 * Asking the kernel to read it back catches an ABI mismatch that reports
 * success and writes nonsense, which is exactly how the variadic call fails.
 */
function probeWinsizeIoctl(masterFd: number): boolean {
  try {
    const probe: PtySize = { cols: 80, rows: 24 };
    if (setWinsizeIoctl(masterFd, probe) !== 0) return false;
    const out = new Uint8Array(8);
    if (ioctl()(masterFd, TIOCGWINSZ, ptr(out)) !== 0) return false;
    const view = new DataView(out.buffer);
    return view.getUint16(0, true) === probe.rows && view.getUint16(2, true) === probe.cols;
  } catch {
    return false;
  }
}

/**
 * Release the daemon's writer. Do this when the shell exits and NOT before:
 * with no slave open the master reports EOF, so an early close throws away
 * whatever the shell had already written into the pty buffer.
 */
export function closePtySlave(handle: PtyHandle): void {
  if (handle.slaveFd < 0) return;
  libc().close(handle.slaveFd);
  handle.slaveFd = -1;
}

export function closePty(handle: PtyHandle): void {
  closePtySlave(handle);
  if (handle.masterFd < 0) return;
  libc().close(handle.masterFd);
  handle.masterFd = -1;
}

/** A running pump from one pty master; see `readPty`. */
export interface PtyReader {
  /** The reader's own duplicate of the master: its number until `ended` settles, then free. */
  readonly fd: number;
  /** Settles, never rejects, once the pty has reported its end or `close()` has run. */
  readonly ended: Promise<void>;
  /** Stop reading and release the duplicate. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * Stream the master without holding a thread while the shell is quiet.
 *
 * A `node:fs` read stream on this fd, the previous pump, parks one of the
 * runtime's file I/O workers in read(2) until output arrives. Idle shells
 * never produce any, so each one held a worker indefinitely, and once there
 * were as many shells as workers (about one per CPU) every asynchronous
 * `node:fs` call in the daemon queued behind them: turns never finalized, log
 * streams and archive hung, and keystrokes, written through the same pool,
 * could not reach the shell to make it print. `Bun.file(fd).stream()` on a
 * NON-BLOCKING descriptor instead waits in the event loop's poller (kqueue,
 * epoll), which is why `openPty` makes the master non-blocking. On a blocking
 * one it delivers nothing at all (measured), which is why a read stream was
 * used before.
 *
 * The stream reads its OWN duplicate of the master, and this function is that
 * duplicate's only closer, once the stream has finished with it. Bun does not
 * close a descriptor it was handed, and sharing `masterFd` with `closePty`
 * would make the order of two closes of one number matter: whichever came
 * second landed on whatever the process had opened in between, which is how
 * the old stream-based reader took out the next shell's master, a socket, a
 * spawn pipe.
 */
export function readPty(
  masterFd: number,
  onData: (chunk: Uint8Array) => void,
  onError: (error: Error) => void,
): PtyReader {
  const fd = dupMaster(masterFd);
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = Bun.file(fd).stream().getReader();
  } catch (error) {
    libc().close(fd);
    throw error;
  }
  let closing = false;
  const ended = (async () => {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done || closing) return;
        if (next.value.byteLength > 0) onData(next.value);
      }
    } catch (error) {
      // EIO is how Linux reports the last slave closing, i.e. the shell
      // exited (Darwin reports a plain end of file), and EBADF is a read
      // racing the stream's own teardown. Neither is a failure.
      const code = (error as NodeJS.ErrnoException).code;
      if (closing || code === "EIO" || code === "EBADF") return;
      onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      reader.releaseLock();
      libc().close(fd);
    }
  })();
  return {
    fd,
    ended,
    close: async () => {
      if (!closing) {
        closing = true;
        await reader.cancel().catch(() => undefined);
      }
      await ended;
    },
  };
}

/**
 * Suspend the pty's output, exactly as ^S does, until `startPtyOutput`.
 *
 * The daemon reads the master as fast as the shell writes, so a client that
 * cannot keep up would otherwise have the difference queued for it without
 * limit. Suspended, the kernel stops handing output to the master and the
 * shell's own writes block once its buffer fills — the flow control a slow
 * SSH connection applies. Input is unaffected, so Ctrl-C still gets through.
 *
 * Asked of the SLAVE, which the daemon holds open for the session and which
 * is not its controlling terminal, so no job-control check applies. Returns
 * whether the kernel accepted it; a pty whose slave is already released has
 * nothing left to hold.
 */
export function stopPtyOutput(handle: PtyHandle): boolean {
  return handle.slaveFd >= 0 && libc().tcflow(handle.slaveFd, TCOOFF) === 0;
}

/** Undo `stopPtyOutput`. Harmless on a pty whose output was never stopped. */
export function startPtyOutput(handle: PtyHandle): boolean {
  return handle.slaveFd >= 0 && libc().tcflow(handle.slaveFd, TCOON) === 0;
}

/**
 * The process group in the pty's foreground, or null when it cannot be read.
 *
 * Asked of the MASTER: both Darwin and Linux answer tcgetpgrp there for the
 * slave's session, while the slave fd the daemon holds is not its controlling
 * terminal and would be refused. When this equals the shell's pid the shell is
 * at its prompt; anything else is a job the user is running.
 */
export function foregroundProcessGroup(masterFd: number): number | null {
  if (masterFd < 0) return null;
  try {
    const pgrp = libc().tcgetpgrp(masterFd);
    return pgrp > 0 ? pgrp : null;
  } catch {
    return null;
  }
}

type ProcName = (pid: number, buffer: number, size: number) => number;
let cachedProcName: ProcName | null | undefined;

/**
 * A process's short command name (`bun`, `vim`), or null when it is gone.
 *
 * Read from the kernel rather than by running ps(1): this is asked every time
 * a busy shell prints, and spawning a process per burst of output would cost
 * more than the answer is worth. Darwin has libproc's proc_name; Linux has
 * /proc/<pid>/comm.
 */
export function processName(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!DARWIN) {
    try {
      const name = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      return name || null;
    } catch {
      return null;
    }
  }
  if (cachedProcName === undefined) {
    try {
      cachedProcName = dlopen("libSystem.B.dylib", {
        proc_name: { args: [FFIType.int, FFIType.ptr, FFIType.u32], returns: FFIType.int },
      }).symbols.proc_name as unknown as ProcName;
    } catch {
      cachedProcName = null;
    }
  }
  if (!cachedProcName) return null;
  const buffer = new Uint8Array(256);
  const length = cachedProcName(pid, ptr(buffer), buffer.length);
  if (length <= 0) return null;
  return new TextDecoder().decode(buffer.subarray(0, length)) || null;
}

/** A close-on-exec duplicate of the master, for exactly one owner to close. */
function dupMaster(masterFd: number): number {
  const c = libc();
  const fd = c.dup(masterFd);
  if (fd < 0) fail("dup(master)");
  try {
    closeOnExec(fd);
  } catch (error) {
    c.close(fd);
    throw error;
  }
  return fd;
}

/** The longest a write waits before asking a full pty for room again. */
const WRITE_RETRY_MAX_MS = 16;

/**
 * Write to the master. Async so a large paste cannot block the event loop.
 *
 * The master is non-blocking, so each write(2) happens right here, on the
 * event loop, and takes what the pty's input buffer has room for. When it has
 * none (EAGAIN: a paste bigger than the buffer, into a program that is not
 * reading yet) the rest waits on a short timer and is offered again. A
 * worker-thread `fs.write` used to do this blocking, and so held a worker for
 * as long as the program did not read — the same starvation `readPty`
 * describes.
 *
 * The syscall runs synchronously with the handle's check, so it can never
 * reach a number `closePty` has released and something else has claimed. A
 * paste that is waiting for room when the shell exits stops at `closePty`.
 */
export function writePty(handle: PtyHandle, data: string | Uint8Array): Promise<void> {
  const buffer = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return new Promise((resolve, reject) => {
    let offset = 0;
    let wait = 0;
    const step = (): void => {
      while (offset < buffer.length) {
        if (handle.masterFd < 0) {
          reject(new Error("pty: write after the pty was closed"));
          return;
        }
        let written = 0;
        try {
          written = writeSync(handle.masterFd, buffer, offset, buffer.length - offset);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "EINTR") continue;
          if (code !== "EAGAIN" && code !== "EWOULDBLOCK") {
            reject(error);
            return;
          }
        }
        if (written > 0) {
          offset += written;
          wait = 0;
          continue;
        }
        wait = Math.min(WRITE_RETRY_MAX_MS, Math.max(1, wait * 2));
        setTimeout(step, wait);
        return;
      }
      resolve();
    };
    step();
  });
}

/**
 * How to run this binary again.
 *
 * A compiled binary re-execs itself, which the virtual `/$bunfs/` path of this
 * module identifies. Otherwise Bun has to be pointed at the CLI entrypoint,
 * resolved RELATIVE TO THIS FILE rather than from `Bun.main`: under `bun test`
 * the main module is the test file, and spawning that would re-run a test
 * suite instead of the shell.
 */
export function selfCommand(): string[] {
  if (import.meta.url.includes("/$bunfs/")) return [process.execPath];
  return [process.execPath, fileURLToPath(new URL("./index.ts", import.meta.url))];
}

/** The argv that runs the child half against `slavePath`. */
export function ptyExecArgv(slavePath: string, command: string[]): string[] {
  return [...selfCommand(), PTY_EXEC_COMMAND, slavePath, ...command];
}

/**
 * The pty slave devices this may be pointed at. The subcommand opens the path
 * it is given and makes it a controlling terminal, so it is kept to the two
 * device names that can be one. Running `wisp` at all already implies being
 * able to run commands, but nothing here should reach a regular file.
 */
export function isPtySlavePath(path: string): boolean {
  return /^\/dev\/ttys[0-9]+$/.test(path) || /^\/dev\/pts\/[0-9]+$/.test(path);
}

/**
 * The child half, running as its own process: take the pty as a controlling
 * terminal and become the shell. Everything here happens before any of the
 * daemon's own modules load, and execve replaces this process, so no Bun
 * runtime survives into the user's shell.
 */
export function runPtyExec(args: string[]): never {
  const [slavePath, ...command] = args;
  if (!slavePath || command.length === 0) {
    throw new Error(`usage: ${PTY_EXEC_COMMAND} <slave-device> <command> [args...]`);
  }
  if (!isPtySlavePath(slavePath)) {
    throw new Error(`${PTY_EXEC_COMMAND}: ${JSON.stringify(slavePath)} is not a pty slave device`);
  }
  const c = libc();
  if (c.setsid() < 0) fail("setsid");
  const fd = c.open(ptr(cstr(slavePath)), O_RDWR, 0);
  if (fd < 0) fail(`open(${slavePath})`);
  if (ioctl()(fd, TIOCSCTTY, 0) !== 0) fail("ioctl(TIOCSCTTY)");
  c.dup2(fd, 0);
  c.dup2(fd, 1);
  c.dup2(fd, 2);
  if (fd > 2) c.close(fd);

  // argv and envp must stay reachable until execve returns (it does not)
  const argvBuffers = command.map(cstr);
  const argv = new BigUint64Array(argvBuffers.length + 1);
  argvBuffers.forEach((buffer, index) => (argv[index] = BigInt(ptr(buffer))));
  const envBuffers = Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => cstr(`${key}=${value}`));
  const envp = new BigUint64Array(envBuffers.length + 1);
  envBuffers.forEach((buffer, index) => (envp[index] = BigInt(ptr(buffer))));
  c.execve(ptr(cstr(command[0]!)), ptr(argv), ptr(envp));
  fail(`execve(${command[0]})`);
}
