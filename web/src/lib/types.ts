/**
 * The daemon's API as this client reads it. Shapes from shared/api are the
 * ones the daemon types its route payloads with, so a daemon change that
 * breaks this client fails typecheck. This file re-exports them and, where a
 * newer client also talks to an older daemon, declares the client's view: the
 * same shape with the fields such a daemon omits made optional. The types
 * still declared in full here mirror the daemon by hand until they move there.
 */
import type {
  ApiTaskListItem,
  ApiTaskMessage,
  ApiTurn,
  BackgroundWork,
  ConversationDetail as DaemonConversationDetail,
  SendResponse as DaemonSendResponse,
  TaskDetail as DaemonTaskDetail,
  TaskState,
  TurnStatus,
} from "../../../shared/api/task";
import type { ActivityEvent } from "../../../shared/api/activity";
import type {
  HarnessLimits as DaemonHarnessLimits,
  HarnessLimitsEntry as DaemonHarnessLimitsEntry,
  LimitWindow as DaemonLimitWindow,
  ProbeCommand as ProbeCommandName,
  TaskSkills as DaemonTaskSkills,
} from "../../../shared/api/harness";
import type { WispPreferences, WispSettings as DaemonWispSettings } from "../../../shared/api/settings";
import type { UpdateStatus as DaemonUpdateStatus } from "../../../shared/api/update";

export { TASK_STATES } from "../../../shared/api/task";
export type {
  AttachResponse,
  BackgroundGroup,
  CleanupSummary,
  HarnessBackgroundTask,
  CompactAnswer,
  SearchResponse,
  SearchSnippet,
  SearchSnippetKind,
  SearchTaskHit,
  SendDisposition,
  SendWhen,
  TaskMode,
  TaskState,
  TaskUsage,
  TurnAttachment,
  TurnCaptureState,
  TurnDiagnosticState,
  TurnInput,
  TurnStatus,
  TurnUsage,
  UsageSummary,
} from "../../../shared/api/task";
export type { ActivityEvent, ActivityStatus, QuestionPrompt } from "../../../shared/api/activity";
export type {
  ContextBreakdown,
  HarnessUsageReport,
  LimitsStatus as HarnessLimitsStatus,
  ProbeAnswer,
  ProbeCommand as ProbeCommandName,
  ProbeReport,
  SkillEntry,
  SlashCommandEntry,
} from "../../../shared/api/harness";
export type {
  FactoryKeyTest,
  ReviewJudgeStatus,
  ReviewJudgeTest,
  SecretKeyStatus,
  SuffixPrompt,
} from "../../../shared/api/settings";
export type { InstallMethod, UpdateState } from "../../../shared/api/update";
export type {
  PullRequestChecks,
  PullRequestInfo,
  PullRequestLifecycle,
  PullRequestMergeState,
  PullRequestOverview,
  PullRequestOverviewEntry,
  PullRequestReview,
  PullRequestStatus,
} from "../../../shared/api/pull-requests";
export type { WispEvent } from "../../../shared/api/events";
export type { ShellInfo } from "../../../shared/api/terminals";

/**
 * A daemon shape as this client reads it: `K` are the fields it must not rely
 * on, because a daemon older than the field omits it, or this client never
 * reads it.
 */
type FromAnyDaemon<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/**
 * A task from GET /api/tasks or GET /api/tasks/:id. The list-only facts
 * (has_workflow, autopilot, latest_turn_*) are absent from the detail routes.
 */
export type ApiTask = FromAnyDaemon<
  Omit<ApiTaskListItem, "background"> & {
    /** Absent on daemons before background detail; render the bare state then. */
    background: FromAnyDaemon<BackgroundWork, "details">;
  },
  | "base_ref"
  | "fast"
  | "context_n"
  | "context_tokens"
  | "attachmentsRetained"
  | "deletionPending"
  | "background"
  | "turn_input"
  | "has_workflow"
  | "autopilot"
  | "latest_turn_model"
  | "latest_turn_exit_code"
  | "latest_turn_has_result"
  | "latest_turn_background"
  | "parent_task_id"
  | "subtask_kind"
  | "report_to_parent"
  | "base_from"
  | "base_sha"
  | "merge_granted_by"
>;

