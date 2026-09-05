# Harness contract facts

One file per builtin, holding what Wisp asserts about that harness CLI and the
version each assertion was last verified against. Produced by
`bun run harness:snapshot`, asserted by `tests/harness-facts.test.ts`.

These files exist so drift is **diffable**. A CLI can jump twenty releases and
change nothing Wisp depends on, or bump a patch and rename a usage key — the
version number alone cannot tell you which. An empty facts diff means the
update is irrelevant to Wisp, whatever its release notes claim.

## Per-surface pins

Each surface carries its own `verifiedAgainst`, because that is how this
repository already works: droid's `liveInput` comment records "reverified on
0.213.0 … steering was last live-probed on 0.205.0". Re-verifying steering
costs a live turn and is skipped when the schema is unchanged, so a single pin
per harness would erase exactly the information that keeps a refresh cheap.

## `cost` is the load-bearing field

- **`free`** — re-read from the installed CLI with no model tokens: help text,
  native catalogs, invalid-value rejection messages, binary strings.
  `harness:snapshot` refreshes these itself.
- **`live`** — needs a real turn. Never re-run automatically; carried forward
  with its pin and reported when stale, so a turn is spent only when the report
  says one is genuinely needed. Refreshing these is `harness-sync.md` §5.

## What may be recorded

The extractors are **allowlist-based, never redaction-based**: only named fact
keys — model ids, effort values, flag tokens, marker presence. Help text is
never copied verbatim and a catalog is never dumped (`codex debug models` alone
is ~375 KB of prompts and account prose). This repository is public, and a
redactor that has to recognise a secret will one day miss one; an allowlist
cannot leak what it never reads. `harness-facts.test.ts` backstops this by
rejecting absolute paths, home directories and email addresses.

## Relationship to the prose pins

The per-assertion comments in `src/adapters/` and the table in
`tests/fixtures/README.md` explain *why* a pin is what it is, and stay. These
files are the machine-readable half. **Prose explains; facts assert.**

## Refreshing

```sh
bun run harness:check              # what drifted, and is my CLI even current
bun run harness:snapshot           # re-read free surfaces, rewrite, grade the diff
bun run harness:snapshot --check   # diff without writing; exit 1 on drift
bun test tests/harness-facts.test.ts
```

A harness whose binary is not installed is skipped with a note, never a
failure — the same posture as `wisp doctor`'s per-harness checks.
