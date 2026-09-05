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
| `droid-unknown-model.stderr.txt` | `droid exec -o stream-json --auto medium -m bogus-model "Reply with exactly the word: papaya"` (droid 0.202.0) — this is the **stderr**; stdout was empty | 1 |

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
`src/adapters/builtins.ts`.

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
therefore derived from the assistant events (src/adapters/parse.ts's
`cursor-stream-json` strategy), and the result line is only the settlement
signal plus the session/usage carrier. Also pinned: `model` (the displayName)
arrives on the init event, thinking streams as `delta`/`completed` subtypes,
and the usage blob is camelCase (`inputTokens`, `cacheReadTokens`, …).

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
