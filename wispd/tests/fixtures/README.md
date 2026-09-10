# Captured harness output

Sanitized, shape-preserving fixtures derived from live output from installed
harness CLIs. They test adapter parsing against observed wire formats without
retaining machine paths, real session identifiers, or unrelated environment
inventories. Re-capture, sanitize, and update the version below when a
harness's machine output changes.

## Subagent lifecycle captures — 2026-09-01

Each command delegated one read of `package.json` and returned its `name`
field. The fixtures retain the observed field names, nesting, value types, and
lifecycle order. To keep them stable and safe, unrelated envelope metadata was
removed, identifiers were replaced consistently, and the workspace/output
paths were replaced with placeholders.

| file | harness/version | model | lifecycle shape |
|---|---|---|---|
| `claude-subagent.jsonl` | Claude Code 2.1.252 | `claude-sonnet-5` | `Agent`, `task_started`, forwarded child tool/text, `task_updated`, `task_notification`, result |
| `droid-subagent.jsonl` | Droid 0.205.0 | `glm-5.2` | `Task` call/result, with child `session_id` in the result text |
| `codex-subagent.jsonl` | codex-cli 0.149.0 | `gpt-5.6-luna` | `spawn_agent` and `wait` `collab_tool_call` items with `agents_states` |
| `cursor-subagent.jsonl` | Cursor Agent 2026.08.31-4057e58 | `composer-2.5` | `taskToolCall` with camelCase args/result and string `durationMs` |

The commands used the harness's structured streaming mode and unsafe
permission flag, with a prompt restricting the child to that single read.

## codex app-server subagent markers — codex-cli 0.153.4, 2026-09-06

`codex-live-subagent.jsonl` is the Wisp-side log of a live app-server turn
(the `codex-app-server` liveInput driver, model `gpt-5.6-sol`) in which the
parent spawned one child and waited for it. Command output, reasoning and the
surrounding agent messages were dropped; identifiers and the agent path were
replaced consistently; the item shapes and their order are as observed.

What this proves: on the app-server protocol the spawn does **not** arrive as
a `spawn_agent` `collab_tool_call`. The child's lifecycle is reported by
`subagent_activity` items (`kind` ∈ `started`, `interacted`, `interrupted`,
`completed`) that carry the child `agent_thread_id` and its `agent_path`,
each repeated on `item.started` and `item.completed` with an identical
payload. The marker's own `id` is fresh per marker (the spawn reuses the
function call id, the end is a `subagent-completed-…` id), so the thread id
is the only correlation key. The parent's `wait` collab call does arrive, but
with empty `receiver_thread_ids` and `agents_states`, and its `status` is
camelCase (`inProgress`) where `codex exec --json` says `in_progress`.

This capture predates thread scoping in the driver. The app-server attaches
the connection to every spawned child, so the child's own items arrive on it
too; in this turn they were indistinguishable from the parent's and rendered
at the top level.

## codex app-server nested child — codex-cli 0.153.4, model `gpt-5.6-luna`, 2026-09-06

`codex-live-nested-subagent.jsonl` is the Wisp-side log of a live app-server
turn, run through the development instance after the driver learned to tag
events with their `thread_id`, in a throwaway repo whose package.json is
named `papaya-verify`. The prompt asked the parent to spawn exactly one child
to read that name and to answer `child said: <its reply>`. Thread ids and
item ids were replaced consistently; nothing else was altered.

What this proves: every item now carries the thread that emitted it, so the
child's command and final message are its own (`thread_id` of the receiver)
while the parent's two messages stay at the top level. On this turn the spawn
DID arrive as a `collab_tool_call` — `tool: "spawnAgent"`, camelCase
`inProgress`/`pendingInit`, `model` empty on start and resolved on
completion, `reasoning_effort` `medium` on start and `low` on completion —
so both the marker path (previous capture) and the collab path are real on
the same codex build. The child's own `turn/completed` reaches the log as
`subagent.completed` with its final message and `duration_ms`, before the
parent's `wait` returns with the same message in `agents_states`. No
`subagent_activity` marker was emitted on this turn, so no `thread.child`
metadata read happened; the card's model and effort came from the spawn
call instead.

## codex — codex-cli 0.149.0, model `gpt-5.6-luna`, 2026-08-22

Run in a throwaway git repo, stdin from /dev/null (Wisp spawns turns with
`stdin: "ignore"`; with a *pipe* on stdin `codex exec` blocks reading it).

| file | command | exit |
|---|---|---|
| `codex-first-turn.jsonl` | `codex exec --json --dangerously-bypass-approvals-and-sandbox -m gpt-5.6-luna "Reply with exactly the word: papaya"` | 0 |
| `codex-resume-turn.jsonl` | `codex exec --json --dangerously-bypass-approvals-and-sandbox resume <thread_id> -m gpt-5.6-luna "Run the shell command 'echo hi' and then tell me what word I asked for earlier."` | 0 |
| `codex-failed-turn.jsonl` | same as the first turn but `-m no-such-model-xyz` | 1 |

