# Adding a harness

Wisp drives four coding-agent CLIs — droid, claude, codex, cursor — through
one seam: the adapter. An adapter is **declarative config plus small named
strategies** (D7): how to run one headless turn, how to resume the session,
and how to read the machine output. No harness knowledge lives outside
`src/adapters/` — the daemon, the routes, the CLI, and the web UI all render
*through* the adapter, so a new harness is one entry in
`src/adapters/builtins.ts` plus, at most, a few new named strategies.

This doc is the distilled experience of adding all four. Follow the order —
it is the order that keeps you from pinning a guess.

## 0. The one rule: probe before you pin

Everything an adapter asserts must come from the harness itself, on your
machine, at a pinned version. Never from docs, never from memory, never by
analogy with another harness. The concrete toolkit:

1. **`<bin> --help`** — the argv shape: print mode, output-format flag,
   model/resume/effort flags, the permission-bypass flag you need for
   unattended runs. Read the *whole* help; the interesting flags are rarely
   grouped together.
2. **Bundled-source strings (the SP1 technique)** — for wire shapes. These
   CLIs ship as bundled JS. Find the init/result event literals:
   `strings` (or `rg` on the unpacked chunks) for `"subtype"` / `"init"` /
   field names near them. Cursor's stream-json init, result, tool_call and
   usage shapes were first read out of
   `~/.local/share/cursor-agent/versions/…` this way. Its usage wire later
   moved from snake case to camel case; the current fixture carries
   `cacheReadTokens`, while Wisp's normalizer deliberately accepts both
   verified generations.
3. **The CLI's own subcommands** — `models`, `status`/`whoami` tell you real
   model ids and auth state. *Read the ids off the output.* During the cursor
   bring-up the guessed id `grok-4.6` did not exist — the real id is
   `cursor-grok-4.6-high`. Pinning the guess would have failed pre-flight on
   every task.
4. **One cheap live turn, captured** — run the harness headless by hand with
   a throwaway prompt, then sanitize paths, identifiers, and unrelated
   environment metadata before saving it under `tests/fixtures/` (see its
   README). The codex parse strategy is tested against an observed,
   shape-preserving fixture, not a hand-written approximation.

If a surface can't be probed, it is **absent** — see §4.

## 1. The minimal adapter

```ts
// src/adapters/builtins.ts
cursor: {
  bin: "cursor-agent",
  exec: ["-p", "--output-format", "stream-json", "-f", "--trust"],
  resume: ["--resume", "{session}"],
  model: ["--model", "{model}"],
  parse: { format: "json", strategy: "cursor-stream-json" },
  events: "cursor-stream-json",
  activity: "cursor-stream-json",
  usageFormat: "snake-tokens",
},
```

The fields, and what getting each one costs:

- **`bin` / `exec`** — how to run one turn. The prompt is appended as the
  final positional. Missing the bypass flag (`-f`/`--dangerously-…`) costs
  you a turn that hangs forever on a permission prompt nothing can answer.
- **`resume`** — appended when the task has a stored session. Without it
  every turn is a fresh session and follow-ups lose all context. Verify with
  two turns: ask a word in turn 1, ask it back in turn 2.
- **`model` / `effort` (+ `effortLevels`)** — templates with `{model}` /
  `{effort}` substitution. Read the allowed effort values off the CLI (an
  invalid value usually prints "Allowed values: …") — the three existing
  ladders genuinely differ, so none is shared.
- **`parse`** — the flat field mapping covers stream-json dialects whose
  result is one JSON line with a stable `type` (`resultType`) and named
  fields for result text / session / model / needsInput / usage / skills.
  When the shape doesn't fit — codex's is a different protocol entirely —
  write a **named parse strategy** instead (`parse.strategy`, keys into
  `PARSE_STRATEGIES`, mutually exclusive with the flat fields).
- **`model` in `parse`** — the model the turn *actually* ran on, from the
  init or result event. Omitted means the harness never reports it and
  surfaces show the requested model marked "(requested)".

**The spawn contract:** for a `json` adapter, exit 0 with no parsed result is
a *failure* — a turn needs a positive signal, not a bare exit code. Set
`allowEmptyResult: true` only for a harness that legitimately exits 0 with no
result object.

