import type { SpawnResult } from "../doctor";

/**
 * A harness adapter is declarative config (D7): how to run one headless turn,
 * how to resume a session, and how to read the machine output. No harness
 * knowledge lives outside these definitions.
 */
export interface AdapterDef {
  bin: string;
  /**
   * Optional, non-billing authentication diagnostic used by `wisp doctor`.
   * Commands are argv after `bin`; `fix` is printed as the next action when
   * the check fails. null in adapters.json clears an inherited builtin probe.
   */
  auth?: {
    check: string[];
    fix: string;
    success?: "exit-zero" | "json-ok";
  } | null;
  /** argv after bin for a one-shot turn; prompt is appended as the final positional arg */
  exec: string[];
  /** appended when a session id exists; "{session}" is substituted */
  resume?: string[];
  /** appended when a model is set; "{model}" is substituted */
  model?: string[];
  /** appended when a reasoning effort is set; "{effort}" is substituted (P5b) */
  effort?: string[];
  /**
   * The values `effort` actually accepts, so the web picker can OFFER them
   * instead of asking someone to guess a level into a text box.
   *
   * Every list here was read off the CLI itself, never invented — that was the
   * original reason effort discovery stayed parked, and it still binds:
   *
   *  - droid 0.202.0  — `-r bogus` prints "Allowed values: none, dynamic, off,
   *    minimal, low, medium, high, xhigh, max" and exits before any API call.
   *  - claude 2.1.246 — `--help` documents `--effort <level>` as
   *    "(low, medium, high, xhigh, max)".
   *  - codex 0.149.0  — an invalid model_reasoning_effort is rejected by the
   *    API with "Supported values are: 'none', 'minimal', 'low', 'medium',
   *    'high', 'xhigh', and 'max'".
   *
   * The lists genuinely differ (droid alone has `dynamic`/`off`; claude alone
   * lacks `none`/`minimal`), which is exactly why one shared ladder would be
   * wrong. Re-verify on a CLI upgrade; a stale list here is a bad menu, not a
   * broken turn — the daemon still forwards whatever is chosen.
   */
  effortLevels?: string[];
  /**
   * A curated model list for a harness whose CLI enumerates none.
   *
   * THE ONE DOCUMENTED EXCEPTION to "never hardcode a model id". It exists for
   * claude and should not grow: claude-code has no `models` subcommand, and
   * `--model` accepts ANY string without validating it (verified on 2.1.246 —
   * an invented id is echoed straight back in the init event and only fails
   * later at the API), so there is nothing to probe and nothing to scrape.
   * `modelDiscovery` stays the rule; this is the fallback when the CLI offers
   * no way to ask. A real probe ALWAYS wins over this list.
   */
  staticModels?: string[];
  /**
   * The default model for a STATIC list (slice 9, cursor: Grok 4.6). Only
   * meaningful with staticModels — a probed list's own defaultModel always
   * wins, and config harnessDefaults wins over both (defaultModelFor's
   * order). Omit when the harness should pick: asserting a default is a
   * product statement, and wisp only makes it where the owner named one.
   * validateAdapter requires the value to be IN staticModels.
   */
  defaultModel?: string;
  /**
   * Image-attachment capability, argv form (S3, spike ts7efd): an argv
   * template whose "{path}" element expands to the turn's stored attachment
   * paths, inserted immediately before the prompt positional (after
   * resume/model/effort). Builtin codex: ["-i", "{path}", "--"] — the
   * trailing "--" is MANDATORY (the variadic -i would eat the prompt).
   * Mutually exclusive with imageInput. null clears a builtin's field.
   */
  image?: string[] | null;
  /**
   * Image-attachment capability, stdin form (S3, spike ts7efd): a named
   * stdin-envelope strategy (keys into IMAGE_INPUT_STRATEGIES) for a harness
   * whose image input REPLACES the prompt channel — on an attaching turn the
   * prompt positional is omitted and the prompt rides one NDJSON stdin line
   * with the base64 image blocks. Builtin claude: "claude-stream-json".
   * Mutually exclusive with image. null clears a builtin's field.
   */
  imageInput?: string | null;
  /**
   * Image-attachment capability, prompt-path form (A1c): a named delivery
   * strategy (keys into IMAGE_DELIVERY_STRATEGIES) for a harness that has no
   * image channel but whose file-reading tool decodes images. argv and stdin
   * are untouched; the strategy's sentence names the stored paths in the
   * prompt and the harness reads them itself. Builtin droid: "read-tool-path".
   * Mutually exclusive with image and imageInput. null clears a builtin's
   * field.
   */
  imageDelivery?: string | null;
  /** A verified long-lived input protocol. Omitted means durable next-turn fallback. */
  liveInput?: "claude-stream-json" | "droid-jsonrpc" | "codex-app-server" | null;
  /**
   * For json adapters, exit 0 with no parsed result payload is a FAILURE
   * (spawn contract: done needs a positive signal — orca's bug was trusting
   * bare exit 0). Set true only for a harness that legitimately exits 0
   * without emitting a result object.
   */
  allowEmptyResult?: boolean;
  parse: {
    format: "json" | "text";
    /** for stream-json harnesses: only lines with this "type" value are result objects */
    resultType?: string;
    /** JSON field holding the turn's result text */
    result?: string;
    /** JSON field holding the session id */
    session?: string;
    /**
     * JSON field holding the model the turn ACTUALLY ran on (P5b), read from
     * the result event or an early stream event (claude/droid carry it on
     * their init line). Omitted = the harness never reports it; surfaces then
     * show the requested model marked "(requested)".
     */
    model?: string;
    /** JSON field (array) that, when non-empty, means the turn needs human input */
    needsInput?: string;
    /**
     * JSON field holding the turn's usage blob (Theme B), read off the SAME
     * result line the result text comes from (claude's result event and
     * droid's completion event both carry `usage` there — verified against
     * real turn logs 2026-08-31). A strategy parses usage itself; this field
     * is for the flat mapping only, so it joins the strategy-conflict list.
     */
    usage?: string;
    /**
     * JSON field (an array of strings) on an early init/start event listing
     * the session's registered skills (A4; claude's init event carries
     * `skills`, verified live by SP2). Read from the head of the stream like
     * the model is: an interrupted turn still announces its skills.
     */
    skills?: string;
    /**
     * Named parse strategy (keys into PARSE_STRATEGIES) for a harness whose
     * machine output doesn't fit the flat field mapping above — it owns the
     * whole parse, so it is mutually exclusive with resultType/result/session/
     * needsInput and requires format "json".
     */
    strategy?: string;
  };
  /**
   * Named event-formatter strategy for rendering this harness's stream log
   * lines as a human activity feed (`wisp log`); keys into EVENT_FORMATTERS.
   * Omitted = no per-event rendering; log lines pass through raw.
   */
  events?: string;
  /**
   * Named structured-activity strategy for the web conversation; keys into
   * ACTIVITY_NORMALIZERS. The strategy is the only layer allowed to know a
   * harness's wire shape. It preserves stable call/agent ids and lifecycle
   * relationships that the intentionally lossy `events` text formatter cannot.
   *
   * Omitted = activity falls back to the human formatter as unstructured
   * text. `null` explicitly clears an inherited builtin strategy. A harness
   * that supports subagents should always declare this.
   */
  activity?: string | null;
  /**
   * Named error-detail strategy (keys into ERROR_STRATEGIES): how to extract
   * the human-meaningful cause of a FAILED turn — its last error-bearing
   * event — so a nonzero exit names the actual cause (unknown model, expired
   * auth, usage limit) instead of only "turn exited 1". Needed because stderr
   * can't be trusted: codex reports turn failures on stdout, and droid buries
   * the cause under pages of help text. Omitted = the runner falls back to
   * the stderr tail.
   */
  errors?: string;
  /**
   * Substrings (matched case-insensitively against the extracted failure
   * detail) that mean the failure is usage/rate-limit exhaustion — wisp then
   * prefixes state_detail with "limit: " so consumers (openclaw) can react to
   * quota exhaustion distinctly from other failures. Declared per adapter
   * because every harness words its limit errors differently.
   */
  limitMarkers?: string[];
  /**
   * Substrings (matched case-insensitively against the extracted failure
   * detail) that mean the failure is a TRANSIENT provider/stream fault — wisp
   * then prefixes state_detail with "transient: " so consumers can treat
   * bounded auto-retry as safe. Declared per adapter because every
   * harness/provider words these differently.
   */
  transientMarkers?: string[];
  /** argv after bin for interactively attaching to the session; null = not known yet */
  attach?: string[] | null;
  /**
   * Named model-discovery strategy (keys into MODEL_DISCOVERY): how `wisp
   * models` asks the INSTALLED CLI for the harness's own default model and
   * the list of models it supports (P5c). Omitted = the CLI exposes neither,
   * and `wisp models` says so honestly instead of showing a hardcoded list
   * that would rot. null clears a builtin's strategy.
   */
  modelDiscovery?: string | null;
  /**
   * Named usage formatter (keys into USAGE_FORMATTERS, Theme B): how this
   * harness's raw usage blob normalizes into a UsageSummary at the API
   * boundary. Omitted = the harness reports no usage wisp can read, and the
   * API serves `usage: null` rather than guessing at a shape.
   */
  usageFormat?: string;
  /**
   * Named out-of-turn probe strategy (keys into PROBE_STRATEGIES, v0.3 A3):
   * how the daemon asks this harness for a READ (`/context`, the harness's
   * own `/usage`) against the stored session, out of band — no turn row, no
   * transition, no outbox event. The strategy declares which commands it can
   * answer; omitted = the harness exposes no out-of-turn reads, and the
   * palette's Tier 2 simply has no group for it.
   */
  probe?: string;
  /**
   * Named skill-discovery strategy (keys into SKILL_STRATEGIES, v0.3 A4,
   * settled by SP2): how the daemon enumerates the skills this harness has
   * registered, so the palette's Tier 3 is the harness's own list instead of
   * a hardcoded one that rots. SP2 settled that it is NOT "filesystem"
   * singular — builtins are not files on claude (0 of 17 on disk) or droid
   * (1 of 21) — so each harness uses its native call, with the frontmatter
   * scan as the honest partial fallback. null clears a builtin's strategy.
   */
  skillDiscovery?: string | null;
  /**
   * Named out-of-turn compaction strategy (keys into COMPACT_STRATEGIES,
   * v0.3 A5, settled by SP1): how the daemon shrinks this harness's stored
   * session WITHOUT a turn row. droid hands back a new session id, codex
   * records the compaction as a turn in its own thread. null clears a
   * builtin's strategy. Mutually exclusive with compactPrompt — validate
   * rejects an adapter that sets both.
   */
  compact?: string | null;
  /**
   * The harness's own compact command, sent as an ORDINARY turn prompt
   * (v0.3 A5): claude's `/compact` runs headless under print mode (the
   * v0.2-observed path), so Wisp needs no out-of-band machinery — the
   * palette prefills it and the turn is recorded like any other. The value
   * is the prompt itself ("/compact"), so the UI never hardcodes it.
   */
  compactPrompt?: string;
}

