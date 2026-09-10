/**
 * The single source of truth for task states (a prior audit). The CLI's
 * STATE_ICON map derives its keys from this via Record<TaskState, string>, and
 * the web app's STATE_DOT / STATE_LABEL / STATE_TEXT maps in
 * web/src/lib/state.ts are Record<TaskState, …> for the same reason — add a
 * state here and both fail to compile until they carry it.
 */
export const TASK_STATES = ["creating", "running", "done", "needs-input", "stuck", "failed"] as const;
export type TaskState = (typeof TASK_STATES)[number];

/**
 * Where a task's turns actually run.
 *
 * `worktree` (the default, and everything wisp did before): an isolated git
 * worktree under WORKTREE_ROOT on its own `wisp/<id>-<words>` branch, created
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
  /**
   * The ref the worktree forked from (`origin/main`, a configured
   * `baseBranch`, an explicit per-task base). NULL for a local task, for a
   * repo with no remote to name, and for every row written before the
   * column existed — all three of which forked from the checkout's HEAD.
   */
  base_ref?: string | null;
  harness: string;
  model: string | null;
  /** Reasoning effort requested for the task (config harnessDefaults at creation, P5b); NULL = harness default. */
  effort: string | null;
  slot: number;
  state: TaskState;
  state_detail: string | null;
  /** Active durable harness context. Existing tasks are migrated to context 1. */
  context_n: number;
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
  archive_assets_retained?: number;
  purge_pending?: number;
  /** NULL in rows written before the column existed — read it through taskMode() */
  mode: TaskMode | null;
  created_at: string;
  updated_at: string;
}

/** One durable harness session boundary inside a task. */
export interface TaskContext {
  id: number;
  task_id: string;
  n: number;
  harness: string;
  model: string | null;
  effort: string | null;
  session_id: string | null;
  skills_json: string | null;
  created_at: string;
  updated_at: string;
}

/** A task's run mode, defaulting rows that predate the column to `worktree`. */
export function taskMode(task: Pick<Task, "mode">): TaskMode {
  return task.mode === "local" ? "local" : "worktree";
}

export type TurnStatus = "running" | "done" | "failed" | "interrupted";

/** Durable selection of the turn-capture semantics used when a process starts. */
export type TurnCaptureMode = "recorder-v1";
export type TurnCaptureState = "complete" | "degraded" | "disabled" | "legacy" | "evicted";
export type TurnDiagnosticState = "complete" | "partial" | "evicted" | "disabled" | "unavailable";

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
/**
 * GET /api/search — the shapes the daemon answers with, shared by the store
 * that builds them (store-search.ts) and the CLI that prints them
 * (cli-search.ts). One definition, so a field cannot mean two things.
 */
export type SearchSnippetKind = "title" | "prompt" | "result" | "message" | "prose";

export interface SearchSnippet {
  kind: SearchSnippetKind;
  /** the turn a prompt/result snippet came from; null for a title or a message */
  turn: number | null;
  /** one collapsed line around the first match, ellipsised at either end */
  text: string;
  /** where the match sits inside `text`, so a client highlights what it was given */
  offset: number;
  length: number;
}

export interface SearchTaskHit {
  id: string;
  title: string;
  repo_path: string;
  updated_at: string;
  /** the task's own state, so a result row renders without a second fetch */
  state: TaskState;
  archived: boolean;
  /** total occurrences across every searched field of this task */
  matches: number;
  snippets: SearchSnippet[];
}

export interface SearchResponse {
  query: string;
  tasks: SearchTaskHit[];
  /** a daemon scan cap was reached: this answer is not the whole ledger */
  truncated: boolean;
  /**
   * Present only while the agent-prose index is still catching up on turns
   * that ended before it existed. A client says so out loud: a search that
   * has not read half your history must not look like one that has.
   */
  indexing?: { remainingTurns: number };
}

/**
 * The CLI's one glyph per state. It lives here rather than in cli.ts because
 * two commands print it now (`ls` and `search`) and the keys derive from
 * TASK_STATES above — adding a state without an icon is a compile error.
 */