/** A turn from the conversation routes. */
export type Turn = FromAnyDaemon<
  ApiTurn,
  | "outputs"
  | "origin"
  | "context_n"
  | "harness"
  | "requested_model"
  | "requested_effort"
  | "requested_fast"
  | "pid"
  | "pid_start_time"
  | "interrupt_detail"
  | "kill_detail"
  | "exit_code"
  | "capture_mode"
  | "capture_state"
  | "captured_bytes"
  | "omitted_bytes"
  | "omitted_records"
  | "capture_categories"
  | "capture_detail"
  | "diagnostic_state"
  | "diagnostic_bytes"
  | "diagnostic_first_seq"
  | "diagnostic_last_seq"
  | "diagnostic_detail"
  | "diagnostic_evicted_at"
>;

/** A queued, steered or delivered message. */
export type TaskMessage = FromAnyDaemon<
  ApiTaskMessage,
  "workflow_id" | "context_n" | "harness" | "model" | "effort" | "fast" | "deferred"
>;

export interface SendResponse
  extends ApiTask,
    Pick<DaemonSendResponse, "disposition" | "operation" | "interrupted"> {
  message: TaskMessage;
}

/**
 * The daemon's one sentence for a worktree it can no longer read: the directory
 * is gone, or git has forgotten it (D1). Carried by all three read routes under
 * this same name, and always present — `null` means the worktree is readable.
 * Render it muted and capped; never assume the daemon sent one line.
 */
export type WorktreeReason = string | null;

/** GET /api/update and the accepted POST /api/update response. */
export type UpdateStatus = FromAnyDaemon<DaemonUpdateStatus, "lastAttempt">;

/**
 * GET /api/tasks/:id/conversation. `messages` and `pending_question_id` are
 * absent on a daemon that predates them; `has_older_turns` is absent when a
 * legacy daemon returned full history.
 */
export interface ConversationDetail
  extends ApiTask,
    Partial<Pick<DaemonConversationDetail, "pending_question_id" | "has_older_turns" | "older_turns_before">> {
  turns: Turn[];
  messages?: TaskMessage[];
}

/** GET /api/tasks/:id — the legacy Git-aware detail contract retained for clients and CLI. */
export interface TaskDetail extends ConversationDetail, Pick<DaemonTaskDetail, "diffstat"> {
  worktreeReason: WorktreeReason;
}

/**
 * GET /api/status → { tasks: { [id]: StatusEntry } } — live tasks only; archived
 * rows get no badges.
 *
 * A union, not optional counts: a worktree git cannot read has no dirty count
 * and no ahead count, and reporting zeros for it is the exact lie D1 exists to
 * remove. The typechecker makes every call site narrow before it reads one.
 */
export type StatusEntry =
  | { branch: string; dirtyFiles: number; ahead: number; unpushed: boolean; worktreeReason: null }
  | { branch: string; worktreeReason: string };

/** GET /api/tasks/:id/diff (200 path; 409s are mapped to a muted note by the hook). */
export interface DiffResponse {
  /** unified diff: git diff <base> plus new-file patches for `untracked` */
  diff: string;
  truncated: boolean;
  /** paths `git ls-files --others --exclude-standard` named; contents live in `diff` */
  untracked: string[];
  /**
   * The commit the diff was actually measured from — GitHub's base, which is
   * NOT the task's base_commit once a branch has been checked out into the
   * worktree. null for a local task, which diffs against the working tree.
   */
  base: string | null;
  /**
   * Set when the worktree is unreadable: a 200 with an empty diff, because that
   * is a STATE and not a request failure (the archived case is modelled the
   * same way).
   */
  worktreeReason: WorktreeReason;
}

/**
 * GET /api/tasks/:id/file?path=… — one file out of the task's worktree.
 *
 * "Exists but is not text" is a state rather than an error, so the viewer can
 * offer to reveal it instead of reporting a failure. Everything the task does
 * not own is one 404 with one sentence, whatever the reason.
 */
export type WorktreeFileResponse =
  | {
      kind: "text";
      /** canonical, worktree-relative — what the daemon actually read */
      path: string;
      text: string;
      /** the file's real size, which `text` may be a prefix of */
      bytes: number;
      truncated: boolean;
    }
  | { kind: "binary"; path: string; bytes: number };

/**
 * GET/PATCH /api/settings. Each section is absent on a daemon older than it:
 * read a missing `hiddenModels` as "nothing hidden" and hide the section,
 * never as "hide everything".
 */
export type WispSettings = FromAnyDaemon<
  DaemonWispSettings,
  "hiddenModels" | "modelTaskDefaults" | "reviewJudge" | "usageLimits"
>;