/**
 * Named event formatters (ROADMAP guardrail 3: adapters are config plus small
 * named strategies). Each turns one parsed stream-json event into a human
 * activity line, or null to drop it as noise. All harness wire-shape knowledge
 * lives HERE — the CLI and web page render via the adapter (a prior audit), so
 * a third harness only adds a strategy in this file (or reuses one by name in
 * ~/.wisp/adapters.json).
 */
export type EventFormatter = (e: Record<string, any>) => string | null;

export type ActivityStatus = "running" | "completed" | "failed" | "stopped" | "unknown";

interface ActivityEventBase {
  /** Stable within one turn. Harness ids win; deterministic generated ids fill gaps. */
  id: string;
  /**
   * The containing subagent's call/agent id. null means the parent turn.
   * Consumers resolve either a subagent `id` or its later-discovered `agentId`.
   */
  parentId: string | null;
  /** Harness timestamp, retained for duration/order without inventing a clock. */
  timestamp?: string | number | null;
}

export type ActivityEvent =
  | (ActivityEventBase & {
      kind: "text";
      text: string;
    })
  | (ActivityEventBase & {
      /**
       * A message Wisp steered into this turn, at the point in the transcript
       * where the harness accepted it. `id` is the message row's id, which
       * makes it idempotent across replays; `text` is only a one-line preview
       * — the row owns the full text and the delivery wording.
       */
      kind: "message";
      text: string;
    })
  | (ActivityEventBase & {
      kind: "thinking";
      /** null means the harness exposed a reasoning heartbeat but encrypted/omitted its text. */
      text: string | null;
    })
  | (ActivityEventBase & {
      kind: "tool";
      phase: "started" | "completed";
      name: string;
      input?: unknown;
      output?: string | null;
      error?: string | null;
    })
  | (ActivityEventBase & {
      kind: "subagent";
      phase: "started" | "updated" | "completed";
      status: ActivityStatus;
      /** Harness call id and child identity are deliberately separate. */
      agentId?: string | null;
      title?: string | null;
      agentType?: string | null;
      model?: string | null;
      effort?: string | null;
      prompt?: string | null;
      result?: string | null;
      error?: string | null;
      durationMs?: number | null;
      background?: boolean;
    });

