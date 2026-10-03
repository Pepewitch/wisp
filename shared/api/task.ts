/**
 * The daemon's HTTP API contract for tasks, turns and messages: what its
 * serializers actually send. The daemon types its route payloads with these
 * and the web client reads them, so a daemon change that breaks a client
 * fails typecheck instead of rendering the wrong thing.
 *
 * Each shape is the daemon's current output. A client that also talks to an
 * older daemon marks the fields such a daemon omits as optional in its own
 * view (web/src/lib/types.ts), never here.
 *
 * Type-only apart from the two state lists, which both sides iterate.
 */
import type { OutputImage } from "./outputs";
import type { AttachmentMediaType } from "../attachment-sniff";
import type { AutopilotStatus } from "../autopilot";

/**
 * Every task state. The CLI's STATE_ICON and the web's state maps are
 * Record<TaskState, …>, so adding a state fails to compile until each carries it.
 */
export const TASK_STATES = ["creating", "running", "done", "needs-input", "stuck", "failed"] as const;
export type TaskState = (typeof TASK_STATES)[number];

/**
 * Where a task's turns run. `worktree` is an isolated checkout Wisp creates
 * and removes; `local` is the repo checkout itself, which archive never
 * touches. Rows written before the column existed come back as `worktree`.
 */
export const TASK_MODES = ["worktree", "local"] as const;
export type TaskMode = (typeof TASK_MODES)[number];

export type TurnStatus = "running" | "done" | "failed" | "interrupted";
/**
 * Who asked for a turn when it was not a message: `background` is a model call
 * that work the agent started in the background woke on its own after its
 * answer (a Monitor event, a background command finishing). Nobody asked for
 * it, so its finish raises no notification.
 */
export type TurnOrigin = "background";
/** Durable selection of the turn-capture semantics used when a process starts. */
export type TurnCaptureMode = "recorder-v1";
export type TurnCaptureState = "complete" | "degraded" | "disabled" | "legacy" | "evicted";
export type TurnDiagnosticState = "complete" | "partial" | "evicted" | "disabled" | "unavailable";

/**
 * One tracked process group that outlived its turn: which turn started it, how
 * many processes are left, how long they have outlived it, and what they are.
 */
export interface BackgroundGroup {
  /** The turn number the operator sees, not the row id. */
  turn: number;
  pgid: number;
  /** Live members at the last inventory, not a historical high-water mark. */
  processes: number;
  /** When the owning turn ended, so a client can age it. Null while unfinished. */
  since: string | null;
  state: "running" | "unknown";
  stopRequested: boolean;
  /** Deduped executable names, best effort; empty when naming failed. Never arguments. */
  names: string[];
  /**
   * What the harness itself says this group is running, when Wisp kept the
   * harness process alive past the turn's answer because work it started in
   * the background was still going (a Claude `run_in_background` command, a
   * Monitor, a background agent). Absent for any other group. A restarted
   * daemon stops such a process at boot: it cannot give it the next message.
   */
  tasks?: HarnessBackgroundTask[];
}

/** One background task a lingering harness process reports running. */
export interface HarnessBackgroundTask {
  /** The harness's own label for it: the description the agent gave the command or monitor. */
  name: string;
  /** The harness's kind, as it named it (`local_bash`, `local_agent`, …); null when it gave none. */
  kind: string | null;
  /** The turn number it started in, as the operator sees it. */
  turn: number;
  /** When Wisp first saw it start. */
  since: string;
}

export interface BackgroundWork {
  state: "none" | "running" | "unknown" | "stopping";
  groups: number;
  details: BackgroundGroup[];
}

export type CleanupState = "pending" | "running" | "needs-attention" | "complete";

/** An archived task's cleanup progress. */
export interface CleanupSummary {
  state: CleanupState;
  step: string;
  error: string | null;
  retryAt: string | null;
  revision: number;
  uncertain: boolean;
  confirmStopped: boolean;
}

/** When a sender wants a message to reach the agent (/send `when`). Absent keeps "steer, else queue". */
export type SendWhen = "now" | "next-turn";

/**
 * What a message sent now does to the running turn: steered into it, started
 * once the turn ends on its own (its answer is already out), or started by
 * stopping it (no live channel, or a turn a restarted daemon re-adopted).
 */
export type TurnInputMode = "steer" | "wait" | "interrupt";

/** The running turn's input mode and agent: a message for any other agent can only start a new turn. */
export interface TurnInput {
  mode: TurnInputMode;
  context_n: number;
  harness: string;
  model: string | null;
  effort: string | null;
  fast: boolean;
}

