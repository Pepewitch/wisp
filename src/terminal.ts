import { existsSync } from "node:fs";
import { taskEnv } from "./runner";
import { getTask } from "./store";

/** Live shells across every task. Each is a real login shell, so this is a resource cap. */
const MAX_SHELLS = 32;
/** Shells one task may hold — the terminal pane's tab count, bounded. */
export const MAX_SHELLS_PER_TASK = 8;
const IDLE_MS = 30 * 60 * 1000;
const IDLE_GC_INTERVAL_MS = 60 * 1000;
const KILL_GRACE_MS = 5_000;
/** The browser renderer is xterm.js, regardless of the daemon's own terminal. */
export const WEB_TERMINAL_TERM = "xterm-256color";

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
  };
}

/**
 * Characters of shell output held for replay to a reattaching browser. The
 * shell process outlives its websocket by design, so without this a tab
 * switch hands you a live shell behind a blank screen — the process kept its
 * cwd, its history and its running jobs, and the screen showed none of it.
 */
export const REPLAY_MAX_CHARS = 256 * 1024;

/**
 * The scrollback handed to a reattaching client. Chunks are kept WHOLE and
 * dropped from the front, because shell output is a stream of ANSI escape
 * sequences: slicing mid-sequence hands xterm half a control code. A single
 * chunk past the cap keeps its TAIL — the newest output is the useful end.
 *
 * Measured in UTF-16 units rather than bytes: the session decodes to strings
 * before it ever reaches here, and shell output is overwhelmingly ASCII, so
 * counting characters keeps the cap honest without a re-encode per chunk.
 */
export class ReplayBuffer {
  private readonly chunks: string[] = [];
  private size = 0;
  readonly cap: number;

  constructor(cap: number = REPLAY_MAX_CHARS) {
    this.cap = cap;
  }

  push(data: string): void {
    if (data === "") return;
    const chunk = data.length > this.cap ? data.slice(data.length - this.cap) : data;
    this.chunks.push(chunk);
    this.size += chunk.length;
    // never drop the last chunk: it is already <= cap, so the loop is done
    while (this.size > this.cap && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
    }
  }

  text(): string {
    return this.chunks.join("");
  }

  get length(): number {
    return this.size;
  }
}

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

type ShellProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

export interface TerminalSpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The small synchronous runner used for ps/stty, injectable for resize tests. */
export type TerminalSpawnFn = (cmd: string[]) => TerminalSpawnResult;

export const terminalSpawn: TerminalSpawnFn = (cmd) => {
  const result = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString().trim() };
};

/** `ps` prints a blank-padded tty name; reject `?` and any ambiguous output. */
export function parseTty(output: string): string | null {
  const tty = output.trim();
  if (!tty || tty === "?" || !/^(?:tty[^/\s]+|pts\/[^/\s]+)$/.test(tty)) return null;
  return tty;
}

export function ttyForPidArgv(pid: number): string[] {
  return ["ps", "-o", "tty=", "-p", String(pid)];
}

export function sttyResizeArgv(platform: string, device: string, cols: number, rows: number): string[] {
  const flag = platform === "darwin" ? "-f" : platform === "linux" ? "-F" : null;
  if (!flag) throw new Error(`stty resize is unsupported on platform '${platform}'`);
  return ["stty", flag, device, "rows", String(rows), "cols", String(cols)];
}

interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

export interface PtyDevice {
  pid: number;
  path: string;
}

function processTableArgv(): string[] {
  // `-a -x` is accepted by both BSD ps (macOS) and procps ps (Linux).
  return ["ps", "-axo", "pid=,ppid=,comm="];
}

function parseProcessTable(output: string): ProcessRow[] | null {
  const lines = output.trim().split("\n");
  if (!output.trim()) return null;
  const rows: ProcessRow[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) return null;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! });
  }
  return rows;
}

function commandBase(command: string): string {
  const name = command.trim().split(/\s+/, 1)[0] ?? "";
  return name.slice(name.lastIndexOf("/") + 1).replace(/^[-+]/, "");
}

function shellBase(shell: string): string {
  return shell.slice(shell.lastIndexOf("/") + 1).replace(/^[-+]/, "");
}