export interface ParsedTurn {
  result: string | null;
  session: string | null;
  needsInput: boolean;
  /** The harness emitted its positive terminal payload, but marked that payload as a failure. */
  isError: boolean;
  /** the model the turn actually ran on, when the harness reports it (P5b); null = fall back to the requested model */
  model: string | null;
  /**
   * The harness's own usage report for the turn (Theme B) — the RAW blob from
   * its terminal event, exactly as emitted, or null when the stream carried
   * none (an interrupted turn, a text-format harness). Wisp persists it
   * verbatim (`usage_json`) and normalizes at the API boundary via the
   * adapter's `usageFormat`; token counts are facts and no shape is invented.
   */
  usage: unknown | null;
  /**
   * The skill names the session announced on its init event (A4 — claude's
   * init carries `skills`, names only; SP2). null = the stream carried no
   * such list (non-claude harnesses, a dead-before-init turn); a harness that
   * HAS no skills announces [] and is recorded as such. Persisted on the task
   * row; the palette unions these with the on-disk user/project skills, which
   * are the only tier whose descriptions live anywhere cheap.
   */
  skills: string[] | null;
}

/**
 * A turn's usage, normalized (Theme B). Every field is optional: a harness
 * reports what it reports, and a normalizer copies values — it never computes,
 * sums, or invents one. Money is deliberately absent (emit-only: token counts
 * are facts; prices are a product statement that rots — claude's
 * `total_cost_usd` and droid's `factory_credits` stay in the raw blob only).
 */