/**
 * One turn's usage, normalized through the adapter's usageFormat strategy.
 * Only the numbers the harness reported are present: no invented zeros, no
 * sums, and never money.
 */
export interface UsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  /** prompt tokens served from the provider's cache */
  cachedInputTokens?: number;
  /** prompt tokens written to the provider's cache */
  cacheWriteTokens?: number;
  /** reasoning kept distinct from visible output rather than silently summed */
  reasoningTokens?: number;
}

/**
 * One stored attachment on a turn or message. No URL and no path: the bytes
 * come from `GET /api/tasks/:id/attachments/:turn/:name`, and `name` is the key
 * the daemon checks against that turn's manifest.
 */
export interface TurnAttachment {
  name: string;
  size: number;
  mediaType: AttachmentMediaType;
}

/** A task as the API serializes it: SQLite's 0/1 columns are booleans here. */
export interface ApiTask {
  id: string;
  title: string;
  repo_path: string;
  worktree_path: string | null;
  branch: string | null;
  base_commit: string | null;
  /**
   * Ref the worktree forked from: `origin/main`, the project's configured
   * base, or a per-task override. Null for a local task, for a repo with no
   * remote to name, and for a row written before the column existed.
   */
  base_ref?: string | null;
  harness: string;
  model: string | null;
  effort: string | null;
  /** Turns run in the harness's faster lane for the same model. */
  fast: boolean;
  slot: number;
  state: TaskState;
  state_detail: string | null;
  context_n: number;
  session_id: string | null;
  /**
   * Tokens the model was carrying on its last call in this session, read off
   * the turn stream. Null = not observed (a fresh context, no settled turn, or
   * a harness that only reports a per-turn billing total).
   */
  context_tokens: number | null;
  seq: number;
  turn_count: number;
  archived: boolean;
  mode: TaskMode | null;
  created_at: string;
  updated_at: string;
  /** Task briefs are on for this task. */
  briefEnabled: boolean;
  /** False once archive deleted this task's stored attachments. */
  attachmentsRetained: boolean;
  deletionPending: boolean;
  background: BackgroundWork;
  /** The running turn's input; null while idle and for an archived task. */
  turn_input: TurnInput | null;
  /** Archived tasks only. */
  cleanup?: CleanupSummary;
}

/** GET /api/tasks: each task plus the facts only the list carries. */
export interface ApiTaskListItem extends ApiTask {
  /** True while at least one active or paused workflow is attached. */
  has_workflow: boolean;
  /** Auto-merge for the task's PR; null when it was never armed. */
  autopilot: AutopilotStatus | null;
  /** The model the latest turn actually ran on. */
  latest_turn_model: string | null;
  /** The latest turn's exit code, the fact behind the "exited N" word. */
  latest_turn_exit_code: number | null;
  /** Whether the latest turn delivered a result; "exited N" requires it. */
  latest_turn_has_result: boolean;
  /** The latest turn was one background work woke (TurnOrigin), not a message: its finish is not news. */
  latest_turn_background: boolean;
}

/** A turn as the API serves it: internal JSON columns parsed, never relayed raw. */
export interface ApiTurn {
  id: number;
  task_id: string;
  n: number;
  /** The durable context and requested agent captured before the process started. */
  context_n: number;
  harness: string;
  requested_model: string | null;
  requested_effort: string | null;
  requested_fast: boolean;
  prompt: string;
  /** Null for a message's turn; see TurnOrigin. */
  origin: TurnOrigin | null;
  /** Adapter-declared lifecycle; absent means an ordinary agent turn. */
  operation?: "compact";
  result: string | null;
  status: TurnStatus;
  pid: number | null;
  pid_start_time: string | null;
  interrupt_detail: string | null;
  kill_detail: string | null;
  exit_code: number | null;
  /** The model the turn actually ran on; null = the harness never reported one. */
  model: string | null;
  /** The harness's own usage numbers, normalized; null = none reported. */
  usage: UsageSummary | null;
  /**
   * The attachments this turn carried, `[]` for none. It survives archive,
   * which deletes the bytes, so a non-empty list on an archived task means
   * "there was an attachment here and it is gone".
   */
  attachments: TurnAttachment[];
  /** Task-owned images returned or explicitly published by the agent. */
  outputs: OutputImage[];
  /** Null means the turn predates, or did not opt into, the bounded recorder. */
  capture_mode: TurnCaptureMode | null;
  capture_state: TurnCaptureState;
  captured_bytes: number | null;
  omitted_bytes: number | null;
  omitted_records: number | null;
  capture_categories: Record<string, { records: number; bytes: number }> | null;
  capture_detail: string | null;
  diagnostic_state: TurnDiagnosticState;
  diagnostic_bytes: number | null;
  diagnostic_first_seq: number | null;
  diagnostic_last_seq: number | null;
  diagnostic_detail: string | null;
  diagnostic_evicted_at: string | null;
  log_file: string;
  started_at: string;
  ended_at: string | null;
}

