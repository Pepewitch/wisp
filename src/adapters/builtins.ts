import type { AdapterDef } from "./types";

export const BUILTIN_ADAPTERS: Record<string, AdapterDef> = {
  // stream-json everywhere: real-time event logs (live `wisp log -f`, honest
  // stuck detection) instead of one buffered blob at turn end.
  droid: {
    bin: "droid",
    auth: {
      check: ["doctor", "--auth", "--json", "--timeout", "3000"],
      fix: "run 'droid' and use /login, or set FACTORY_API_KEY for a headless host",
      success: "json-ok",
    },
    // Full bypass for claude/codex's reason: an isolated worktree and no
    // human at the keyboard mid-turn. `--auto medium` proved too weak in
    // practice (2026-08-27): outward writes the task explicitly asked for
    // (posting a PR review via `gh`) grade as high-risk, droid refuses, and
    // exec aborts the whole turn as "ended early" — a failed task whose
    // work was done. droid 0.205.0 rejects `--auto high` combined with
    // `--skip-permissions-unsafe` ("cannot be used together"), and the bare
    // flag is the superset, so it wins. Override in adapters.json to tighten.
    exec: ["exec", "-o", "stream-json", "--skip-permissions-unsafe"],
    resume: ["-s", "{session}"],
    model: ["-m", "{model}"],
    effort: ["-r", "{effort}"],
    // Rechecked against droid 0.213.0's model-specific help. This is the
    // cross-model union; the valid subset still depends on the selected model.
    // `--help` only says "defaults per model", so the level is left unset by
    // default and droid picks per model — the menu offers, it does not force.
    effortLevels: ["none", "dynamic", "off", "minimal", "low", "medium", "high", "xhigh", "max"],
    // Images reach droid by PATH IN THE PROMPT (A1c). droid exec has no image
    // flag and no stdin envelope, but its Read tool decodes an image file into
    // the model's context — re-probed live on 2026-08-29 with a word that
    // existed only in pixels, and droid read it back from an ABSOLUTE path
    // outside its cwd. So nothing is copied into the worktree. See
    // IMAGE_DELIVERY_STRATEGIES["read-tool-path"] for the caveats this buys
    // (png/jpeg only, and vision is a per-model unknown droid does not expose).
    imageDelivery: "read-tool-path",
    // droid's Factory JSON-RPC mode keeps one agent loop alive and accepts
    // stable-id messages with queuePlacement:"end_of_turn". Session start,
    // completion, actual-model and usage capture were live-reverified on
    // 0.213.0 with gpt-6-astra; steering was last live-probed on 0.205.0.
    liveInput: "droid-jsonrpc",
    // the init event carries model + reasoning_effort (verified against real
    // turn logs, droid 0.202.0 — tests/fixtures/droid-init.jsonl); the
    // completion event carries the usage blob (verified against real turn
    // logs 2026-08-31: input/output/cache_read/cache_creation tokens,
    // factory_credits — the credits stay in the raw blob, never normalized)
    parse: {
      format: "json",
      resultType: "completion",
      result: "finalText",
      session: "session_id",
      model: "model",
      usage: "usage",
    },
    usageFormat: "snake-tokens",
    events: "droid-stream-json",
    activity: "droid-stream-json",
    errors: "droid-stream-json",
    // limit wording from droid 0.202.0 binary strings: "Unrecoverable 402:
    // usage limit reached", "Standard Usage limit reached.", the AI-gateway
    // "Rate limit exceeded" (429), "…monthly compute usage limit…"
    limitMarkers: ["usage limit", "rate limit", "unrecoverable 402", "out of credits", "insufficient credits"],
    // transient wording derived only from the real 2026-08-23 capture in
    // tests/fixtures/droid-transient-provider-error.jsonl. More markers are
    // added only from real captures, never invented shapes.
    transientMarkers: ["floating point nan", "not-a-number"],
    attach: null,
    modelDiscovery: "droid-models",
    // A3 (SP1, live-verified 0.205.0): the JSON-RPC session mode reads
    // context out of band. droid has NO usage read — the palette's Tier 2
    // for a droid task is /context alone, and Wisp's own numbers fill the gap.
    probe: "factory-jsonrpc",
    // A4 (SP2, live-verified 0.205.0): `droid.list_skills` is the ONLY
    // complete surface (20 of 21 skills are builtin:<name>, invisible to any
    // filesystem scan) and hands over the palette's filter itself —
    // userInvocable. This deletes the hardcoded list slice 4 shipped.
    skillDiscovery: "factory-jsonrpc",
    // A5 (SP1, live-verified 0.205.0): `droid.compact_session` returns
    // {newSessionId, removedCount} — the route replaces the stored session
    // id, a field update with no schema change.
    compact: "factory-jsonrpc",
  },
  claude: {
    // bypass is the point: the agent works alone in an isolated worktree and
    // the human steers between turns. Override in adapters.json to tighten.
    bin: "claude",
    auth: { check: ["auth", "status"], fix: "run 'claude auth login'" },
    // Required for the structured activity stream: without it claude emits
    // only the outer Task call/result and Wisp cannot show what the child did.
    // Reverified against claude-code 2.1.258: print/stream-json, verbose,
    // subagent forwarding, permission bypass, resume, model and effort retain
    // the same headless contract.
    exec: [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--forward-subagent-text",
      "--dangerously-skip-permissions",
    ],
    resume: ["--resume", "{session}"],
    model: ["--model", "{model}"],
    // claude-code grew `--effort` after this adapter was written (absent in
    // 2.1.240, documented in 2.1.246). Without it a configured
    // reasoningEffort was rejected at task creation rather than forwarded.
    effort: ["--effort", "{effort}"],
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    // See staticModels on AdapterDef: claude enumerates no models, so this is
    // the documented exception. Full ids only — `--model` also takes the
    // aliases 'opus'/'sonnet'/'fable', but an alias silently re-points at
    // whatever is newest, and wisp policy is an EXPLICIT model per task.
    // Verified against claude-code 2.1.258's baked catalog and a zero-token
    // `/model` read. Fable 5.1 replaced legacy Fable 5 in the current lineup.
    staticModels: ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
    // images arrive via the stdin envelope, not argv (spike ts7efd): on an
    // attaching turn the prompt positional is omitted and prompt + base64
    // blocks ride one NDJSON stdin line
    imageInput: "claude-stream-json",
    liveInput: "claude-stream-json",
    // the init event carries the actual model (verified against real turn
    // logs, claude-code 2.1.240 — tests/fixtures/claude-init.jsonl); the
    // result event does not (its modelUsage is a per-model breakdown object).
    // The result event DOES carry the usage blob (verified against real turn
    // logs 2026-08-31: input/cache_creation/cache_read/output tokens) —
    // total_cost_usd and modelUsage.costUSD stay in the raw blob, never
    // normalized (emit-only: no prices).
    parse: {
      format: "json",
      resultType: "result",
      result: "result",
      session: "session_id",
      needsInput: "permission_denials",
      model: "model",
      usage: "usage",
      // A4 (SP2, live-verified 2.1.251): the init event also carries the
      // session's skill list, names only — captured per session so the
      // palette's Tier 3 is claude's own registry, not a list that rots
      skills: "skills",
    },
    usageFormat: "snake-tokens",
    events: "claude-stream-json",
    activity: "claude-stream-json",
    errors: "claude-stream-json",
    // limit wording from claude-code 2.1.240 binary strings — including its
    // own error classifier (credit balance (?:is )?too low|usage limit
    // reached|…): "usage limit reached", "You've reached your … limit",
    // "rate limited — wait and retry"
    limitMarkers: ["usage limit", "rate limit", "credit balance", "you've reached your"],
    attach: ["--resume", "{session}"],
    // no modelDiscovery (researched on claude-code 2.1.240): the CLI exposes
    // no model list and names no default — `--help` has no models subcommand
    // (running `claude models` starts an interactive session), and the
    // --model help text only gives alias EXAMPLES ('opus', 'sonnet', …).
    // `wisp models` says exactly that rather than scraping example prose.
    // A3 (SP1, live-verified 2.1.251): /context and /usage are local commands
    // that print mode answers with zero model tokens, report as markdown.
    probe: "print-slash",
    // A4 (SP2): init-event names ∪ the ~/.claude/skills + .claude/skills
    // frontmatter scan (the only place descriptions live). Before the first
    // turn the list is honestly partial — user/project skills only.
    skillDiscovery: "claude-init",
    // A5 (SP1, documented + binary-verified 2.1.251): /compact is a local
    // command print mode executes — an ordinary headless turn, recorded like
    // any other. No out-of-band machinery needed, so no `compact` strategy.
    // Deliberately NOT --autocompact: that knob is the user's session policy,
    // and an adapter that silently pins it owns a surprise.
    compactPrompt: "/compact",
  },
  codex: {
    // Reverified against codex-cli 0.153.4. `codex exec` is one headless turn;
    // resume is a SUBCOMMAND, not a flag (`codex exec resume <id> "<prompt>"`),
    // and codex applies the parent `exec` options to it — so appending
    // ["resume", "{session}"] still yields a valid argv:
    //   codex exec --json --dangerously-… resume <id> -m <model> "<prompt>"
    // (both orderings were run live; this one keeps the flags with `exec`.)
    bin: "codex",
    auth: { check: ["login", "status"], fix: "run 'codex login'" },
    // Bypass for claude's reason: an isolated worktree and no human at the
    // keyboard mid-turn. It is also the only autonomy flag `exec resume`
    // accepts — -s/--sandbox and -a/--ask-for-approval are exec-only, so a
    // per-turn-consistent policy has to be this one.
    exec: ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox"],
    resume: ["resume", "{session}"],
    model: ["-m", "{model}"],
    effort: ["-c", "model_reasoning_effort={effort}"],
    // codex 0.153.4 — generated app-server schemas accept a non-empty effort
    // string and the current catalog includes xhigh/max models. `ultra` was
    // added on the evidence of `codex debug models` itself: gpt-6-astra lists
    // it in supported_reasoning_levels, so the picker was hiding a level codex
    // accepts. Found by `bun run harness:snapshot`; none/minimal stay because
    // the schema takes any non-empty string — the menu offers, it does not force.
    effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
    // spike-verified live (codex-cli 0.149.0): multi-file is one -i with all
    // paths, and the trailing "--" is MANDATORY — without it the variadic -i
    // eats the prompt positional and codex exits 1 ("No prompt provided")
    image: ["-i", "{path}", "--"],
    // app-server's turn/steer has an active-turn precondition and stable
    // client message IDs. Start/completion and usage were live-reverified on
    // 0.153.4 with gpt-6-astra; steering's schema is current and its last live
    // probe on 0.149.0 completed the same turn once.
    liveInput: "codex-app-server",
    // codex splits session id and result text across events and nests the text
    // one level deep, so the flat field mapping cannot express it.
    // The -c effort override is a parent exec option, so it also applies when
    // the resume subcommand follows (the same placement rule as model).
    // The strategy also captures turn.completed's usage blob (verified against
    // the captured fixture tests/fixtures/codex-first-turn.jsonl).
    parse: { format: "json", strategy: "codex-jsonl" },
    usageFormat: "codex-usage",
    events: "codex-jsonl",
    activity: "codex-jsonl",
    errors: "codex-jsonl",
    // limit wording from codex-cli 0.149.0 binary strings: "Usage limit
    // reached" / "You've reached your usage limit", "Your workspace is out of
    // credits", "You hit your spend cap…", the rate_limit_reached error kind,
    // and the API error classes "quota exceeded" / "usage not included"
    limitMarkers: [
      "usage limit",
      "rate limit",
      "rate_limit",
      "out of credits",
      "spend cap",
      "quota exceeded",
      "usage not included",
    ],
    attach: ["resume", "{session}"], // `codex resume <id>` = interactive, same session
    modelDiscovery: "codex-models",
    // A3 (SP1, live-verified 0.149.0): the app-server reads account usage out
    // of band. There is NO per-thread context read (token usage is a
    // notification, never an answer), so /context is honestly absent here.
    probe: "codex-app-server",
    // A4 (SP2, live-verified 0.149.0): `skills/list` — the plan's "expect
    // nothing" was refuted (38 skills, real descriptions, malformed-skill
    // errors reported back). But codex has NO headless /name invocation, so
    // the strategy's invoke is "prompt": a pick writes a plain-text ask.
    skillDiscovery: "codex-app-server",
    // A5 (SP1, live-verified 0.149.0): thread/compact/start ACKs, then a
    // real turn runs a contextCompaction item — the strategy waits for
    // turn/completed and the entry says "runs a turn", because it does.
    compact: "codex-app-server",
  },
  // Slice 9 (owner request, 2026-08-31). The headless surface is
  // binary-verified against cursor-agent 2026.08.11's bundled source
  // (stream-json event shapes: system/init, assistant message.content,
  // tool_call keyed by tool variant, result{result, session_id, usage}) and
  // live-verified end to end 2026-08-31 (turn, resume, usage, failure tail;
  // images 2026-08-31 on 2026.08.25 — see imageDelivery). One shape reading
  // had to be corrected by capture: `result`'s TEXT is not claude's "final
  // message" semantics but the whole turn's assistant prose concatenated
  // (found on 2026.08.31 output, see parse.ts) — hence the parse strategy
  // below. Still absent rather than guessed: an errors strategy + limit
  // markers (the stderr-tail fallback is live-proven sufficient) and the
  // skills/probe/compact surfaces (none observed).
  cursor: {
    bin: "cursor-agent",
    auth: { check: ["status", "--format", "json"], fix: "run 'cursor-agent login'" },
    // `-f` is cursor's bypass (alias --yolo), for claude/codex's reason: an
    // isolated worktree and no human at the keyboard mid-turn. --trust keeps
    // the workspace-trust prompt from stalling a headless run.
    exec: ["-p", "--output-format", "stream-json", "-f", "--trust"],
    resume: ["--resume", "{session}"],
    model: ["--model", "{model}"],
    // No effort template: cursor's effort is a bracket override ON the model
    // id ('claude-opus-4-8[effort=high]'), not a flag — a parameterized
    // model, not an effort level, so the picker offers none.
    //
    // Owner-pinned list (2026-08-31), ids read off `agent models` live after
    // auth: "Cursor Grok 4.6" IS the id cursor-grok-4.6-high (there is NO
    // bare grok-4.6 — guessing it would have failed pre-flight, which is why
    // the list is only ever read off the CLI). Deliberately static rather
    // than a `agent models` discovery strategy: the owner pinned this exact
    // list and default, and a probed default ("auto") would outrank it.
    staticModels: ["cursor-grok-4.6-high", "composer-2.5"],
    defaultModel: "cursor-grok-4.6-high", // owner-pinned default ("Grok 4.6")
    // A strategy, not a field mapping: cursor's result event carries the
    // WHOLE turn's assistant texts concatenated, not the final message
    // (byte-verified on 2026.08.31 against 2026.08.31-4057e58; fixture
    // tests/fixtures/cursor-accumulated-result.jsonl), so the conclusion is
    // derived from the assistant events and the result line is read only as
    // the settlement signal + session/usage carrier. Model stays on the init
    // event (its displayName — the result event has no model field).
    parse: { format: "json", strategy: "cursor-stream-json" },
    usageFormat: "snake-tokens",
    events: "cursor-stream-json",
    activity: "cursor-stream-json",
    // Images by PATH IN THE PROMPT (the read-tool-path strategy, shared with
    // droid): cursor has no image flag and no stdin envelope, but its
    // readToolCall decodes images — live-verified 2026-08-31 on
    // cursor-agent 2026.08.25 with Grok 4.6, which recited an unbluffable
    // seeded 4×3 color grid + border from a PNG handed over by path.
    imageDelivery: "read-tool-path",
    // No errors strategy yet: cursor's failure stream shape is UNVERIFIED
    // (binary reading shows is_error only ever false, i.e. a failed run
    // writes no result line) — the generic stderr-tail fallback carries it
    // until a real failure is captured. limitMarkers/transientMarkers stay
    // unset for the same reason: markers come from real captures, never
    // invented shapes.
    attach: ["--resume", "{session}"], // interactive resume, same session
    // No probe/skillDiscovery/compact strategy: none of those surfaces is
    // verified on cursor. The palette's tiers are honestly absent, and the
    // routes answer their named refusals (that honesty IS the contract).
  },
};