function descendantRows(rootPid: number, rows: ProcessRow[]): Array<ProcessRow & { depth: number }> {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row);
    children.set(row.ppid, siblings);
  }
  const descendants: Array<ProcessRow & { depth: number }> = [];
  const seen = new Set<number>([rootPid]);
  const visit = (parent: number, depth: number): void => {
    for (const row of children.get(parent) ?? []) {
      if (seen.has(row.pid)) continue;
      seen.add(row.pid);
      descendants.push({ ...row, depth });
      visit(row.pid, depth + 1);
    }
  };
  visit(rootPid, 1);
  return descendants;
}

/** Find the login shell below the script wrapper, with a deepest-child fallback. */
export function findLoginShellPid(rootPid: number, shell: string, spawn: TerminalSpawnFn = terminalSpawn): number | null {
  let result: TerminalSpawnResult;
  try {
    result = spawn(processTableArgv());
  } catch {
    return null;
  }
  if (result.exitCode !== 0) return null;
  const rows = parseProcessTable(result.stdout);
  if (!rows) return null;
  const descendants = descendantRows(rootPid, rows);
  const expected = shellBase(shell);
  const shellRows = descendants.filter((row) => commandBase(row.command) === expected);
  const candidates = (shellRows.length ? shellRows : descendants).sort((a, b) => b.depth - a.depth);
  return candidates[0]?.pid ?? null;
}

function ttyForPid(pid: number, spawn: TerminalSpawnFn): string | null {
  let result: TerminalSpawnResult;
  try {
    result = spawn(ttyForPidArgv(pid));
  } catch {
    return null;
  }
  return result.exitCode === 0 ? parseTty(result.stdout) : null;
}

function resolvePtyDevice(rootPid: number, shell: string, spawn: TerminalSpawnFn): PtyDevice | null {
  const pid = findLoginShellPid(rootPid, shell, spawn);
  if (pid === null) return null;
  const tty = ttyForPid(pid, spawn);
  return tty ? { pid, path: `/dev/${tty}` } : null;
}

export interface PtyResizeOptions {
  rootPid: number;
  shell: string;
  platform: string;
  cols: number;
  rows: number;
  device: PtyDevice | null;
  spawn?: TerminalSpawnFn;
  fallback: () => void | Promise<void>;
}

export interface PtyResizeResult {
  device: PtyDevice | null;
  usedPty: boolean;
}

