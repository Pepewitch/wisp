/**
 * The daemon's rows. The shapes the API serves (tasks, turns, messages,
 * search) live in shared/api/task.ts, so the daemon and the web client compile
 * against one definition; they are re-exported here for the daemon.
 */
import type {
  ApiTask,
  TaskMessageDelivery,
  TaskMessageStatus,
  TaskMode,
  TaskState,
  TurnCaptureMode,
  TurnCaptureState,
  TurnDiagnosticState,
  TurnOrigin,
  TurnStatus,
} from "../../shared/api/task";
export { TASK_MODES, TASK_STATES } from "../../shared/api/task";
export type {
  ApiTask,
  ApiTaskListItem,
  ApiTaskMessage,
  ApiTurn,
  BackgroundGroup,
  BackgroundWork,
  HarnessBackgroundTask,
  CleanupState,
  CleanupSummary,
  SearchResponse,
  SearchSnippet,
  SearchSnippetKind,
  SearchTaskHit,
  SendResponse,
  SendWhen,
  TaskDetail,
  TaskMessageDelivery,
  TaskMessageStatus,
  TaskMode,
  TaskState,
  TurnCaptureMode,
  TurnCaptureState,
  TurnDiagnosticState,
  TurnInput,
  TurnInputMode,
  TurnOrigin,
  TurnStatus,
} from "../../shared/api/task";

export interface Task {
  id: string;
  title: string;
  /** 1 once a person has named the task; the PR-title sync never overwrites a user's name. */
  custom_title?: number;
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
  /**
   * Fast mode: run turns in the harness's faster lane for the same model
   * (adapters fastMode). SQLite's 0/1, a boolean at the API boundary like
   * `archived`. 0 for every harness without the lane, and for every task that
   * predates the column.
   */
  fast: number;
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
  /**
   * Tokens the harness's model was carrying on its last call in this session,
   * read off the turn stream (adapters/context.ts). NULL = not observed: a
   * fresh context, or a harness whose stream never reveals it.
   */
  context_tokens: number | null;
  seq: number;
  turn_count: number;
  archived: number;
  archive_assets_retained?: number;
  purge_pending?: number;
  /** NULL in rows written before the column existed — read it through taskMode() */
  mode: TaskMode | null;
  /**
   * Task briefs (brief-store.ts): 1 = each eligible turn is asked for one.
   * SQLite's 0/1; `briefEnabled` at the API boundary. Optional in the type
   * only because rows from older fixtures predate the column; the database
   * always has it.
   */
  brief_enabled?: number;
  /** Advances on every off→on, so a re-enable never revives an old turn's binding. */
  brief_generation?: number;
  /** The last admission order handed to a message or answer (store-messages admitTaskInput). */
  input_seq?: number;
  /** Moves whenever a person's input is added, edited, cancelled or changes delivery. */
  input_rev?: number;
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
  fast: number;
  session_id: string | null;
  skills_json: string | null;
  context_tokens: number | null;
  created_at: string;
  updated_at: string;
}

/** A task's run mode, defaulting rows that predate the column to `worktree`. */
export function taskMode(task: Pick<Task, "mode">): TaskMode {
  return task.mode === "local" ? "local" : "worktree";
}

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

export interface Turn {
  id: number;
  task_id: string;
  n: number;
  /** The durable context and requested agent captured before this process started. */
  context_n: number;
  harness: string;
  requested_model: string | null;
  requested_effort: string | null;
  /** Fast mode as requested for this turn; SQLite's 0/1. */
  requested_fast: number;
  prompt: string;
  /** Who asked for it: NULL for a message, 'background' for a call background work woke (migration 21). */
  origin: TurnOrigin | null;
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

/**
 * A user submission is persisted before delivery. Unlike a turn, it can wait
 * for the current process to settle or be admitted to a verified live input.
 */
export interface TaskMessage {
  id: string;
  task_id: string;
  /** Non-null for daemon-originated workflow instructions. */
  workflow_id?: string | null;
  /** Target configuration captured when the message was submitted. */
  context_n: number;
  harness: string;
  model: string | null;
  effort: string | null;
  /** Fast mode as requested for this message; SQLite's 0/1. */
  fast: number;
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
  /**
   * SQLite boolean: held for the next turn. Never steered into a running
   * turn, and queued behind any message sent later without the hold.
   */
  deferred: number;
  attachments_json: string | null;
  /**
   * Who wrote it, fixed at creation: 'human'; 'workflow' for Wisp's own
   * (auto-fix, heartbeat); 'scheduled' for a schedule-steer (the person's
   * words, sent later); 'plugin' for a workflow plugin's wake; 'legacy' for a
   * row older than the column. Internal — delivery frames by it and briefs
   * read it; `workflow_id` stays the API's (clearable) link.
   */
  origin?: import("./turn-input").MessageOrigin;
  /** Admission order among the task's inputs (messages and answers); internal. */
  source_seq?: number | null;
  created_at: string;
  updated_at: string;
}

export interface SendResult {
  disposition: "started" | "steered" | "queued-next";
  message: TaskMessage;
  /** The running turn was stopped so this message could start. */
  interrupted?: boolean;
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
  /** When delivery of this event first failed; the give-up age is counted from here. */
  first_failed_at: string | null;
  /** When delivery gave up on this event; it is never retried after that. */
  dead_at: string | null;
}

/**
 * The status word's suffix, deliberately without the program names: this
 * shares a padded column with every other task in `ls`, and `show` prints a
 * `background:` block right below that names them properly.
 */
export function backgroundSummary(task: ApiTask): string {
  switch (task.background?.state) {
    case "running": {
      // The web label's count: processes the harness named, else each group's live members.
      const count = task.background.details.reduce((sum, group) => sum + (group.tasks?.length || Math.max(1, group.processes)), 0);
      return count > 0 ? ` · ${count} background process${count === 1 ? "" : "es"} running` : " · background work running";
    }
    case "unknown": return " · background status unknown";
    case "stopping": return " · stopping background work";
    default: return "";
  }
}