export interface UsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  /** prompt tokens served from the provider's cache (claude/droid cache_read, codex cached_input) */
  cachedInputTokens?: number;
  /** prompt tokens WRITTEN to the provider's cache (claude/droid cache_creation, codex cache_write) */
  cacheWriteTokens?: number;
  /** codex splits reasoning from visible output; kept distinct rather than silently summed */
  reasoningTokens?: number;
}

export type ParseStrategy = (raw: string) => ParsedTurn;

/**
 * The out-of-turn reads (v0.3 A3, SP1): a harness command that returns a
 * REPORT without driving a model turn. Two exist anywhere today: `context`
 * (what fills the session's window) and the harness's own `usage` (what the
 * account has spent). Availability is uneven per harness — claude has both,
 * droid has context only, codex has usage only — and the strategy declares
 * which it can answer, so a surface never fakes the other one.
 */
export type ProbeCommand = "context" | "usage";

/**
 * What a probe returns. Two render shapes (SP1): claude writes its own report
 * as markdown and Wisp renders it as-is; droid and codex return structured
 * JSON, which is better — Wisp normalizes it at the boundary and owns the
 * vocabulary of the tables, exactly like `usageFormat` for turn usage.
 */
export type ProbeReport =
  | { format: "markdown"; text: string }
  | { format: "context"; context: ContextBreakdown }
  | { format: "usage"; usage: HarnessUsageReport };

