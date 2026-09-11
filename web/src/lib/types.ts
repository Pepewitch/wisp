/**
 * Client-side mirror of the daemon's API shapes (src/types.ts, src/daemon.ts).
 * The state list pairs with TASK_STATES in src/types.ts — keep in sync by hand,
 * same contract as the classic web/index.html.
 */
export const TASK_STATES = ["creating", "running", "done", "needs-input", "stuck", "failed"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export type TurnStatus = "running" | "done" | "failed" | "interrupted";
export type TurnCaptureState = "complete" | "degraded" | "disabled" | "legacy" | "evicted";
export type TurnDiagnosticState = "complete" | "partial" | "evicted" | "disabled" | "unavailable";

export type ActivityStatus = "running" | "completed" | "failed" | "stopped" | "unknown"

interface ActivityEventBase {
  id: string
  parentId: string | null
  timestamp?: string | number | null
}

/** Harness-neutral activity emitted by the daemon's adapter boundary. */
export type ActivityEvent =
  | (ActivityEventBase & { kind: "text"; text: string })
  /** A message steered into the turn, at the point the harness accepted it.
   *  `id` is the message row's id; `text` is a one-line log preview only. */
  | (ActivityEventBase & { kind: "message"; text: string })
  | (ActivityEventBase & { kind: "thinking"; text: string | null })
  | (ActivityEventBase & {
      kind: "tool"
      phase: "started" | "completed"
      name: string
      input?: unknown
      output?: string | null
      error?: string | null
    })
  | (ActivityEventBase & {
      kind: "subagent"
      phase: "started" | "updated" | "completed"
      status: ActivityStatus
      agentId?: string | null
      title?: string | null
      agentType?: string | null
      model?: string | null
      effort?: string | null
      prompt?: string | null
      result?: string | null
      error?: string | null
      durationMs?: number | null
      background?: boolean
    })

/** Task as GET /api/tasks serializes it (archived is a boolean at the boundary). */
export interface CleanupSummary {
  state: "pending" | "running" | "needs-attention" | "complete";
  step: string; error: string | null; retryAt: string | null; revision: number;
  uncertain: boolean; confirmStopped: boolean;
}

/** One tracked process group that outlived its turn — see wispd/src/types.ts. */
export interface BackgroundGroup {
  turn: number
  pgid: number
  processes: number
  since: string | null
  state: "running" | "unknown"
  stopRequested: boolean
  names: string[]
}

export interface ApiTask {
  attachmentsRetained?: boolean;
  deletionPending?: boolean;
  cleanup?: CleanupSummary;
  /** Absent on older daemons; the turn outcome remains in state. */
  background?: {
    state: "none" | "running" | "unknown" | "stopping"
    groups: number
    /** Absent on daemons before background detail; render the bare state then. */
    details?: BackgroundGroup[]
  }
  id: string;
  title: string;
  repo_path: string;
  worktree_path: string | null;
  branch: string | null;
  base_commit: string | null;
  /**
   * Ref the worktree forked from — `origin/main`, the project's configured
   * base, or a per-task override. null for a local task (it adopts the
   * checkout's branch) and for a repo with no remote to name.
   */
  base_ref?: string | null;
  harness: string;
  model: string | null;
  effort: string | null;
  slot: number;
  state: TaskState;
  state_detail: string | null;
  context_n?: number;
  session_id: string | null;
  seq: number;
  turn_count: number;
  archived: boolean;
  mode: TaskMode | null;
  created_at: string;
  updated_at: string;
  /** the model the task's latest turn actually ran on (P5b) — list endpoint only */
  latest_turn_model?: string | null;
  /** the latest turn's exit code (Theme B) — the fact behind the "Exited N" word */
  latest_turn_exit_code?: number | null;
  /** whether the latest turn delivered a result (Theme B) — "Exited N" requires it */
  latest_turn_has_result?: boolean;
}

/**
 * One turn's usage, normalized at the API boundary through the adapter's
 * usageFormat strategy (Theme B). Only the numbers the harness actually
 * reported are present — no invented zeros, no sums, and never money. `null`
 * on the turn means the harness reported nothing, which the UI says rather
 * than renders as blanks.
 */
export interface UsageSummary {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * One stored image on a turn (A1a). No URL and no path: the bytes come from
 * `GET /api/tasks/:id/attachments/:turn/:name`, authenticated like every other
 * read, and the name is the lookup key the daemon checks against that turn's
 * manifest.
 */
export interface TurnAttachment {
  name: string;
  size: number;
  mediaType: string;
}

export interface Turn {
  id: number;
  task_id: string;
  n: number;
  context_n?: number;
  harness?: string;
  requested_model?: string | null;
  requested_effort?: string | null;
  prompt: string;
  result: string | null;
  status: TurnStatus;
  /** the model the turn ACTUALLY ran on; null = the harness never reported one */
  model: string | null;
  /** the harness's own usage numbers, normalized (Theme B); null = none reported */
  usage: UsageSummary | null;
  capture_mode?: "recorder-v1" | null;
  capture_state?: TurnCaptureState;
  captured_bytes?: number;
  omitted_bytes?: number;
  omitted_records?: number;
  capture_categories?: Record<string, { records: number; bytes: number }> | null;
  capture_detail?: string | null;
  diagnostic_state?: TurnDiagnosticState;
  diagnostic_bytes?: number | null;
  diagnostic_first_seq?: number | null;
  diagnostic_last_seq?: number | null;
  diagnostic_detail?: string | null;
  diagnostic_evicted_at?: string | null;
  /**
   * The images this turn carried (A1a). Always present, `[]` for a turn that
   * carried none. It survives archive, which deletes the bytes — so a non-empty
   * list on an archived task means "there was an image here and it is gone",
   * which the conversation has to say rather than render a broken thumbnail.
   */
  attachments: TurnAttachment[];
  log_file: string;
  started_at: string;
  ended_at: string | null;
}

export interface TaskMessage {
  id: string
  task_id: string
  workflow_id?: string | null
  context_n?: number
  harness?: string
  model?: string | null
  effort?: string | null
  text: string
  status: "queued" | "delivered" | "cancelled"
  delivery: "started" | "steered" | null
  turn_n: number | null
  /** Delivery may have succeeded before its acknowledgement or turn record was lost. */
  delivery_uncertain: boolean
  attachments: TurnAttachment[]
  created_at: string
  updated_at: string
}

export type SendDisposition = "started" | "steered" | "queued-next"

export interface SendResponse extends ApiTask {
  disposition: SendDisposition
  message: TaskMessage
}

/**
 * The daemon's one sentence for a worktree it can no longer read: the directory
 * is gone, or git has forgotten it (D1). Carried by all three read routes under
 * this same name, and always present — `null` means the worktree is readable.
 * Render it muted and capped; never assume the daemon sent one line.
 */
export type WorktreeReason = string | null;

export type InstallMethod = "homebrew" | "managed-linux" | "unsupported"
export type UpdateState = "up-to-date" | "available" | "installing" | "restarting" | "failed" | "unavailable"

/** GET /api/update and the accepted POST /api/update response. */
export interface UpdateStatus {
  currentVersion: string
  latestVersion: string | null
  currentApiProtocolVersion: number
  latestApiProtocolVersion: number | null
  state: UpdateState
  installMethod: InstallMethod
  canAutoUpdate: boolean
  message: string | null
  checkedAt: string | null
}

/** GET /api/tasks/:id/conversation — task history with no filesystem or Git work. */
export interface ConversationDetail extends ApiTask {
  turns: Turn[];
  messages?: TaskMessage[];
}

/** GET /api/tasks/:id — the legacy Git-aware detail contract retained for clients and CLI. */
export interface TaskDetail extends ConversationDetail {
  /** null whenever there is nothing to measure, including an unreadable worktree */
  diffstat: string | null;
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

export type PullRequestLifecycle = "draft" | "open" | "merged" | "closed";
export type PullRequestChecks = "none" | "pending" | "passed" | "failed" | "unknown";
export type PullRequestReview = "none" | "required" | "approved" | "changes-requested" | "unknown";
export type PullRequestMergeState =
  | "ready"
  | "unstable"
  | "blocked"
  | "behind"
  | "conflicting"
  | "unknown";

export interface PullRequestInfo {
  number: number;
  url: string;
  title: string;
  lifecycle: PullRequestLifecycle;
  checks: PullRequestChecks;
  review: PullRequestReview;
  mergeState: PullRequestMergeState;
  updatedAt: string;
}

/** GET /api/tasks/:id/pull-request — provider failures never masquerade as "none". */
export type PullRequestStatus =
  | {
      kind: "found"
      provider: "github"
      pullRequest: PullRequestInfo
      /** How many MORE this task has; absent when this is the only one. */
      others?: number
    }
  | { kind: "none"; provider: "github" }
  | { kind: "unsupported"; provider: null }
  | { kind: "unavailable"; provider: "github" | null };

export interface PullRequestOverviewEntry {
  status: PullRequestStatus;
  checkedAt: string;
  stale: boolean;
}

/** GET /api/pull-requests — live tasks only; archived rows are deliberately absent. */
export interface PullRequestOverview {
  tasks: Record<string, PullRequestOverviewEntry>;
}

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

/** GET /api/events frames (one JSON WispEvent per SSE data frame). */
export type WispEvent =
  | {
      type: "task";
      taskId: string;
      state: string;
      stateDetail: string | null;
      seq: number;
      title?: string;
      updatedAt?: string;
    }
  | { type: "turn"; taskId: string; n: number; status: string }
  | { type: "message"; taskId: string; messageId: string }
  | { type: "workflow"; taskId: string }
  | { type: "project"; action: "add" | "remove"; path: string };

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
}

/** A daemon-wide reusable prompt appended to a task or steer submission. */
export interface SuffixPrompt {
  id: string;
  name: string;
  prompt: string;
  createdAt: string;
}

/**
 * Where a task's turns run. `worktree` is an isolated checkout wisp creates and
 * removes; `local` is the repo itself, which archive must never touch. Rows
 * written before the column existed come back as `worktree`.
 */
export type TaskMode = "worktree" | "local";

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
   * command as an ordinary turn. null (or absent, on a stale daemon) means
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
  };
}

