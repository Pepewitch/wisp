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
import { createReadStream, write as fsWrite, type ReadStream } from "node:fs";
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
const O_RDWR = 2;
const O_NOCTTY = DARWIN ? 0x00020000 : 0o400;

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
  setsid: { args: [], returns: FFIType.int },
  dup2: { args: [FFIType.int, FFIType.int], returns: FFIType.int },
  execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.int },
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
      const lib = dlopen(LIBC_CANDIDATES[0]!, { [name]: { args: [], returns: FFIType.ptr } });
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
  try {
    if (c.grantpt(masterFd) !== 0) fail("grantpt");
    if (c.unlockpt(masterFd) !== 0) fail("unlockpt");
    const namePtr = c.ptsname(masterFd);
    if (!namePtr) fail("ptsname");
    const slavePath = new CString(namePtr).toString();
    if (!slavePath) throw new Error("pty: ptsname returned an empty device name");
    // Held open for the session: see the header note about EOF on the master.
    // It also has to come BEFORE the size is set — Darwin does not attach a
    // tty to the master until a slave exists, and TIOCSWINSZ on a pty nobody
    // has opened fails with ENOTTY.
    const slaveFd = c.open(ptr(cstr(slavePath)), O_RDWR | O_NOCTTY, 0);
    if (slaveFd < 0) fail(`open(${slavePath})`);
    const handle: PtyHandle = { masterFd, slaveFd, slavePath };
    try {
      resizePty(handle, size);
    } catch (error) {
      closePty(handle);
      throw error;
    }
    return handle;
  } catch (error) {
    c.close(masterFd);
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

/**
 * Stream the master fd. `node:fs` read streams are the only pump that works
 * here: `Bun.file(fd).stream()` yields nothing at all on a character device,
 * measured repeatedly, and a synchronous read would block the daemon.
 */
export function readPty(
  masterFd: number,
  onData: (chunk: Buffer) => void,
  onError: (error: Error) => void,
): ReadStream {
  const stream = createReadStream("", { fd: masterFd, autoClose: false });
  stream.on("data", (chunk) => onData(chunk as Buffer));
  stream.on("error", (error) => {
    // Both of these mean "this pty is finished", not "something went wrong":
    // EIO is how the kernel reports the last slave closing, i.e. the shell
    // exited, and EBADF is the stream's own teardown racing the fd close.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EIO" || code === "EBADF") return;
    onError(error);
  });
  return stream;
}

/** Write to the master. Async so a large paste cannot block the event loop. */
export function writePty(masterFd: number, data: string | Uint8Array): Promise<void> {
  const buffer = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return new Promise((resolve, reject) => {
    const step = (offset: number): void => {
      if (offset >= buffer.length) {
        resolve();
        return;
      }
      fsWrite(masterFd, buffer, offset, buffer.length - offset, null, (error, written) => {
        if (error) {
          reject(error);
          return;
        }
        step(offset + written);
      });
    };
    step(0);
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