/**
 * droid's `droid.get_context_breakdown`, normalized. Every number is copied,
 * never computed — a field the harness stopped sending is absent, not zero.
 * The TUI's own panel vocabulary is kept (System prompt, System tools, …).
 */
export interface ContextBreakdown {
  /** the model the breakdown belongs to, as the harness names it */
  model: string | null;
  budgetTokens: number | null;
  usedTokens: number | null;
  freeTokens: number | null;
  categories: { name: string; tokens: number }[];
  skills: { name: string; tokens: number }[];
  mcpServers: { name: string; toolCount: number | null; tokens: number }[];
}

/**
 * codex's `account/rateLimits/read` + `account/usage/read`, normalized. These
 * are ACCOUNT-level numbers (codex has no per-thread context read — SP1), so
 * the panel must say "account", not imply the task.
 */
export interface HarnessUsageReport {
  planType: string | null;
  /** the short rate-limit window (codex: 5h), when the harness reports one */
  primary: { usedPercent: number; windowMins: number | null; resetsAt: string | null } | null;
  /** the long rate-limit window (codex: weekly) */
  secondary: { usedPercent: number; windowMins: number | null; resetsAt: string | null } | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: number | null } | null;
  lifetimeTokens: number | null;
}

/** What a probe needs from the task row: which read, which session, which cwd. */
export interface ProbeCtx {
  command: ProbeCommand;
  /** the task's stored harness session; null before the first turn */
  sessionId: string | null;
  /** the task's worktree (or repo, when there is no worktree) */
  cwd: string | null;
  /** aborted by the caller's timeout — strategies wire it to the child's kill */
  signal?: AbortSignal;
}

/** One short-lived JSON-RPC peer over a child's stdin/stdout (droid, codex). */
export interface RpcSession {
  /** one request/response round-trip; an error response rejects */
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  /**
   * Await ONE notification, resolving with its params; unmatched
   * notifications are skipped as before. Optional because only codex's
   * compaction needs it (thread/compact/start ACKs with `{}` — the honest
   * "it finished" is the turn/completed notification, SP1); a strategy that
   * requires it degrades to reporting the ack rather than inventing
   * completion. Rejects when the channel closes first.
   */
  onNotification?(method: string, match?: (params: unknown) => boolean): Promise<unknown>;
  /** the probe is done with the peer — a read never closes a harness session politely, it just kills */
  close(): void;
}

/**
 * Opens a line-delimited JSON-RPC peer. `envelope` names the framing quirk:
 * "plain" is standard `{"id":n,"method":…}` (codex app-server); "factory" adds
 * droid's `type:"request"` + `factoryProtocolVersion` fields, without which
 * droid rejects the line outright (SP1: bare JSON-RPC gets -32700).
 */
export type RpcFactory = (
  cmd: string[],
  opts: { cwd?: string; envelope: "plain" | "factory"; signal?: AbortSignal },
) => RpcSession;

/** What a compaction needs: which session, which cwd, the caller's timeout. */
export interface CompactCtx {
  /** the task's stored harness session; a compaction without one is a 409 */
  sessionId: string | null;
  /** the task's worktree (or repo, when there is no worktree) */
  cwd: string | null;
  /** aborted by the caller's timeout — strategies wire it to the child's kill */
  signal?: AbortSignal;
}

/** The honest facts a compaction can report — nulls where the harness doesn't count. */
export interface CompactResult {
  /** messages the harness dropped (droid counts them; codex doesn't say) */
  removedCount: number | null;
  /** droid compaction MINTS a new session id — the route replaces the task's stored one */
  newSessionId: string | null;
  /** one honest sentence beyond the numbers (codex: recorded as a turn in its own thread) */
  note: string | null;
}

/**
 * A named compaction strategy (ROADMAP guardrail 3, same shape as
 * PROBE_STRATEGIES). All harness compaction knowledge lives in compact.ts.
 */