export type TaskMessageStatus = "queued" | "delivered" | "cancelled";
export type TaskMessageDelivery = "started" | "steered" | null;

/** A submission persisted before delivery, as the API serves it. */
export interface ApiTaskMessage {
  id: string;
  task_id: string;
  /** Non-null for daemon-originated workflow instructions. */
  workflow_id?: string | null;
  /** Target agent captured when the message was submitted. */
  context_n: number;
  harness: string;
  model: string | null;
  effort: string | null;
  fast: boolean;
  text: string;
  status: TaskMessageStatus;
  delivery: TaskMessageDelivery;
  turn_n: number | null;
  /** Delivery may have succeeded before its acknowledgement or turn record was lost. */
  delivery_uncertain: boolean;
  /** Held for the next turn by the composer's queue toggle. */
  deferred: boolean;
  attachments: TurnAttachment[];
  created_at: string;
  updated_at: string;
}

export type SendDisposition = "started" | "steered" | "queued-next";

/** POST /api/tasks/:id/send */
export interface SendResponse extends ApiTask {
  disposition: SendDisposition;
  message: ApiTaskMessage;
  operation?: "compact";
  /** The running turn was stopped so this message could start. */
  interrupted?: boolean;
}

/** GET /api/tasks/:id/conversation: task history with no filesystem or Git work. */
export interface ConversationDetail extends ApiTask {
  latest_turn_model: string | null;
  latest_turn_exit_code: number | null;
  latest_turn_has_result: boolean;
  turns: ApiTurn[];
  messages: ApiTaskMessage[];
  /**
   * The one question the harness is blocked on right now, if any. Only the
   * live driver knows which unreleased question can still be answered.
   */
  pending_question_id: string | null;
  /** Present on bounded (`limit=`) responses only. */
  has_older_turns?: boolean;
  /** Exclusive cursor for the next older page; bounded responses only. */
  older_turns_before?: number | null;
}

/** GET /api/tasks/:id: the Git-aware detail contract kept for clients and the CLI. */
export interface TaskDetail extends ConversationDetail {
  /** Null whenever there is nothing to measure, including an unreadable worktree. */
  diffstat: string | null;
  /** The daemon's one sentence for a worktree it can no longer read; null when readable. */
  worktreeReason: string | null;
}

/**
 * GET /api/tasks/:id/attach: the harness's own interactive resume command for
 * the task's session. `argv: null` means there is nothing honest to show (no
 * session yet, or no attach command) and `message` says which; `cwd` is the
 * directory the command belongs in.
 */
export interface AttachResponse {
  argv: string[] | null;
  cwd: string | null;
  message: string | null;
}

/**
 * POST /api/tasks/:id/compact: only what the harness reported. removedCount
 * is null when the harness doesn't count; sessionReplaced is a new session id;
 * note carries the one sentence beyond the numbers.
 */
export interface CompactAnswer {
  ok: true;
  removedCount: number | null;
  sessionReplaced: boolean;
  note: string | null;
}

/** One turn's usage row in GET /api/tasks/:id/usage. */
export interface TurnUsage {
  id: number;
  n: number;
  usage: UsageSummary;
}

/** GET /api/tasks/:id/usage: bounded detail plus exact task-wide totals. */
export interface TaskUsage {
  total: UsageSummary;
  reporting_turns: number;
  turns: TurnUsage[];
  has_older_turns: boolean;
}

/**
 * GET /api/search: exact text across this daemon's tasks. A snippet says which
 * of five places answered: a title, a turn's prompt, its result, a message, or
 * the agent's own prose from inside a turn.
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
  /**
   * The task's own state and archived flag travel with the hit, so a result
   * row renders from the response alone, archived or not yet listed.
   */
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
   * Present only while the agent-prose index is catching up on turns that
   * ended before it existed; a miss meanwhile is not a definitive miss.
   */
  indexing?: { remainingTurns: number };
}