/** A3: the only out-of-turn reads any harness has proven to have (SP1). */
export type ProbeCommandName = "context" | "usage";

/** droid's `get_context_breakdown`, normalized (src/adapters/probe.ts). */
export interface ContextBreakdown {
  model: string | null;
  budgetTokens: number | null;
  usedTokens: number | null;
  freeTokens: number | null;
  categories: { name: string; tokens: number | null }[];
  skills: { name: string; tokens: number | null }[];
  mcpServers: { name: string; toolCount: number | null; tokens: number | null }[];
}

/** codex's `account/rateLimits/read` + `account/usage/read`, normalized. */
export interface HarnessUsageReport {
  planType: string | null;
  primary: { usedPercent: number | null; windowMins: number | null; resetsAt: string | null } | null;
  secondary: { usedPercent: number | null; windowMins: number | null; resetsAt: string | null } | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
  lifetimeTokens: number | null;
}

/**
 * POST /api/tasks/:id/probe's report: claude hands back markdown (render
 * as-is); droid and codex hand back structured JSON and Wisp owns the table —
 * and the vocabulary.
 */
export type ProbeReport =
  | { format: "markdown"; text: string }
  | { format: "context"; context: ContextBreakdown }
  | { format: "usage"; usage: HarnessUsageReport };

