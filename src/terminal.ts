import { existsSync } from "node:fs";
import type { ReadStream } from "node:fs";
import {
  clampDimension,
  closePty,
  closePtySlave,
  openPty,
  ptyExecArgv,
  readPty,
  resizePty,
  writePty,
  type PtyHandle,
  type PtySize,
} from "./pty";
import { taskEnv } from "./runner";
import { getTask } from "./store";
import { TerminalScreen } from "./terminal-screen";

/** Live shells across every task. Each is a real login shell, so this is a resource cap. */
const MAX_SHELLS = 32;
/** Shells one task may hold — the terminal pane's tab count, bounded. */
export const MAX_SHELLS_PER_TASK = 8;
const IDLE_MS = 30 * 60 * 1000;
const IDLE_GC_INTERVAL_MS = 60 * 1000;
const KILL_GRACE_MS = 5_000;
/** The browser renderer is xterm.js, regardless of the daemon's own terminal. */
export const WEB_TERMINAL_TERM = "xterm-256color";

/**
 * The size a shell is born at when a client attaches without saying how big it
 * is. Every current client measures its pane before connecting; this only
 * covers an older client, and 80x24 is the historical terminal default rather
 * than any pane's real geometry.
 */
export const DEFAULT_PTY_SIZE: PtySize = { cols: 80, rows: 24 };

/** Build the environment for a shell rendered by the embedded xterm.js UI. */
export function webTerminalEnv(
  inherited: Record<string, string | undefined>,
  task: Record<string, string>,
): Record<string, string | undefined> {
  return {
    ...inherited,
    ...task,
    // A daemon launched by Finder/systemd often has no TERM, while CI and
    // agent shells commonly set TERM=dumb. Both make `clear` a no-op and can
    // give zsh the wrong key capabilities (notably Backspace). The child is
    // always attached to xterm.js, so describe that terminal explicitly.
    TERM: WEB_TERMINAL_TERM,
    COLORTERM: "truecolor",
    // The tty carries the real size now, and an inherited COLUMNS/LINES from
    // whatever terminal launched the daemon would override it in the shell's
    // startup files while being wrong for every pane.
    COLUMNS: undefined,
    LINES: undefined,
  };
}

/**
 * What a client is told when another one takes its shell. The wording names
 * the remedy, because reconnecting is exactly how the taking is undone — the
 * pane's `retry` reattaches and the shell comes back with its scrollback.
 */
export const DISPLACED_MESSAGE =
  "another window attached to this shell — retry to take it back";

/** The sessions map key: one shell per (task, tab), so tabs are real shells. */
export function sessionKey(taskId: string, shellId: number): string {
  return `${taskId}:${shellId}`;
}

export interface TerminalClient {
  isOpen(): boolean;
  sendOutput(data: string): void;
  sendError(message: string): void;
  sendExit(code: number): void;
}

type ShellProcess = Bun.Subprocess<"ignore" | "pipe", "ignore" | "pipe", "pipe">;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The user's login shell: $SHELL when the daemon's environment sets it and the
 * binary exists, else the platform default (zsh on macOS since Catalina,
 * bash on Linux). The web terminal must feel like the machine's own terminal
 * — a hardcoded bash would ignore the user's shell config entirely.
 */