What these prove: the session id (`thread_id`) arrives on a *different* event
than the result text, the result text is nested (`item.completed` →
`item.text`, item type `agent_message`), the terminal `turn.completed` event
carries no result at all, resume keeps the thread (the second turn still knows
"papaya") and accepts the parent `exec` flags, and a failed turn reports
`turn.failed` on **stdout** with a nonzero exit and nothing useful on stderr.

## failure shapes — captured 2026-08-22 for P5e (limit/failure observability)

Cheap stand-ins for limit exhaustion: an unknown model fails fast (no quota
burned) while exercising the exact reporting path a mid-turn failure takes.
Run in a throwaway git repo, stdin from /dev/null.

| file | command | exit |
|---|---|---|
| `claude-unknown-model.jsonl` | `claude -p --output-format stream-json --verbose --dangerously-skip-permissions --model bogus-model "Reply with exactly the word: papaya"` (claude-code 2.1.240) | 1 |
| `droid-unknown-model.stderr.txt` | `droid exec -o stream-json --auto medium -m bogus-model "Reply with exactly the word: papaya"` (model catalog recaptured on droid 0.213.0; failure shape originally captured on 0.202.0) — this is the **stderr**; stdout was empty | 1 |

What these prove:

- **claude** exits 1 with the cause on the *stream*: an `assistant` event
  flagged `error: "model_not_found"`, then a terminal `result` event with
  `is_error: true` and the human message in `result` (beware: its `subtype`
  still says `"success"`). stderr gets only `[claude-code:unrecognized_model]
  {"model":"bogus-model",…}`. One elision vs. the raw capture: a
  `rate_limit_event` telemetry line (account utilization state) was dropped —
  it is periodic telemetry, not a failure signal, and the error strategy must
  ignore it.
- **droid** fails pre-flight: stdout is *empty*, and stderr leads with the
  cause (`Invalid model: bogus-model`) followed by pages of model-list help —
  a stderr *tail* read shows the help and loses the cause, which is why the
  droid error strategy reads the first stderr line.

Limit/quota wording per harness was taken from the installed CLIs' own strings
(not induced live): claude-code 2.1.240
("usage limit reached", "credit balance too low", "rate limited"), droid
0.202.0 ("Unrecoverable 402: usage limit reached", "Standard Usage limit
reached.", gateway "Rate limit exceeded"), codex-cli 0.149.0 ("Usage limit
reached", "Your workspace is out of credits", "You hit your spend cap…",
error kinds `rate_limit_reached` / "quota exceeded" / "usage not included").
These strings seed each adapter's `limitMarkers` in
`wispd/src/adapters/builtins.ts`.

## cursor — cursor-agent 2026.08.31-4057e58, model `cursor-grok-4.6-high`, 2026-09-01

Run in a throwaway git repo, stdin from /dev/null (same as codex — Wisp spawns
turns with `stdin: "ignore"`).

| file | command | exit |
|---|---|---|
| `cursor-accumulated-result.jsonl` | `cursor-agent -p --output-format stream-json -f --trust --model cursor-grok-4.6-high "Use the shell tool to run exactly: echo papaya. Then, in a separate message after the tool result, reply with exactly the word: done"` | 0 |

What this proves: cursor's `result` event does NOT have claude's "final
message" semantics — its `result` is EVERY assistant text of the turn
concatenated with no separator. The turn says "I'll run that echo command
now.", runs the command, then says "done", and the result line carries
`"I'll run that echo command now.done"` — the two texts fused. (First seen in
the wild on a 6-message review turn whose 1668-char result was byte-identical
to the concatenation of its assistant texts.) The turn's conclusion is
therefore derived from the assistant events (`wispd/src/adapters/parse.ts`'s
`cursor-stream-json` strategy), and the result line is only the settlement
signal plus the session/usage carrier. Also pinned: `model` (the displayName)
arrives on the init event, thinking streams as `delta`/`completed` subtypes,
and the usage blob is camelCase (`inputTokens`, `cacheReadTokens`, …).

## opencode — opencode 1.18.29, model `google/gemini-3.6-flash`, 2026-09-10

Run in a throwaway git repo outside any Wisp worktree. Sanitized: session,
message, part and tool-call ids were replaced consistently, git snapshot
hashes zeroed, timestamps flattened, the workspace path replaced with
`/work/repo`, and the provider's opaque `thoughtSignature` blobs replaced with
a placeholder (they are multi-KB base64 and carry no shape Wisp reads).

| file | command | exit |
|---|---|---|
| `opencode-tool-turn.jsonl` | `opencode run --format json --thinking --auto -m google/gemini-3.6-flash "Read the file a.txt, then create b.txt containing the word mango. Then tell me what a.txt said."` | 0 |
| `opencode-thinking-turn.jsonl` | same, `--variant high`, "What is 17 times 23? Think it through, then give the number." | 0 |
| `opencode-unknown-model.jsonl` | same, `-m google/gemini-2.5-flash` (a model the provider has retired) | 1 |
| `opencode-quota-exhausted.jsonl` | a real free-tier quota exhaustion, hit during the live bring-up | 1 |

