/**
 * The single source of truth for task states (a prior audit). The CLI's
 * STATE_ICON map derives its keys from this via Record<TaskState, string>, and
 * the web app's STATE_DOT / STATE_LABEL / STATE_TEXT maps in
 * web/ui/src/lib/state.ts are Record<TaskState, …> for the same reason — add a
 * state here and both fail to compile until they carry it.
 */
export const TASK_STATES = ["creating", "running", "done", "needs-input", "stuck", "failed"] as const;
export type TaskState = (typeof TASK_STATES)[number];

/**
 * Where a task's turns actually run.
 *
 * `worktree` (the default, and everything wisp did before): an isolated git
 * worktree under WORKTREE_ROOT on its own `wisp/<id>-<slug>` branch, created
 * at task start and REMOVED at archive.
 *
 * `local`: the repo checkout itself, on whatever branch it is already on.
 * Nothing is created and — the load-bearing half — nothing is ever removed,
 * because that directory is the user's actual working copy. Archive must not
 * touch it, and neither setup nor archive scripts run for it: those exist to
 * make a FRESH worktree usable, and re-running them over a live checkout is
 * how you delete someone's node_modules mid-edit.
 */
export const TASK_MODES = ["worktree", "local"] as const;
export type TaskMode = (typeof TASK_MODES)[number];

export interface Task {
  id: string;
  title: string;
  repo_path: string;
  /** the worktree for a `worktree` task; the repo checkout itself for a `local` one */
  worktree_path: string | null;
  branch: string | null;
  base_commit: string | null;
  harness: string;
  model: string | null;
  /** Reasoning effort requested for the task (config harnessDefaults at creation, P5b); NULL = harness default. */
  effort: string | null;
  slot: number;
  state: TaskState;
  state_detail: string | null;
  session_id: string | null;
  /**
   * The skill names the session's init event announced (A4, claude), as a
   * JSON array; NULL = no init list captured yet (or a harness that never
   * sends one). Read it through JSON.parse at the boundary that needs it.
   */
  skills_json: string | null;
  seq: number;
  turn_count: number;
  archived: number;
  /** NULL in rows written before the column existed — read it through taskMode() */
  mode: TaskMode | null;
  created_at: string;
  updated_at: string;
}

/** A task's run mode, defaulting rows that predate the column to `worktree`. */
export function taskMode(task: Pick<Task, "mode">): TaskMode {
  return task.mode === "local" ? "local" : "worktree";
}

export type TurnStatus = "running" | "done" | "failed" | "interrupted";

/**
 * The honest failure word (Theme B, Q12). A turn that exits NONZERO after
 * delivering a terminal assistant message is not a failure of the work — the
 * harness CLI exited badly at session end (three overnight tasks did all their
 * work with green gates and reported "✗ failed"). The list says what actually
 * happened: "exited 1". A result-less failure keeps "failed" — spawn errors,
 * unparseable output, an unknown exit with nothing delivered: those really did
 * not deliver. No new TaskState: the state machine, the notify rules and the
 * outbox keep "failed"; only the WORD changes, derived from facts the store
 * already holds (the latest turn's exit_code and result presence).
 */
export function displayStateWord(
  state: TaskState,
  latestTurnExitCode: number | null | undefined,
  latestTurnHasResult: boolean | undefined,
): string {
  if (state === "failed" && latestTurnHasResult && latestTurnExitCode !== null && latestTurnExitCode !== undefined && latestTurnExitCode !== 0) {
    return `exited ${latestTurnExitCode}`;
  }
  return state;
}

/** Task as the API serializes it: archived is a boolean at the boundary, not SQLite's 0/1 (a prior audit). */
export type ApiTask = Omit<Task, "archived"> & { archived: boolean };

export interface Turn {
  id: number;
  task_id: string;
  n: number;
  prompt: string;
  result: string | null;
  status: TurnStatus;
  pid: number | null;
  /** Process start time recorded at spawn — validates pid identity across restarts (H1). */
  pid_start_time: string | null;
  /** Interrupt intent + its message, persisted so it survives a daemon crash (M2). */
  interrupt_detail: string | null;
  /** The model the turn ACTUALLY ran on, parsed from the harness's own events (P5b). NULL = never reported. */
  model: string | null;
  /**
   * This turn's image manifest as JSON (A1a) — `[{name, size, mediaType}]`, or
   * NULL for a turn that carried none. It outlives the bytes, which archive
   * deletes. Never served raw: `apiTurn` parses it into `attachments`.
   */
  attachments_json: string | null;
  /**
   * The harness's own usage report for this turn, raw JSON (Theme B) — one
   * blob, not per-field columns, because every harness reports a different
   * shape and the raw blob is the fact. NULL when the harness reported nothing
   * (an interrupted turn, a pre-column row, a harness with no usage event).
   * Never served raw: `apiTurn` normalizes it through the adapter's
   * `usageFormat` strategy into `usage`.
   */
  usage_json: string | null;
  exit_code: number | null;
  log_file: string;
  started_at: string;
  ended_at: string | null;
}

export type TaskMessageStatus = "queued" | "delivered" | "cancelled";
export type TaskMessageDelivery = "started" | "steered" | null;

/**
 * A user submission is persisted before delivery. Unlike a turn, it can wait
 * for the current process to settle or be admitted to a verified live input.
 */
export interface TaskMessage {
  id: string;
  task_id: string;
  text: string;
  status: TaskMessageStatus;
  delivery: TaskMessageDelivery;
  turn_n: number | null;
  /** Internal crash-safe reservation, never exposed by the HTTP API. */
  claim: TaskMessageDelivery;
  /** Intended turn for `claim`, likewise internal. */
  claim_turn_n: number | null;
  /** Internal hash used to reject stable-ID retries with different attachment bytes. */
  attachment_hash: string;
  /** SQLite boolean: a daemon crash or failed acknowledgement made delivery indeterminate. */
  delivery_uncertain: number;
  attachments_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface SendResult {
  disposition: "started" | "steered" | "queued-next";
  message: TaskMessage;
}

export interface OutboxRow {
  id: number;
  task_id: string;
  seq: number;
  event: string;
  payload: string;
  attempts: number;
  next_attempt_at: string;
  delivered_at: string | null;
  last_error: string | null;
  created_at: string;
}