export interface CompactStrategy {
  /**
   * Does the harness record this compaction as a turn in its own history?
   * (codex: yes — turn/started…turn/completed bracket a contextCompaction
   * item, SP1; droid: no.) The harnesses route hands it to the palette so
   * the entry can SAY "runs a turn" where that is the truth.
   */
  recordsTurn: boolean;
  run(def: AdapterDef, ctx: CompactCtx, io: ProbeIo): Promise<CompactResult>;
}

/** One-shot process runner with a cwd (the print-slash probe resumes in the task's worktree). */
export type ProbeSpawnFn = (
  cmd: string[],
  opts: { cwd?: string; signal?: AbortSignal },
) => SpawnResult | Promise<SpawnResult>;

/** Everything a probe strategy needs from the outside — injected, so tests never spawn a real CLI. */
export interface ProbeIo {
  spawnOnce: ProbeSpawnFn;
  openRpc: RpcFactory;
}

/**
 * A named probe strategy (ROADMAP guardrail 3, same shape as PARSE_STRATEGIES
 * / MODEL_DISCOVERY / USAGE_FORMATTERS): the wire protocol for one harness
 * family's out-of-turn reads, plus the commands that protocol can honestly
 * answer. All harness probe knowledge lives in probe.ts.
 */
export interface ProbeStrategy {
  /** the reads this strategy can run — the palette's Tier 2 for the harness */
  commands: ProbeCommand[];
  run(def: AdapterDef, ctx: ProbeCtx, io: ProbeIo): Promise<ProbeReport>;
}

/**
 * A named image-input strategy (ROADMAP guardrail 3, same shape as
 * PARSE_STRATEGIES / EVENT_FORMATTERS): how a harness whose image channel
 * REPLACES the prompt channel (no argv flag exists) receives an attaching
 * turn. `argv` is appended at the image slot (immediately before the omitted
 * prompt positional); `envelope` builds the ONE line written to the child's
 * stdin — image blocks first, one text block carrying the prompt last.
 */
export interface ImageInputStrategy {
  argv: string[];
  envelope: (prompt: string, files: { mediaType: string; dataBase64: string }[]) => string;
}

/**
 * A named image-DELIVERY strategy (A1c, spike ts7efd re-probed 2026-08-29):
 * how a harness with no image channel at all — but with a file-reading tool
 * that decodes images — receives an attaching turn. Nothing goes on argv and
 * nothing goes on stdin; the turn's stored paths are NAMED IN THE PROMPT and
 * the harness's own tool opens them.
 *
 * That makes the preamble load-bearing rather than cosmetic: an unread file is
 * a turn that succeeds with a wrong answer, so the sentence lives here, in the
 * adapter, and never depends on the user thinking to type it.
 */
export interface ImageDeliveryStrategy {
  /**
   * The media types the harness's own reader accepts, as sniffed strings
   * (`"image/png"`, …). Narrower than wisp's upload set on purpose: a format
   * the reader will refuse must be refused at the boundary with a named
   * reason, not handed over to fail inside the turn.
   */
  accepts: readonly string[];
  /** The sentence prepended to the turn's message, naming the absolute paths. */
  preamble: (paths: string[]) => string;
  /**
   * One sentence for the composer, shown while an image is pending: delivery
   * by path has a caveat argv delivery does not, and the copy belongs with the
   * mechanism.
   */
  note: string;
}

/**
 * Named error-detail strategies (ROADMAP guardrail 3, same shape as
 * PARSE_STRATEGIES and EVENT_FORMATTERS): how to pull the human-meaningful
 * cause out of a FAILED turn's captured output. Each returns the LAST
 * error-bearing event's message, or null when the output carries none — the
 * runner's stderr-tail fallback covers those cases. All harness failure-wire
 * knowledge lives HERE; runner.ts only knows exit codes.
 */
export type ErrorStrategy = (out: string, err: string) => string | null;