What these prove, and why opencode needs its own parse strategy:

- **The conclusion and the settlement signal are different events.** The
  turn's prose arrives as `text` parts; the terminal `step_finish` carries no
  text at all. Neither the flat field mapping nor any existing strategy can
  express that pair.
- **A turn is many steps, and only one of them ends it.** Each tool round trip
  is its own `step_start` / `tool_use` / `step_finish` triple with its own
  assistant `messageID`. Every step but the last finishes with
  `reason: "tool-calls"` — opencode's "the agent loop continues" signal — and
  the last one finishes `"stop"`. The tool-turn fixture has three
  `step_finish` events for one turn.
- **Usage is reported PER STEP, never per turn.** Each `step_finish` carries
  its own `tokens{total, input, output, reasoning, cache{write, read}}` and
  `cost`. Wisp persists every step verbatim under `{steps:[…]}` and the
  `opencode-tokens` formatter adds the token counts up; `cost` is money and
  never normalizes.
- **One tool event, already terminal.** `tool_use` is emitted only once a call
  has `completed` or `error`d, so there is no started phase to report and the
  activity stream does not invent one.
- **A failed turn writes the cause to STDOUT and nothing to stderr**, then
  exits 1: `{"type":"error","error":{"name":…,"data":{"message":…}}}`. The
  stderr-tail fallback would surface nothing at all here, which is why
  opencode has an error strategy. Its message-else-name precedence is copied
  from opencode's own renderer.
- **The model is absent on purpose.** `--format json` never reports the
  resolved model id — the line that prints it is gated on the non-JSON format
  — so opencode turns fall back to the requested model, marked "(requested)".

The complete `--format json` event vocabulary is `step_start`, `step_finish`,
`text`, `tool_use`, `reasoning` and `error`: the run command's JSON writer is
one helper, called from exactly six places in the shipped 1.18.29 bundle.
`reasoning` requires `--thinking`, which is why the adapter's exec passes it.

One file in this set is **not** a capture, and is labelled here so nobody
mistakes it for one: `opencode-models-verbose.txt` is a hand-built
`opencode models --verbose` catalog. It is shape-preserving — id line followed
by the model's JSON record, exactly as the CLI prints it — but its entries are
chosen to exercise the capability filter's branches, including two a real
capture could not supply: a custom provider whose model has **no**
`capabilities` block at all, and one with only a partial block. Those are the
cases the filter must not hide, and the installed CLI has no such model to
capture. The real catalog's shape is pinned separately by the `models` surface
in `harness-facts/opencode.json`, which IS read from the CLI.

`opencode-quota-exhausted.jsonl` deserves its own note: it is a genuine
quota-exhaustion capture, not the usual cheap stand-in. The provider's free
tier ran out partway through the live verification, so Wisp's limit
classification was exercised for real — the failure carried
"Quota exceeded for metric: …", matched the `quota exceeded` marker, and the
task was recorded `limit: …` rather than as a generic failure. The marker set
had been derived from the shipped binary *before* this happened, which makes
this the one opencode marker confirmed from both directions. Note also that
the provider's own payload says `isRetryable: true` while the failure is a
hard quota wall — a reminder that the wire's retry hint is not Wisp's
limit/transient distinction.

Limit and transient wording for opencode was otherwise taken from the installed
CLI's own strings rather than induced live: its "Usage limit reached. It will
reset in …" message, the Vercel AI Gateway error class it ships (message
"Rate limit exceeded", type `rate_limit_exceeded`, name
`GatewayRateLimitError` — three spellings of one failure, hence three
markers), its 429 quota mapper, and its own "Provider is overloaded"
rendering. `bun run harness:snapshot` re-checks that all nine still exist in
the shipped binary.

## droid / claude init events — captured 2026-08-22 from real Wisp-run turns

| file | harness | model field |
|---|---|---|
| `droid-init.jsonl` | sanitized `droid exec -o stream-json` init line | `"model": "kimi-k3"` (plus `reasoning_effort`) |
| `claude-init.jsonl` | sanitized `claude -p --output-format stream-json` init line; carries `claude_code_version: 2.1.240` | `"model": "claude-opus-5"` |

These pin where the per-turn ACTUAL model comes from (P5b): the init event's
top-level `model` field for both harnesses (their result/completion events do
not carry one — claude's `modelUsage` is a per-model breakdown object, not the
model name). codex has no equivalent: its `thread.started` carries only
`thread_id` (see the codex fixtures above; also upstream
`codex-rs/exec/src/exec_events.rs` on main), so codex turns report no model
and the UI falls back to the requested one, marked "(requested)".