## 2. Named strategies: reuse by name, add when the wire is new

Every cross-cutting surface is a registry in `src/adapters/`; an adapter
field holds a *key* into one. The existing inventory:

| Registry (file) | Adapter field | Existing keys |
| --- | --- | --- |
| `PARSE_STRATEGIES` (parse.ts) | `parse.strategy` | `codex-jsonl`, `cursor-stream-json` |
| `EVENT_FORMATTERS` (format.ts) | `events` | `claude-stream-json`, `droid-stream-json`, `cursor-stream-json`, `codex-jsonl` |
| `ACTIVITY_NORMALIZERS` (activity.ts) | `activity` | `claude-stream-json`, `droid-stream-json`, `cursor-stream-json`, `codex-jsonl` |
| `ERROR_STRATEGIES` (errors.ts) | `errors` | `claude-stream-json`, `codex-jsonl`, `droid-stream-json` |
| `USAGE_FORMATTERS` (usage.ts) | `usageFormat` | `snake-tokens`, `codex-usage` |
| `MODEL_DISCOVERY` (discovery.ts) | `modelDiscovery` | `droid-models`, `codex-models` |
| `PROBE_STRATEGIES` (probe.ts) | `probe` | `print-slash`, `factory-jsonrpc`, `codex-app-server` |
| `SKILL_STRATEGIES` (skills.ts) | `skillDiscovery` | `claude-init`, `factory-jsonrpc`, `codex-app-server` |
| `COMPACT_STRATEGIES` (compact.ts) | `compact` | `factory-jsonrpc`, `codex-app-server` |
| image strategies (images.ts) | `imageInput` / `imageDelivery` | `claude-stream-json`, `read-tool-path` |
| live drivers (`live/`) | `liveInput` | `claude-stream-json`, `droid-jsonrpc`, `codex-app-server` |

**A new strategy is justified when the harness's wire is genuinely new** —
cursor's tool activity arrives as top-level `tool_call` events keyed by
variant (`shellToolCall`, `readToolCall`, …), so `cursor-stream-json` derives
the tool name from the key instead of hardcoding a list that would rot. A
harness whose stream is claude's shape just sets both `events` and `activity`
to `"claude-stream-json"` — reusing by name is what
`~/.wisp/adapters.json` overrides do, and it needs no code at all. Set
`activity` to `null` when overriding a builtin with a different wire format
that has no structured normalizer; the web then uses the human formatter.

Strategies take injected process factories (`SpawnFn`, `ProbeIo`) so tests
never spawn a real CLI. Follow that — a test that spawns a real harness is a
flake and a quota leak.

## 3. The optional surfaces, in the order to attempt them

Each of these is a field on `AdapterDef`. Add them only after probing each
one; each has a named refusal when absent, so the UI degrades honestly.

1. **`events`** — the compact `wisp log` activity feed.
2. **`activity`** — the web's structured tool/subagent projection. Preserve
   stable call and child ids, parent relationships, status, result and error;
   do not infer fields the harness did not emit.
3. **`usageFormat`** — normalizes the raw usage blob into `UsageSummary` at
   the API boundary. Copy values, never compute or invent them;
   `snake-tokens` now accepts both cache-read key spellings. Money fields
   stay out of the normalized shape (token counts are facts; prices rot).
4. **`errors` + `limitMarkers` / `transientMarkers`** — how a failed turn
   names its cause, and which causes mean quota vs flake. **Never invent the
   markers**: they must be read off real captured failures. Cursor still has
   no errors strategy — its pre-flight failures (unknown model, auth) write a
   clear message to stderr, and the runner's stderr-tail fallback surfaces it
   verbatim. That was *proven* live; until then the field was simply absent.
5. **`modelDiscovery`** vs **`staticModels` + `defaultModel`** — prefer a
   probe of the installed CLI (`wisp models` is honest when there is none).
   `staticModels` is the documented exception for CLIs that enumerate none;
   `defaultModel` must be *in* the static list (validate enforces it) and
   loses to both a probed default and the user's `harnessDefaults` config.
   Cursor is static *by owner decision*: the pinned list is the product.