/** The route's whole answer: what ran, when, and whether the cache served it. */
export interface ProbeAnswer {
  command: ProbeCommandName;
  probedAt: string;
  /** true = the 120s cache answered and no harness process was spawned */
  cached: boolean;
  report: ProbeReport;
}
/**
 * A5: POST /api/tasks/:id/compact's answer — only what the harness honestly
 * reported. removedCount is null when the harness doesn't count (codex);
 * sessionReplaced is droid minting a new session id; note carries the one
 * sentence beyond the numbers (codex recorded it as a turn).
 */
export interface CompactAnswer {
  ok: true;
  removedCount: number | null;
  sessionReplaced: boolean;
  note: string | null;
}

/**
 * A4: one skill as the palette renders it. description is null on a name-only
 * skill (droid's schema allows it — SP2): the row renders without a hint
 * rather than with invented text, and is never dropped for lacking one.
 */
export interface SkillEntry {
  name: string;
  description: string | null;
}

/**
 * GET /api/tasks/:id/skills — the harness's OWN registry for Tier 3, never a
 * hardcoded list. `errors` are malformed-skill reports the harness handed
 * back (codex); `partialNote` marks a knowingly-incomplete list (claude
 * before its first turn: user/project skills only); `invoke` says how a pick
 * becomes prompt text — "/name" (slash) or a plain-text ask (prompt), because
 * codex has no headless slash surface and a pick must not pretend otherwise.
 */
