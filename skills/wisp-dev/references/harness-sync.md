# Keeping built-in harnesses current

Use this workflow after a supported harness CLI updates, changes its model
lineup, or starts producing output Wisp no longer understands. The goal is not
to copy a changelog. It is to reverify every adapter assertion against the
installed CLI, change only what drifted, and leave evidence that the next
refresh can repeat.

Read [Adding a harness](../../../docs/ADDING-A-HARNESS.md) for adapter field
semantics and honest-absence rules. This guide covers refreshing an existing
builtin without wasting model quota.

## 1. Establish the old and new baselines

Work in an isolated Wisp worktree. Record:

- the Wisp commit and builtin being checked;
- `<bin> --version` and the executable path;
- the versions named in that builtin's comments and captured fixtures;
- the release-note range between the last verified version and the installed
  one.

Release notes are a triage list, not evidence for an adapter field. The
installed CLI's help, bundled catalog, machine output, and live behavior are
the evidence.

Search the owning surfaces before probing:

```sh
rg -n 'claude-code|staticModels|modelDiscovery|<harness-name>' \
  src/adapters tests docs skills
```

This exposes all version pins and prevents updating the model picker while
missing a related argv, parser, fixture, or guide assertion.

## 2. Spend zero model tokens first

Start with commands that cannot reach a model:

1. Run `<bin> --help` and the relevant subcommand help. Compare print mode,
   structured output, resume, model, effort, permissions, images, attach, and
   subagent-forwarding flags with `src/adapters/builtins.ts`.
2. Ask native metadata surfaces for model ids and defaults. Prefer a real
   `models` or debug subcommand and keep `modelDiscovery` when one exists.
3. For a bundled CLI, inspect its shipped catalog or source strings when the
   CLI exposes no machine-readable catalog. Read exact ids and lifecycle
   metadata, never infer an id from a display name.
4. Exercise documented local commands that report their own usage as zero.
   For Claude Code, print-mode `/model`, `/context`, `/usage`, and `/compact`
   are useful checks. Confirm their result event says zero input and output
   tokens rather than assuming they remain local.

Claude Code is the deliberate `staticModels` exception. It has no model-list
subcommand Wisp can probe. Its refresh evidence is:

```sh
claude --version
claude --help
strings "$(command -v claude)" |
  rg 'claude-(fable|opus|sonnet|haiku)-'
claude -p --output-format stream-json --verbose \
  --forward-subagent-text --dangerously-skip-permissions \
  --model <full-model-id> --effort low /model
```

The last command is locally intercepted. Verify `duration_api_ms: 0`,
`num_turns: 0`, and zero token fields before treating it as a free probe.
Use the full model id, not a moving alias. When the baked catalog marks the
old generation legacy, replace it in Wisp's curated current lineup instead of
letting `staticModels` grow forever.

Do not paste a raw init event into an issue, fixture, or response. It can name
local paths, enabled tools, plugins, MCP servers, and account configuration.

## 3. Audit the complete adapter contract

Check each assertion even when the release notes mention only models:

| Surface | Evidence |
| --- | --- |
| `exec`, `resume`, `model`, `effort`, `attach` | Current help plus zero-token argv checks |
| `effortLevels` | Help or the CLI's own validation error |
| `staticModels` / `defaultModel` / `modelDiscovery` | Native catalog first, bundled catalog only when native discovery is absent |
| `parse` | Init and terminal events from current structured output |
| `events`, `activity` | Assistant, thinking, tool, and subagent lifecycle events |
| `usageFormat` | The terminal event's raw token keys |
| `errors`, limit/transient markers | Captured real failures or shipped strings, never invented wording |
| `probe`, `skillDiscovery`, `compact` | Local command or RPC behavior, including whether it records or spends a turn |
| image delivery | A purpose-built visual fixture, only when that surface may have changed |

If a field cannot be proven, leave it absent or preserve the last proven
behavior. Do not redesign a strategy merely because the CLI added unrelated
features.

## 4. Make the smallest code change and pin it

Update the builtin and every direct contract pin. Common locations:

- `src/adapters/builtins.ts`;
- `tests/adapters.test.ts`;
- `tests/api-contracts.test.ts`;
- the nearest strategy tests and `tests/fixtures/README.md`;
- user or contributor guidance that names the old verified version.

Run the narrow tests before any token-spending verification:

```sh
bun test tests/adapters.test.ts tests/api-contracts.test.ts
```

If a wire shape changed, capture one current JSONL transcript, then sanitize
only unrelated values: paths, ids, timestamps, tool inventories, account
configuration, and user content. Preserve field names, nesting, value types,
event order, model, usage keys, and failure flags. Add a fixture test that
would fail on the old parser.

## 5. Escalate to one minimal live turn

Only after static and zero-token checks pass, run Wisp end to end with an
isolated `WISP_HOME` and a throwaway Git repository. Use:

- the exact full model id being added or changed;
- the lowest supported effort;
- one trivial prompt, for example `Reply with exactly: hello`;
- no tools, images, subagents, or follow-up model prompt.

For expensive models, especially Fable, do not use a coding task as a smoke
test. One word proves argv acceptance, stream parsing, actual-model capture,
result settlement, and usage persistence.

The expected Wisp evidence is:

```text
created <task> (<harness>, <full-model-id>)
<task>  done — hello
— turn 1 [done] · <full-model-id>
  usage: ...
  agent: hello
```

Then verify resume without another model call by sending a proven zero-token
local command such as Claude Code's `/model`. Confirm the same session id and
a second turn with zero usage. Stop there unless the changed contract itself
requires a tool, image, subagent, or failure-path probe.

## 6. Finish and report the evidence

Run the server gates:

```sh
bun run test
bun run typecheck
bun run lint
```

Run UI gates only when the public harness contract or UI changed. Run smoke
when lifecycle, worktree, process, recovery, or broad API behavior changed.

Before finishing:

1. inspect `git diff --check`, the full diff, and worktree status;
2. stop the isolated daemon and remove only the scratch state created for the
   probe;
3. report the installed harness version, exact model id, live prompt, effort,
   result, actual model, and token usage;
4. state which surfaces were zero-token, which consumed a turn, and which were
   not rerun because they did not change;
5. keep the verified CLI version beside the adapter assertion so the next
   refresh has a clear starting point.
