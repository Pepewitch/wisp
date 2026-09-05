---
name: wisp-dev
description: Modify and validate the Wisp repository using its contributor architecture and conventions. Use for harness adapters, daemon/CLI/API behavior, task lifecycle, worktrees, streaming, or the React web UI. Not for operating Wisp to delegate work; use the wisp skill instead.
---

# Wisp development

This is a routing guide for changing Wisp itself. It is intentionally not a
second copy of the implementation. Read only the reference that matches the
task, then inspect the source and nearby tests. When documentation and source
disagree, `src/` and `web/ui/src/` win.

Use the separate `wisp` skill when the job is to create, steer, or integrate a
Wisp-managed task. Use `wisp-dev` when the job changes this repository.

## Mental model

Wisp is one Bun/TypeScript package with a daemon at the center:

    CLI ──HTTP──┐
                ├── daemon/routes ── store + worktrees + runner ── harness process
    web ─HTTP───┘                         │              │
         SSE/WS                           └── outbox     └── adapter

- The daemon owns business logic. The CLI and web app are clients of its API.
- A task is a checkout or isolated worktree plus an adapter, a harness session,
  and persisted turns. Each turn is one short-lived headless harness process.
- SQLite and the webhook outbox are durable truth. The in-memory event bus and
  SSE streams are realtime delivery, never a ledger.
- Harness-specific argv and wire knowledge stays under `src/adapters/`.
- The React app uses Query for replaceable server state and a separate reducer
  for append-oriented activity. It ships as one generated, committed HTML file.

## Route the task before reading deeply

| Change | Read first | Then inspect |
| --- | --- | --- |
| Add or change a harness or capability | [Adding a harness](../../docs/ADDING-A-HARNESS.md) | `src/adapters/`, captured fixtures, adapter/API tests |
| Refresh a builtin after its CLI or model lineup changes | [Keeping built-in harnesses current](references/harness-sync.md) | The builtin, its version pins, fixtures, and narrow contract tests |
| Change daemon, CLI, API, persistence, lifecycle, worktrees, SSE, or terminal behavior | [Server architecture and development](references/server.md) | The owning `src/` module and its nearest tests |
| Change React UI, styling, responsive behavior, or frontend data flow | [Frontend conventions](references/frontend.md) | `web/ui/README.md`, the owning component/hook, and its tests |
| Prepare or publish a versioned release or Homebrew update | [Releasing and publishing Wisp](references/releasing.md) | Release scripts, release notes, evaluator guide, and both repository diffs |
| Change a user-visible command or contract | Server reference plus the source | `README.md` and `skills/wisp/references/` so operational guidance stays true |
| Change product direction or revisit an invariant | Open a focused proposal | Keep unpublished planning outside the public repository |
| Change the mark or generated brand assets | `brand/README.md` | `scripts/brand/`; never hand-edit generated assets |

Source and tests are authoritative for architecture, fields, payloads, and
behavior. Keep public documentation focused on installation, operation,
security, extension points, and contribution workflows.

## Open-source safety

This repository and its collaboration metadata are public. Treat tracked and
generated files, fixtures, branch names, commit authors and messages, issue and
PR titles, descriptions, comments, screenshots, logs, and release material as
publication surfaces.

- Never include employer, client, organization, repository, project, or issue
  names learned from private work, even when the organization itself is
  publicly known. Also exclude internal URLs and domains, real user data,
  machine-local absolute paths, session or task identifiers, credentials, and
  text or artifacts copied from private systems.
- Turn work-derived feedback into a clean-room reproduction written from
  scratch. Use clearly synthetic names, paths, IDs, repositories, logs, and
  screenshots while preserving only the behavior needed to understand and test
  the change. Partial find-and-replace sanitization is not sufficient.
- Keep raw prompts, task databases, transcripts, logs, screenshots, and
  evaluation output in an approved private system. A personal private
  repository is not automatically approved for employer or client data.
- Before committing or preparing a PR, inspect the complete diff, generated
  output, branch and commit metadata, and proposed PR text for accidental
  disclosure. If provenance or permission is uncertain, stop and ask the
  maintainer instead of publishing.

## Working rules

1. Start from the owning source and tests, not a broad documentation crawl.
2. Put behavior at the existing seam: routes orchestrate requests, the store
   owns transitions, the runner owns process lifecycle, adapters own harness
   differences, and frontend transport stays outside components.
3. Reuse named adapter strategies and shared UI primitives before adding a new
   abstraction. Honest absence is better than guessed harness behavior.
4. Run the narrowest relevant check while iterating, then the applicable gate
   from the server or frontend reference.
5. A shipped web change includes a regenerated `web/ui-dist/index.html`.
   Never edit that bundle by hand.
6. Keep this entry point thin. Put durable workflow or rationale in the
   selective references; leave volatile field lists and exact payload shapes
   in code and tests.