export interface TaskSkills {
  skills: SkillEntry[];
  errors: string[];
  partialNote: string | null;
  invoke: "slash" | "prompt" | null;
  probedAt: string;
  cached: boolean;
}

/** Named frames of GET /api/tasks/:id/log/stream. */
export interface LogStreamFrames {
  backlog: { turn: number; prompt: string; text: string };
  append: { turn: number; text: string };
  "turn-end": { turn: number; status: TurnStatus };
  state: { state: TaskState; state_detail: string | null };
}

/** Named frames when `format=activity`. */
export interface ActivityLogStreamFrames {
  backlog: { turn: number; prompt: string; activity: ActivityEvent[] }
  append: { turn: number; activity: ActivityEvent[] }
  "turn-end": { turn: number; status: TurnStatus }
  state: { state: TaskState; state_detail: string | null }
}

/**
 * GET /api/search — exact text across this daemon's tasks.
 *
 * The daemon searches five places and says which one answered: a task title, a
 * turn's prompt, a turn's concluding result, a queued or steered message, and
 * the agent's own prose from inside a turn (`prose`, projected into an index
 * when the turn ends). Tool calls and reasoning are still outside; the sidebar
 * states that scope rather than implying a whole-transcript index.
 *
 * Archived tasks are searched and flagged, never dropped: the sidebar shows
 * them only when its own Show-archived switch is on, and says how many it is
 * holding back when it is off.
 */
export type SearchSnippetKind = "title" | "prompt" | "result" | "message" | "prose"

export interface SearchSnippet {
  kind: SearchSnippetKind
  /** the turn a prompt/result came from; null for a title or a message */
  turn: number | null
  text: string
  /** the match's position inside `text` — the client highlights what it was given */
  offset: number
  length: number
}

export interface SearchTaskHit {
  id: string
  title: string
  repo_path: string
  updated_at: string
  /**
   * The task's own state and archived flag travel WITH the hit, so a result
   * row renders from the response alone. Resolving hits against the client's
   * task list instead had two holes: an archived task is not in that list at
   * all while Show archived is off, and a task created since the last list
   * fetch would be dropped from results without a word.
   */
  state: TaskState
  archived: boolean
  matches: number
  snippets: SearchSnippet[]
}

export interface SearchResponse {
  query: string
  tasks: SearchTaskHit[]
  /** a daemon scan cap was reached: this answer is not the whole ledger */
  truncated: boolean
  /**
   * Present only while the agent-prose index is catching up on turns that
   * ended before it existed. A miss during that window is not a definitive
   * miss, and the pane says so instead of letting it read as one.
   */
  indexing?: { remainingTurns: number }
}