/**
 * What `wisp models` could learn from the installed CLI itself (P5c). Both
 * fields are null when the harness exposes nothing — the report then says so
 * honestly rather than falling back to a hardcoded list that would rot. No
 * model id appears anywhere in wisp source: every id printed comes from the
 * live CLI or the user's own config.
 */
export interface ModelDiscovery {
  /** the harness's own default model id; null when the CLI doesn't reveal one */
  defaultModel: string | null;
  /** the models the installed CLI advertises; null when it exposes no list */
  models: string[] | null;
  /** provenance/caveats worth showing the user (where the info came from, why it's partial) */
  notes: string[];
}

/**
 * Named model-discovery strategies (ROADMAP guardrail 3, same shape as
 * PARSE_STRATEGIES / EVENT_FORMATTERS / ERROR_STRATEGIES). Each answers "what
 * models can this harness run, and which does it pick by default?" from the
 * INSTALLED CLI, via the injected spawn (the doctor.ts pattern — tests never
 * spawn a real harness). All harness model-surface knowledge lives HERE.
 *
 * Strategies are async over ModelProbeSpawnFn so the daemon's probes never
 * block the event loop; the CLI's synchronous SpawnFn satisfies the same
 * type (a sync return is a resolved promise), so ONE implementation serves
 * both `wisp models` and the daemon's model cache.
 */
export type ModelDiscoveryFn = (
  def: AdapterDef,
  spawn: ModelProbeSpawnFn,
  signal?: AbortSignal,
) => Promise<ModelDiscovery>;

/**
 * Process injection for model discovery: sync (doctor's bunSpawn, tests) or
 * async (the daemon's Bun.spawn runner) — both are awaited at the call site.
 */
export type ModelProbeSpawnFn = (
  cmd: string[],
  signal?: AbortSignal,
) => SpawnResult | Promise<SpawnResult>;

/**
 * One skill as the palette renders it (A4). `description` is nullable because
 * droid legitimately ships name-only skills (its schema marks description
 * optional — SP2): the row renders without a hint rather than with invented
 * text, and never gets dropped for lacking one.
 */
export interface SkillEntry {
  name: string;
  description: string | null;
}

/**
 * What discovery found (A4, SP2). `errors` are the malformed-skill reports a
 * harness handed back (codex's skills/list `errors[]`) — surfaced verbatim,
 * never swallowed, because a silently-skipped skill is the absence this
 * product refuses. `partialNote` is set when the list is knowingly
 * INCOMPLETE (claude before its first turn: the init event that names the
 * builtins hasn't been captured yet, so only user/project skills are listed)
 * — a partial list that presents itself as complete would be the quiet lie.
 */
export interface SkillDiscoveryResult {
  skills: SkillEntry[];
  errors: string[];
  partialNote: string | null;
  /**
   * How a palette pick becomes prompt text: "slash" prefills `/name`
   * (claude/droid run skills headless by slash — SP2 verified), "prompt"
   * writes a plain-text ask (codex has no headless slash surface at all, and
   * a pick must not pretend otherwise — it still costs a turn).
   */
  invoke: "slash" | "prompt";
}

/** What skill discovery needs from the task row — the same trio a probe needs, plus claude's init-captured names. */
export interface SkillCtx {
  /** the task's stored harness session; null before the first turn */
  sessionId: string | null;
  /** the task's worktree (or repo, when there is no worktree) — project skills live under it */
  cwd: string | null;
  /** the skill names captured from the session's init event (claude); null before the first turn */
  initSkills: string[] | null;
  /** aborted by the caller's timeout — strategies wire it to the child's kill */
  signal?: AbortSignal;
}

/**
 * A named skill-discovery strategy (ROADMAP guardrail 3, same shape as
 * PROBE_STRATEGIES): how one harness family enumerates its registered skills.
 * All harness skill-registry knowledge lives in skills.ts.
 */
export interface SkillStrategy {
  /** how a pick becomes prompt text on this harness — see SkillDiscoveryResult.invoke */
  invoke: "slash" | "prompt";
  discover(def: AdapterDef, ctx: SkillCtx, io: ProbeIo): Promise<Omit<SkillDiscoveryResult, "invoke">>;
}