export function loginShell(): string {
  const fromEnv = process.env.SHELL;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

/** The login shell invocation, on the pty and in the piped fallback alike. */
export function loginShellArgv(shell: string = loginShell()): string[] {
  return [shell, "-l"];
}

/**
 * One shell process and one currently attached browser client. A replacement
 * attachment changes this pointer; output is consequently never broadcast.
 */
class TerminalSession {
  readonly pty: boolean;
  readonly cwd: string;
  readonly key: string;
  private readonly taskId: string;
  private readonly child: ShellProcess;
  private readonly handle: PtyHandle | null;
  private readonly reader: ReadStream | null;
  /** the daemon's model of the screen — what a reattaching client is sent */
  private readonly screen: TerminalScreen;
  private client: TerminalClient | null = null;
  private detachedAt = Date.now();
  private finished = false;
  private inputQueue: Promise<void> = Promise.resolve();

  private constructor(
    key: string,
    taskId: string,
    cwd: string,
    child: ShellProcess,
    handle: PtyHandle | null,
    size: PtySize,
  ) {
    this.key = key;
    this.taskId = taskId;
    this.cwd = cwd;
    this.child = child;
    this.handle = handle;
    this.pty = handle !== null;
    this.screen = new TerminalScreen(size);

    if (handle) {
      this.reader = readPty(
        handle.masterFd,
        (chunk) => this.emitOutput(chunk.toString("utf8")),
        (error) => this.emitError(`terminal task ${taskId}: pty read failed: ${messageOf(error)}`),
      );
      // Anything the child half printed before it became the shell (a libc it
      // could not load, a device it could not open) arrives here and nowhere
      // else: after execve those descriptors are the pty itself.
      void this.reportChildStartupFailure();
    } else {
      this.reader = null;
      void this.readStream(child.stdout as ReadableStream<Uint8Array>, "stdout");
      void this.readStream(child.stderr as ReadableStream<Uint8Array>, "stderr");
    }
    void child.exited.then((code) => this.finish(code));
  }

  static open(
    key: string,
    taskId: string,
    cwd: string,
    env: Record<string, string>,
    size: PtySize,
  ): TerminalSession {
    const shell = loginShell();
    const wanted: PtySize = { cols: clampDimension(size.cols), rows: clampDimension(size.rows) };
    let handle: PtyHandle | null = null;
    try {
      handle = openPty(wanted);
      const child = Bun.spawn({
        cmd: ptyExecArgv(handle.slavePath, loginShellArgv(shell)),
        cwd,
        env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
      return new TerminalSession(key, taskId, cwd, child, handle, wanted);
    } catch (ptyError) {
      if (handle) closePty(handle);
      console.warn(
        `[wisp] terminal task ${taskId}: pty setup failed (${messageOf(ptyError)}); falling back to a piped login shell`,
      );
      try {
        const child = Bun.spawn({
          cmd: loginShellArgv(shell),
          cwd,
          env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        return new TerminalSession(key, taskId, cwd, child, null, wanted);
      } catch (plainError) {
        throw new Error(
          `terminal shell spawn failed for task ${taskId}: pty spawn failed (${messageOf(ptyError)}); piped ${shell} -l spawn failed (${messageOf(plainError)})`,
          { cause: plainError },
        );
      }
    }
  }

  /** What a newly attached client must write to see the shell as it stands. */
  scrollback(): Promise<string> {
    return this.screen.snapshot();
  }

  isLive(): boolean {
    return !this.finished;
  }

  isIdle(now = Date.now()): boolean {
    return this.client === null && now - this.detachedAt > IDLE_MS;
  }

  /**
   * One shell, one attachment: the arriving client owns the process from here.
   *
   * The displaced client is TOLD, because nothing else would tell it. Its
   * socket stays open and its screen keeps the output it already had, so the
   * terminal looks live — while `accepts` drops every keystroke it sends and
   * the daemon suppresses even that error to avoid spamming a stale client.
   * Opening the same task in a browser and in the desktop app therefore left
   * one of them a shell you could type into and get nothing from.
   */
  attach(client: TerminalClient): void {
    if (this.finished) throw new Error(`terminal task ${this.taskId}: shell has already exited`);
    const displaced = this.client;
    this.client = client;
    this.detachedAt = 0;
    if (displaced && displaced !== client && displaced.isOpen()) {
      displaced.sendError(DISPLACED_MESSAGE);
    }
  }

  detach(client: TerminalClient): void {
    if (this.client !== client) return;
    this.client = null;
    this.detachedAt = Date.now();
  }

  accepts(client: TerminalClient): boolean {
    return this.client === client && !this.finished;
  }

  write(client: TerminalClient, data: string | Uint8Array): Promise<void> {
    return this.enqueue(async () => {
      if (!this.accepts(client)) {
        throw new Error(`terminal task ${this.taskId}: client is no longer attached`);
      }
      await this.writeAttached(data);
    });
  }

  /**
   * Resize the pty and the daemon's screen model together, so a snapshot can
   * never describe a different geometry than the shell is drawing for.
   */
  resize(client: TerminalClient, cols: number, rows: number): Promise<void> {
    return this.enqueue(async () => {
      if (!this.accepts(client)) {
        throw new Error(`terminal task ${this.taskId}: client is no longer attached`);
      }
      this.applySize({ cols, rows });
    });
  }

  /**
   * Adopt an arriving client's geometry BEFORE it is sent a snapshot. Without
   * this the first thing a reattaching pane renders is the previous pane's
   * width, and the shell only corrects itself one round trip later.
   */
  resizeForAttach(size: PtySize): void {
    if (this.finished) return;
    this.applySize(size);
  }

  private applySize(size: PtySize): void {
    const next: PtySize = { cols: clampDimension(size.cols), rows: clampDimension(size.rows) };
    const current = this.screen.size;
    if (next.cols === current.cols && next.rows === current.rows) return;
    // The piped fallback has no tty at all, so resizing it remains a no-op.
    if (this.handle) resizePty(this.handle, next);
    this.screen.resize(next);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const queued = this.inputQueue.then(operation);
    // A failed write must not poison the queue for a subsequent attachment.
    this.inputQueue = queued.catch(() => undefined);
    return queued;
  }

  private async writeAttached(data: string | Uint8Array): Promise<void> {
    try {
      if (this.handle) {
        await writePty(this.handle.masterFd, data);
        return;
      }
      const stdin = this.child.stdin as Bun.FileSink;
      await stdin.write(data);
      await stdin.flush();
    } catch (error) {
      throw new Error(`terminal task ${this.taskId}: stdin write failed: ${messageOf(error)}`, { cause: error });
    }
  }

  async kill(): Promise<void> {
    if (this.finished) return;
    try {
      this.child.kill("SIGTERM");
    } catch (error) {
      throw new Error(`terminal task ${this.taskId}: failed to signal shell: ${messageOf(error)}`, { cause: error });
    }
    const exited = await Promise.race([
      this.child.exited.then(() => true),
      Bun.sleep(KILL_GRACE_MS).then(() => false),
    ]);
    if (exited) return;
    try {
      this.child.kill("SIGKILL");
    } catch (error) {
      throw new Error(`terminal task ${this.taskId}: failed to SIGKILL shell: ${messageOf(error)}`, { cause: error });
    }
    const killed = await Promise.race([
      this.child.exited.then(() => true),
      Bun.sleep(KILL_GRACE_MS).then(() => false),
    ]);
    if (!killed) throw new Error(`terminal task ${this.taskId}: shell survived SIGKILL`);
  }

  /** The piped fallback's output path; the pty reads from its master instead. */
  private async readStream(stream: ReadableStream<Uint8Array> | null, source: string): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (next.value?.byteLength) this.emitOutput(decoder.decode(next.value, { stream: true }));
      }
      const rest = decoder.decode();
      if (rest) this.emitOutput(rest);
    } catch (error) {
      this.emitError(`terminal task ${this.taskId}: ${source} read failed: ${messageOf(error)}`);
    } finally {
      reader.releaseLock();
    }
  }

  private async reportChildStartupFailure(): Promise<void> {
    const stderr = this.child.stderr;
    if (!stderr || !(stderr instanceof ReadableStream)) return;
    const text = (await new Response(stderr).text()).trim();
    if (text) console.error(`[wisp] terminal task ${this.taskId}: pty child: ${text}`);
  }

  private emitOutput(data: string): void {
    // parsed FIRST and unconditionally: output printed while no browser is
    // attached is exactly the output a reattaching browser needs to see
    this.screen.write(data);
    const client = this.client;
    if (!client || !client.isOpen()) return;
    try {
      client.sendOutput(data);
    } catch (error) {
      console.error(`[wisp] terminal task ${this.taskId}: output delivery failed: ${messageOf(error)}`);
    }
  }

  private emitError(message: string): void {
    const client = this.client;
    if (!client || !client.isOpen()) {
      console.error(`[wisp] ${message}`);
      return;
    }
    try {
      client.sendError(message);
    } catch (error) {
      console.error(`[wisp] ${message}; error delivery failed: ${messageOf(error)}`);
    }
  }

  /**
   * The shell has exited. Close the SLAVE first: the daemon holds it open for
   * the session's lifetime, and until it goes the master will not report the
   * end of the output the shell left buffered there.
   */
  private async finish(code: number): Promise<void> {
    if (this.finished) return;
    // Marked dead BEFORE the drain: a client attaching during it would
    // otherwise be handed a shell that is already gone, and openSession would
    // hand back this session instead of starting a replacement.
    this.finished = true;
    if (this.handle) {
      closePtySlave(this.handle);
      await drained(this.reader);
      // destroy first: the stream holds the master fd, and closing it from
      // under an active read is an EBADF the reader would report as a fault
      this.reader?.destroy();
      closePty(this.handle);
    }
    if (sessions.get(this.key) === this) {
      sessions.delete(this.key);
      stopIdleGcIfEmpty();
    }
    const client = this.client;
    this.client = null;
    this.screen.dispose();
    if (!client || !client.isOpen()) return;
    try {
      client.sendExit(code);
    } catch (error) {
      console.error(`[wisp] terminal task ${this.taskId}: exit delivery failed: ${messageOf(error)}`);
    }
  }
}

/** Wait for a pty reader to deliver what is left, bounded so exit cannot hang. */
function drained(reader: ReadStream | null): Promise<void> {
  if (!reader || reader.closed) return Promise.resolve();
  return Promise.race([
    new Promise<void>((resolve) => {
      reader.once("close", resolve);
      reader.once("end", resolve);
      reader.once("error", () => resolve());
    }),
    Bun.sleep(250),
  ]);
}

const sessions = new Map<string, TerminalSession>();
let idleTimer: ReturnType<typeof setInterval> | null = null;

function keepIdleGcAlive(): void {
  if (idleTimer !== null) return;
  idleTimer = setInterval(() => void idleGc(), IDLE_GC_INTERVAL_MS);
}

function stopIdleGcIfEmpty(): void {
  if (sessions.size !== 0 || idleTimer === null) return;
  clearInterval(idleTimer);
  idleTimer = null;
}

async function idleGc(): Promise<void> {
  const victims = [...sessions.entries()].filter(([, session]) => session.isIdle());
  for (const [key, session] of victims) {
    console.error(`[wisp] terminal ${key}: idle shell exceeded 30 minutes; killing it`);
    try {
      await session.kill();
    } catch (error) {
      console.error(`[wisp] terminal ${key}: idle GC failed: ${messageOf(error)}`);
    }
    if (!session.isLive() || sessions.get(key) === session) sessions.delete(key);
  }
  stopIdleGcIfEmpty();
}

/**
 * Open or reuse the live shell for ONE TAB of a task. Reuse is what makes the
 * pane persistent: a tab switch, a task switch, or a browser reload builds a
 * new websocket, finds this shell still running, and is handed its screen.
 *
 * `size` is the arriving pane's real geometry. A new shell is BORN at it, so
 * the very first prompt is drawn for the pane that will show it; an existing
 * shell is resized to it before that client is sent anything.
 */
export function openSession(
  taskId: string,
  shellId: number,
  worktreePath: string,
  size: PtySize = DEFAULT_PTY_SIZE,
): TerminalSession {
  const key = sessionKey(taskId, shellId);
  const existing = sessions.get(key);
  if (existing?.isLive()) {
    existing.resizeForAttach(size);
    return existing;
  }
  if (existing) sessions.delete(key);
  if (sessions.size >= MAX_SHELLS) {
    throw new Error(`terminal shell limit reached: maximum ${MAX_SHELLS} concurrent shells`);
  }
  const task = getTask(taskId);
  if (!task) throw new Error(`terminal session cannot open: unknown task ${taskId}`);
  const session = TerminalSession.open(
    key,
    taskId,
    worktreePath,
    webTerminalEnv(process.env, taskEnv(task)) as Record<string, string>,
    size,
  );
  sessions.set(key, session);
  keepIdleGcAlive();
  return session;
}

/** Kill EVERY shell a task holds before its worktree is removed. */
export async function killForTask(taskId: string): Promise<void> {
  const prefix = `${taskId}:`;
  const owned = [...sessions.entries()].filter(([key]) => key.startsWith(prefix));
  for (const [key, session] of owned) {
    await session.kill();
    if (sessions.get(key) === session) sessions.delete(key);
  }
  stopIdleGcIfEmpty();
}

/** Kill every shell during daemon shutdown. */
export async function killAll(): Promise<void> {
  const entries = [...sessions.entries()];
  await Promise.all(
    entries.map(async ([key, session]) => {
      try {
        await session.kill();
      } catch (error) {
        console.error(`[wisp] terminal ${key}: shutdown kill failed: ${messageOf(error)}`);
      }
    }),
  );
  for (const [key, session] of entries) {
    if (sessions.get(key) === session) sessions.delete(key);
  }
  stopIdleGcIfEmpty();
}

let shuttingDown = false;
function handleShutdown(signal: "SIGTERM" | "SIGINT"): void {
  if (shuttingDown) return;
  shuttingDown = true;
  void killAll().finally(() => {
    console.error(`[wisp] ${signal}: terminal shells stopped`);
    process.exit(signal === "SIGTERM" ? 143 : 130);
  });
}

process.once("SIGTERM", () => handleShutdown("SIGTERM"));
process.once("SIGINT", () => handleShutdown("SIGINT"));
