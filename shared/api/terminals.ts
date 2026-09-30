/**
 * One shell tab as the daemon keeps it (GET /api/tasks/:id/terminals).
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