export const STATE_ICON: Record<TaskState, string> = {
  creating: "◌",
  running: "●",
  done: "✓",
  "needs-input": "?",
  stuck: "⏸",
  failed: "✗",
};

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

/**
 * One tracked process group that outlived its turn.
 *
 * Everything here is already in `turn_process_groups` or the turn it belongs
 * to; the badge simply never showed it, which left "Background work running"
 * as a fact the operator could neither act on nor dismiss. Deciding whether to
 * Stop needs WHICH turn started it, HOW MANY processes are left, HOW LONG they
 * have outlived the turn, and — the part that actually answers the question —
 * WHAT they are.
 */
export interface BackgroundGroup {
  /** The turn number the operator sees in `show`/the UI, not the row id. */
  turn: number;
  pgid: number;
  /** Live members at the last inventory, not a historical high-water mark. */
  processes: number;
  /** When the owning turn ended, so the UI can age it. Null while unfinished. */
  since: string | null;
  state: "running" | "unknown";
  stopRequested: boolean;
  /**
   * Deduped executable names, best effort — empty when the naming call failed
   * or the group settled between the inventory and now. Never arguments.
   */
  names: string[];
}

export interface BackgroundWork {
  state: "none" | "running" | "unknown" | "stopping";
  groups: number;
  details: BackgroundGroup[];
}

/** Task as the API serializes it: archived is a boolean at the boundary, not SQLite's 0/1 (a prior audit). */
export type ApiTask = Omit<Task, "archived"> & {
  attachmentsRetained?: boolean;
  deletionPending?: boolean;
  cleanup?: import("./archive-progress").CleanupSummary;
  archived: boolean;
  background?: BackgroundWork;
};

export interface Turn {
  id: number;
  task_id: string;
  n: number;
  /** The durable context and requested agent captured before this process started. */
  context_n: number;
  harness: string;
  requested_model: string | null;
  requested_effort: string | null;
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
  /** NULL means the turn predates, or did not opt into, the bounded recorder. */
  capture_mode: TurnCaptureMode | null;
  /** NULL on pre-migration rows; turnCaptureState() maps it to legacy. */
  capture_state: TurnCaptureState | null;
  captured_bytes: number | null;
  omitted_bytes: number | null;
  omitted_records: number | null;
  capture_categories_json: string | null;
  capture_detail: string | null;
  /** Versioned reducer checkpoint; internal and never returned verbatim by the API. */
  outcome_json: string | null;
  /** Wisp-originated termination reason, persisted across daemon restarts. */
  kill_detail: string | null;
  diagnostic_state: TurnDiagnosticState | null;
  diagnostic_bytes: number | null;
  diagnostic_first_seq: number | null;
  diagnostic_last_seq: number | null;
  diagnostic_detail: string | null;
  diagnostic_evicted_at: string | null;
  exit_code: number | null;
  log_file: string;
  started_at: string;
  ended_at: string | null;
}

/** Read old and new turn rows without reinterpreting their capture semantics. */
export function turnCaptureState(turn: Pick<Turn, "capture_mode" | "capture_state">): TurnCaptureState {
  if (turn.capture_state === "evicted") return "evicted";
  if (turn.capture_mode === null) return "legacy";
  return turn.capture_state ?? "complete";
}

export function turnDiagnosticState(turn: Pick<Turn, "diagnostic_state">): TurnDiagnosticState {
  return turn.diagnostic_state ?? "unavailable";
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
  /** Target configuration captured when the message was submitted. */
  context_n: number;
  harness: string;
  model: string | null;
  effort: string | null;
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

/**
 * The status word's suffix, deliberately without the program names: this
 * shares a padded column with every other task in `ls`, and `show` prints a
 * `background:` block right below that names them properly.
 */
export function backgroundSummary(task: ApiTask): string {
  switch (task.background?.state) {
    case "running": return " · background work running";
    case "unknown": return " · background status unknown";
    case "stopping": return " · stopping background work";
    default: return "";
  }
}