/** Resize the script-owned tty without writing anything to the shell's stdin. */
export async function resizePty(options: PtyResizeOptions): Promise<PtyResizeResult> {
  const spawn = options.spawn ?? terminalSpawn;
  let device = options.device;
  if (device) {
    const currentTty = ttyForPid(device.pid, spawn);
    if (!currentTty || `/dev/${currentTty}` !== device.path) device = null;
  }
  if (!device) device = resolvePtyDevice(options.rootPid, options.shell, spawn);
  if (device) {
    try {
      const result = spawn(sttyResizeArgv(options.platform, device.path, options.cols, options.rows));
      if (result.exitCode === 0) return { device, usedPty: true };
    } catch {
      // A disappearing shell or a platform-specific stty failure uses the safe fallback below.
    }
  }
  await options.fallback();
  return { device: null, usedPty: false };
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

/** The exact script(1) invocation differs between the BSD and util-linux implementations. */
export function darwinPtyArgv(shell: string = loginShell()): string[] {
  return ["script", "-q", "/dev/null", shell, "-l"];
}

export function linuxPtyArgv(shell: string = loginShell()): string[] {
  // util-linux script runs -c through sh -c, so the shell path is quoted into the string
  return ["script", "-q", "-c", `${shellQuote(shell)} -l`, "/dev/null"];
}

function ptyArgv(platform: string, shell: string): string[] {
  if (platform === "darwin") return darwinPtyArgv(shell);
  if (platform === "linux") return linuxPtyArgv(shell);
  throw new Error(`script(1) PTY is unsupported on platform '${platform}'`);
}

function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

function ptySpawnArgv(shell: string): string[] {
  const argv = ptyArgv(process.platform, shell);
  const scriptPath = Bun.which("script");
  if (!scriptPath) throw new Error("script(1) is not available on PATH");
  // Bun's piped stdin is a socket, while script(1) implementations inspect
  // stdin as an OS pipe/terminal before creating their PTY. Put a tiny cat
  // process in front of script to provide that POSIX pipe. The shell still
  // runs inside script(1)'s PTY, and the named argv above remains the
  // platform strategy we use for the actual script invocation.
  return ["bash", "-c", `cat | exec ${[scriptPath, ...argv.slice(1)].map(shellQuote).join(" ")}`];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  private readonly shell: string;
  private client: TerminalClient | null = null;
  private detachedAt = Date.now();
  private finished = false;
  private inputQueue: Promise<void> = Promise.resolve();
  private ptyDevice: PtyDevice | null = null;
  /** everything the shell has printed, capped — replayed to whoever attaches next */
  private readonly replay = new ReplayBuffer();

  private constructor(key: string, taskId: string, cwd: string, child: ShellProcess, pty: boolean, shell: string) {
    this.key = key;
    this.taskId = taskId;
    this.cwd = cwd;
    this.child = child;
    this.pty = pty;
    this.shell = shell;
    const outputDone = Promise.all([this.readStream(child.stdout, "stdout"), this.readStream(child.stderr, "stderr")]);
    void child.exited.then(async (code) => {
      await outputDone;
      this.onExit(code);
    });
  }

  static open(key: string, taskId: string, cwd: string, env: Record<string, string>): TerminalSession {
    let child: ShellProcess;
    let pty = true;
    const shell = loginShell();
    try {
      child = Bun.spawn({
        cmd: ptySpawnArgv(shell),
        cwd,
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (ptyError) {
      pty = false;
      console.warn(
        `[wisp] terminal task ${taskId}: script(1) PTY spawn failed (${messageOf(ptyError)}); falling back to a piped login shell`,
      );
      try {
        child = Bun.spawn({
          cmd: [shell, "-l"],
          cwd,
          env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (plainError) {
        throw new Error(
          `terminal shell spawn failed for task ${taskId}: PTY spawn failed (${messageOf(ptyError)}); piped ${shell} -l spawn failed (${messageOf(plainError)})`,
          { cause: plainError },
        );
      }
    }
    return new TerminalSession(key, taskId, cwd, child!, pty, shell);
  }

  /** What a newly attached client must render to see what the shell already printed. */
  scrollback(): string {
    return this.replay.text();
  }

  isLive(): boolean {
    return !this.finished;
  }

  isIdle(now = Date.now()): boolean {
    return this.client === null && now - this.detachedAt > IDLE_MS;
  }

  attach(client: TerminalClient): void {
    if (this.finished) throw new Error(`terminal task ${this.taskId}: shell has already exited`);
    this.client = client;
    this.detachedAt = 0;
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
   * script(1) owns the PTY, so resize it from outside with stty against the
   * shell's slave tty. This avoids echoing a command into the user's shell;
   * discovery failures retain the old injected-command fallback.
   */
  resize(client: TerminalClient, cols: number, rows: number): Promise<void> {
    return this.enqueue(async () => {
      if (!this.accepts(client)) {
        throw new Error(`terminal task ${this.taskId}: client is no longer attached`);
      }
      // The piped fallback has no tty at all, so resizing it remains a no-op.
      if (!this.pty) return;
      const result = await resizePty({
        rootPid: this.child.pid,
        shell: this.shell,
        platform: process.platform,
        cols,
        rows,
        device: this.ptyDevice,
        fallback: () => this.writeAttached(`stty rows ${rows} cols ${cols}\r`),
      });
      this.ptyDevice = result.device;
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const queued = this.inputQueue.then(operation);
    // A failed write must not poison the queue for a subsequent attachment.
    this.inputQueue = queued.catch(() => undefined);
    return queued;
  }

  private async writeAttached(data: string | Uint8Array): Promise<void> {
    try {
      await this.child.stdin.write(data);
      await this.child.stdin.flush();
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

  private async readStream(stream: ReadableStream<Uint8Array>, source: string): Promise<void> {
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

  private emitOutput(data: string): void {
    // buffered FIRST and unconditionally: output printed while no browser is
    // attached is exactly the output a reattaching browser needs replayed
    this.replay.push(data);
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

  private onExit(code: number): void {
    if (this.finished) return;
    this.finished = true;
    if (sessions.get(this.key) === this) {
      sessions.delete(this.key);
      stopIdleGcIfEmpty();
    }
    const client = this.client;
    this.client = null;
    if (!client || !client.isOpen()) return;
    try {
      client.sendExit(code);
    } catch (error) {
      console.error(`[wisp] terminal task ${this.taskId}: exit delivery failed: ${messageOf(error)}`);
    }
  }
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
 * new websocket, finds this shell still running, and replays its scrollback.
 */
export function openSession(taskId: string, shellId: number, worktreePath: string): TerminalSession {
  const key = sessionKey(taskId, shellId);
  const existing = sessions.get(key);
  if (existing?.isLive()) return existing;
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