/** One plan-usage window. `model` is absent from an older daemon: read that as every model. */
export type LimitWindow = FromAnyDaemon<DaemonLimitWindow, "model">;

/** One harness's plan limits, its windows read as this client's LimitWindow. */
export type HarnessLimitsEntry = Omit<DaemonHarnessLimitsEntry, "limits"> & {
  limits: (Omit<DaemonHarnessLimits, "windows"> & { windows: LimitWindow[] }) | null;
};

/** GET /api/harness-limits */
export interface HarnessLimitsResponse {
  harnesses: HarnessLimitsEntry[];
}

/**
 * PATCH /api/settings. The review judge's `jevApiKey` goes through its own,
 * uncached mutation (`useSaveReviewJudgeKey`), never this one.
 */
export type WispSettingsPatch = Partial<
  Pick<WispPreferences, "autoRenameTasksFromPullRequests" | "hiddenModels" | "modelTaskDefaults">
>;

/**
 * GET /api/repos → { repos: RepoInfo[] } — configured projects first, then
 * active-task repos, deduped by resolved path. `name` is the configured
 * display name or a path-derived basename; `exists` is a live fs probe.
 */
export interface RepoInfo {
  path: string;
  name: string | null;
  exists: boolean;
  /** shell run in each NEW worktree after files are copied in; "" = none */
  setupScript: string;
  /** shell run in the worktree before archive removes it; "" = none */
  archiveScript: string;
  /** globs for untracked files copied into each new worktree (the .env problem) */
  copyFiles: string[];
  /** ref new worktrees fork from; "" = let Wisp resolve the remote default */
  baseBranch: string;
  /** false for a repo wisp only knows from task history — it has no config entry to edit */
  configured: boolean;
  /**
   * Who reviews this project's PRs under auto-review: null = each task's own
   * agent. Absent from a daemon older than auto-review.
   */
  verify?: ProjectVerifyAgent | null;
  /**
   * The second reviewer on auto-review's panel: an agent, "off" (one reviewer
   * always), or null for the same agent as the reviewer. Absent from a daemon
   * without `features.reviewPanel`.
   */
  verifySecond?: ProjectVerifySecond;
  /** The sidebar's summary of the project's verification recipe. Absent from a daemon older than auto-review. */
  verification?: VerificationSummary;
}

/** The project's reviewer agent, as POST /api/projects saves it and GET /api/repos serves it. */
export interface ProjectVerifyAgent {
  harness: string;
  model?: string;
  effort?: string;
}

/** The second reviewer as POST /api/projects saves it: an agent, "off", or null (the same agent as the reviewer). */
export type ProjectVerifySecond = ProjectVerifyAgent | "off" | null;

/** `verification` on a GET /api/repos entry: enough for the sidebar; the full status is GET /api/projects/verification. */
export interface VerificationSummary {
  state: "none" | "active";
  areas: number;
  /** a recipe task's proposal waiting to be activated */
  draft: boolean;
  /** a reviewer reported the recipe failing since it was last activated */
  attention: boolean;
  /** a recipe task is working on it */
  busy: boolean;
}

/** The probed model cache for one harness (null when the probe never ran or failed). */
export interface ProbedModels {
  list: string[];
  defaultModel: string | null;
  probedAt: string;
}

/**
 * GET /api/harnesses → { harnesses: HarnessInfo[] } — capability flags from
 * the adapter's argv templates, defaults from config harnessDefaults, model
 * lists from the daemon's async probe cache (never hardcode a model id).
 */
