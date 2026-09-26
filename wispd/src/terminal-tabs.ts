import { emit } from "./events";

/** Coalesces a burst of tab changes into one `terminals` event per task. */
const ANNOUNCE_MS = 100;
/** The longest custom name a shell tab takes; the strip truncates well before it. */
export const MAX_SHELL_NAME_LENGTH = 64;
/**
 * Any program in the shell sets the title, and it rides on every tab list for
 * the tab's life. Longer than a name, because the usual one is `user@host:cwd`.
 */
export const MAX_SHELL_TITLE_LENGTH = 256;

/** The sessions map key: one shell per (task, tab), so tabs are real shells. */
export function sessionKey(taskId: string, shellId: number): string {
  return `${taskId}:${shellId}`;
}

/**
 * One tab of a task's terminal pane, as every client sees it.
 *
 * The DAEMON keeps the list, not each browser: a tab is a promise that a
 * shell is there, and a list held per window let the desktop app and a
 * browser disagree about which shells exist — and let a shell outlive every
 * tab that could show it. So a tab exists until someone closes it here, and
 * closing it is what kills its shell.
 *
 * `id` addresses the shell's socket and is reused once its tab is gone.
 * `number` never is: it only counts up, so a new tab is never mistaken for
 * the one that was just closed.
 */
export interface ShellInfo {
  id: number;
  number: number;
  /** what the user named this tab; null means it is named after what it runs */
  name: string | null;
  /** the window title the shell last set (OSC 0/2) */
  title: string | null;
  /** the program in the foreground; null while the shell is at its prompt */
  program: string | null;
  /** the login shell's name, the label of last resort */
  shell: string;
  /** set when the shell ended by itself and nothing has replaced it yet */
  exitCode: number | null;
  createdAt: string;
}

export interface ShellRecord extends ShellInfo {
  taskId: string;
}

/** Keyed like the terminal's sessions, so a record and its process are found the same way. */
const records = new Map<string, ShellRecord>();
/** The last tab number handed out per task. In memory: shells do not survive a restart either. */
const shellNumbers = new Map<string, number>();
const announceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** A refusal the route turns into a 409 rather than a 500. */
export class ShellConflictError extends Error {}

export function shellInfo(record: ShellRecord): ShellInfo {
  const { taskId: _taskId, ...info } = record;
  return { ...info };
}

function tabsOf(taskId: string): ShellRecord[] {
  return [...records.values()].filter((record) => record.taskId === taskId).sort((a, b) => a.number - b.number);
}

/** Tell every client this task's tab list changed; they refetch it. */
function announce(taskId: string): void {
  if (announceTimers.has(taskId)) return;
  announceTimers.set(
    taskId,
    setTimeout(() => {
      announceTimers.delete(taskId);
      emit({ type: "terminals", taskId });
    }, ANNOUNCE_MS),
  );
}

/** Open a tab under `id`; it takes the next number, never an earlier one. */
export function addTab(taskId: string, id: number, shell: string): ShellRecord {
  const number = (shellNumbers.get(taskId) ?? 0) + 1;
  shellNumbers.set(taskId, number);
  const record: ShellRecord = {
    taskId,
    id,
    number,
    name: null,
    title: null,
    program: null,
    shell,
    exitCode: null,
    createdAt: new Date().toISOString(),
  };
  records.set(sessionKey(taskId, id), record);
  announce(taskId);
  return record;
}

export function findTab(key: string): ShellRecord | undefined {
  return records.get(key);
}

/** Take a tab out of the list; its shell is the caller's to kill. */
export function removeTab(key: string): void {
  const record = records.get(key);
  if (!record) return;
  records.delete(key);
  announce(record.taskId);
}

/** A tab whose shell is starting over forgets what the last one said about itself. */
export function resetTab(record: ShellRecord): void {
  if (record.exitCode === null && record.program === null && record.title === null) return;
  record.exitCode = null;
  record.program = null;
  record.title = null;
  announce(record.taskId);
}

/** Apply what a running shell reported about itself, announcing only a real change. */
export function noteShell(key: string, change: Partial<Pick<ShellInfo, "title" | "program">>): void {
  const record = records.get(key);
  if (!record) return;
  let changed = false;
  const title = change.title === undefined ? undefined : (change.title?.slice(0, MAX_SHELL_TITLE_LENGTH) ?? null);
  if (title !== undefined && title !== record.title) {
    record.title = title;
    changed = true;
  }
  if (change.program !== undefined && change.program !== record.program) {
    record.program = change.program;
    changed = true;
  }
  if (changed) announce(record.taskId);
}

/**
 * The shell ended by itself — `exit`, Ctrl-D, a crash. The tab goes with it,
 * as a terminal window does, unless it is the task's last one: the pane is
 * never left empty, so that one stays and says how the shell ended.
 */
export function noteNaturalExit(key: string, code: number): void {
  const record = records.get(key);
  if (!record) return;
  if (tabsOf(record.taskId).length > 1) records.delete(key);
  else {
    record.exitCode = code;
    record.program = null;
  }
  announce(record.taskId);
}

/** The tabs a task has, in the order they were opened. */
export function listShells(taskId: string): ShellInfo[] {
  return tabsOf(taskId).map(shellInfo);
}

/** Name a tab, or give it back its automatic name with null. */
export function renameShell(taskId: string, id: number, name: string | null): ShellInfo | null {
  const record = records.get(sessionKey(taskId, id));
  if (!record) return null;
  const next = name?.trim().slice(0, MAX_SHELL_NAME_LENGTH) || null;
  if (next !== record.name) {
    record.name = next;
    announce(taskId);
  }
  return shellInfo(record);
}

/** An archived task has no terminal to show its tabs in. */
export function forgetTabs(taskId: string): void {
  const prefix = `${taskId}:`;
  for (const key of [...records.keys()]) if (key.startsWith(prefix)) records.delete(key);
  shellNumbers.delete(taskId);
}

export function forgetAllTabs(): void {
  records.clear();
  shellNumbers.clear();
  for (const timer of announceTimers.values()) clearTimeout(timer);
  announceTimers.clear();
}