6. **`probe`** — out-of-turn reads (`context`, the harness's own `usage`).
   The strategy declares which commands it can answer; a surface never fakes
   the other one. The two JSON-RPC envelopes (`factory` adds droid's
   `type:"request"` framing) already exist.
7. **`skillDiscovery`** — how the palette's Tier 3 lists the harness's own
   skills, plus `invoke: "slash" | "prompt"` — how a pick becomes prompt
   text. A harness with no headless slash surface is `"prompt"`, and the
   palette says the pick costs a turn.
8. **`compact` / `compactPrompt`** — mutually exclusive (validate rejects
   both together). A strategy when the harness has an RPC for it; the prompt
   when its `/compact` runs headless as an ordinary turn. Set the strategy's
   `recordsTurn` truthfully — the palette tells the user what a compact
   costs.
9. **`image` / `imageInput` / `imageDelivery`** — the three delivery forms
   (argv template, stdin envelope, prompt-path preamble), mutually exclusive.
   The trailing `--` in an argv template is mandatory.
10. **`liveInput`** — only for a protocol verified to admit a message without
   terminating the active turn. Admission must have a native acknowledgement,
   stable client message id, and a terminal event. No field means Wisp
   persists active submissions for the next turn. Never implement this with
   signals or terminal keystrokes. Calls must have a bounded acknowledgement
   wait and reject pending work when the channel closes. Overriding a
   builtin's `bin` or `exec` disables inherited live input; re-declare it only
   after verifying the custom command preserves that protocol and every
   required execution-policy flag.
11. **`attach`** — interactive attach argv; `null` means "not known yet",
   which is a legitimate state.

## 4. Honest absence is a feature

Every omitted field has defined behavior: raw lines in `wisp log`, human
prose without invented structure in the web activity stream, `usage: null`
at the API, the stderr-tail error fallback, a named
refusal from the probe/skills/compact routes, "(requested)" on the model
label. An invented shape is worse than an absent one — an invented limit
marker misfires, an invented model id fails pre-flight, an invented default
contradicts the harness. When in doubt, leave the field out and let the
refusal carry the truth.

## 5. The test pins that will fail — update them deliberately

Adding a builtin breaks several pins *by design*; each failure is a checklist
item, not a surprise:

- `ADAPTER_KEYS` (tests/adapters.test.ts) — the known-builtin set.
- The "known: …" lists in validation error messages (adapters, format,
  config tests) — new strategy keys appear in them.
- The `/api/harnesses` payload pin (tests/api-contracts.test.ts) — the new
  harness's full published shape: exec/resume/effort/models/compact/…
- The unknown-harness error message (routes tests) — names the valid set.
- If you added a field (as slice 9 added `defaultModel`): the
  `AdapterDef`-shape pins and the validate rules for it.

Write the new harness's own tests alongside: an argv pin (`buildArgv` with
and without session/model/effort), a transcript parse test on the probed
shape, a usage normalization test, and formatter cases. Then the full gate:
`bun run check`. Run `bun run smoke` as well when the change affects process,
lifecycle, worktree, or broad API behavior.

## 6. Live verification checklist

Unit tests prove the adapter against fixtures; only a live run proves it
against the harness. With an isolated home (`WISP_HOME=/tmp/…`) and a
scratch git repo:

1. `wisp doctor` — the harness line reports the installed version (harness
   checks are generic over the adapter map; no doctor change is needed).
2. A simple task on the default model — `wisp new … && wisp wait` — done
   with the expected answer, session id captured.
3. A second turn that requires memory of the first — proves `resume`.
   If `liveInput` is declared, also submit a correction while a harmless
   long-running tool call is active and prove one turn completes with the
   corrected answer.
4. The persisted usage row — proves `parse.usage` + `usageFormat` end to end.
5. One cheap failure (e.g. a bogus model) — proves the failure path names
   the real cause, and tells you whether an `errors` strategy is warranted
   or the stderr-tail fallback is genuinely enough.

Record the harness version you verified against in the commit message.
Versions drift; the version is what makes the pin re-checkable.