export interface HarnessInfo {
  name: string;
  hasModel: boolean;
  hasEffort: boolean;
  /**
   * This harness sells a faster lane for the SAME model, so the composer can
   * offer fast mode. The daemon owns the tier VALUES; a client only ever asks
   * for `fast: true`. Absent on an older daemon, which reads as no lane and
   * hides the control rather than offering a switch /send would ignore.
   */
  hasFastMode?: boolean;
  /** S3: the adapter declares one of the three image mechanisms — without it a pasted IMAGE is refused by name */
  hasImage: boolean;
  /**
   * A1d: every kind this harness can be handed. pdf, text and video are on
   * every harness's list (they travel by path); "image" needs a mechanism.
   * Absent on a daemon older than A1d — read `hasImage` in that case.
   */
  attachmentKinds?: ("image" | "pdf" | "text" | "video")[];
  /** A verified active-turn protocol; other harnesses persist for the next turn. */
  hasLiveSteering?: boolean;
  /**
   * A1c: how this harness's images travel, when that has a consequence the user
   * can't see from the rows (droid reads them from a path: png/jpeg only, and
   * vision depends on the model). Absent for argv/stdin harnesses — nothing to
   * caveat. The adapter owns the wording; the composer only renders it.
   */
  imageNote?: string;
  /**
   * The values this harness's effort flag accepts, declared by its adapter and
   * read off the CLI itself (src/adapters.ts). Empty = the adapter names none,
   * and the picker falls back to "a level you have used here before".
   */
  effortLevels?: string[];
  defaults: { model?: string; reasoningEffort?: string };
  models: ProbedModels | null;
  modelsError?: string;
  /**
   * A3: the out-of-turn reads this harness honestly offers — the palette's
   * Tier 2. Empty (or absent, on a stale daemon) means it has none, and the
   * tier renders no group for it.
   */
  probeCommands?: ProbeCommandName[];
  /**
   * A5: how this harness compacts, if it does — "action" runs out of band
   * through POST /api/tasks/:id/compact (recordsTurn tells the entry whether
   * to say "runs a turn"), "prompt" prefills the harness's own compact
   * command as a dedicated turn. null (or absent, on a stale daemon) means
   * compaction is honestly absent and the palette shows no entry.
   */
  compact?: HarnessCompact | null;
}
/** A5: the two honest shapes compaction takes (SP1). */
export type HarnessCompact = { kind: "action"; recordsTurn: boolean } | { kind: "prompt"; prompt: string };

/**
 * GET /api/harnesses response envelope. `features` carries daemon-level
 * capability flags; a daemon that predates a flag omits it, and the client
 * reads absent as unsupported rather than offering a silently ignored switch.
 */
export interface HarnessesResponse {
  harnesses: HarnessInfo[];
  features?: {
    /** /send accepts harness/model/effort/startFreshContext for a running task's NEXT turn. */
    taskAgentSwitching?: boolean;
    /** GET /api/search answers cross-task text search (the sidebar's ⌘⇧F). */
    taskSearch?: boolean;
    taskWorkflows?: boolean;
    /** GET/PUT /api/tasks/:id/autopilot: auto-merge for a task's PR. */
    taskAutopilot?: boolean;
    /** GET /api/tasks/:id/autopilot/history: what auto-merge and auto-fix did (the Autopilot tab's History). */
    autopilotHistory?: boolean;
    /** GET /api/harness-limits: each harness's plan usage windows (the top bar's usage ring). */
    harnessLimits?: boolean;
    /** /api/tasks/:id/terminals: the daemon keeps each task's shell tabs, and closing one kills its shell. */
    taskTerminals?: boolean;
    /** /send takes `when`, tasks carry `turn_input`, and a queued message can be sent now (the composer's queue toggle). */
    steerDelivery?: boolean;
    /**
     * The third autopilot switch, auto-review: GET /api/tasks/:id/auto-review,
     * `autoReview` on the autopilot routes, and /api/projects/verification.
     */
    autoReview?: boolean;
    /**
     * Auto-review's panel: rounds carry a tier, its signals and one review per
     * reviewer (A runs the app, B reads the code), and a project saves a
     * second reviewer (`verifySecond`). Absent: rounds are drawn as phase 1.
     */
    reviewPanel?: boolean;
    /**
     * `wisp capture`: Wisp screenshots a page itself and records where it was
     * served from. Reviews carry each image's provenance and A's waivers, and
     * a round names the areas that need a capture. Absent: no evidence strip.
     */
    capture?: boolean;
  };
}

/** GET /api/tasks/:id/skills. `commands` and `commandError` are absent from a daemon predating command discovery. */
export type TaskSkills = FromAnyDaemon<DaemonTaskSkills, "commands" | "commandError">;

/** Named frames of GET /api/tasks/:id/log/stream. */
export interface LogStreamFrames {
  hello: { version: string };
  backlog: { turn: number; prompt: string; text: string };
  append: { turn: number; text: string };
  "turn-end": { turn: number; status: TurnStatus };
  state: { state: TaskState; state_detail: string | null };
}

/** Named frames when `format=activity`. */
export interface ActivityLogStreamFrames {
  hello: { version: string }
  backlog: { turn: number; prompt: string; activity: ActivityEvent[] }
  append: { turn: number; activity: ActivityEvent[] }
  "turn-end": { turn: number; status: TurnStatus }
  state: { state: TaskState; state_detail: string | null }
}
