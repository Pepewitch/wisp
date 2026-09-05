# Wisp v0.4 evaluator

This runner executes the v0.4 activation event in a fresh, constrained Ubuntu
24.04 x86_64 container. It grades process, API, SQLite, Git, filesystem,
browser, and leak evidence. The model's final message never decides pass/fail.

## Fixed panel

Cases run sequentially, each with new Wisp state, Droid state, repository,
worktree, browser, networks, worker, and proxies:

1. `gpt-5.6-luna` at medium effort;
2. `glm-5.2-fast` at high effort;
3. `grok-4.6` at medium effort.

The outer evaluator model installs Wisp and operates the product. The first
Wisp task launches an independent inner Droid through Wisp's built-in adapter.
That Droid runs in a dedicated worker container with its own process tree,
normal proc filesystem, home, and proxy. It receives only the task worktree,
the repository's Git metadata, and a narrow local stream bridge. No session or
filesystem state is shared between panel cases.

Every case pins the inner coding task to `glm-5.2-fast`. This keeps the product
task identical across outer evaluators and avoids inheriting an account-local
Droid default or custom-provider credential requirement.

## Credential boundary

The API key file is never mounted into the model container. It is mounted
read-only into two egress proxy sidecars, one for the outer evaluator Droid and
one for Wisp's inner Droid. Both model processes see only a placeholder
`FACTORY_API_KEY`; each proxy terminates TLS for the allowlisted Factory hosts
and replaces the Authorization header after the request crosses the container
boundary.

The evaluator and inner worker containers have only an internal Docker
network. The proxies alone also join an outbound network and reject
non-Factory hosts. Browser traffic is restricted to localhost. The sidecars
log role/host/path decisions only, never headers, query strings, or bodies.
The worker receives only the inner proxy address and CA, so the inner Droid
cannot inspect or reuse the outer Droid's proxy connection.

Both model containers are non-root, capability-free, read-only,
PID/resource-limited, use Docker's default seccomp profile, and have no Docker
socket. All writable paths are explicit tmpfs, volumes, or evidence mounts. The
inner worker cannot read the outer home, workspace, release, browser,
evidence, or static evaluator directory.

This prevents direct file/environment reads of the real key. It does not stop a
model from making authorized Factory API calls through the proxy, which is why
the run still requires a revocable key with a small spend cap, sequential
execution, a wall-clock timeout, prompt constraints, post-run leak scanning,
and immediate revocation after qualification.

## Run

Build a clean release artifact from the exact evaluator commit first:

```sh
bun run release:linux
```

Prove the complete Docker/install/Wisp/fake-inner-Droid/browser/oracle path
without an API key:

```sh
scripts/evaluator/run.sh --preflight --rebuild-image
```

Run one real case:

```sh
scripts/evaluator/run.sh \
  --model gpt-5.6-luna \
  --droid-api-key-file /absolute/path/to/mode-0600-key-file
```

Run the panel:

```sh
scripts/evaluator/run.sh \
  --all \
  --droid-api-key-file /absolute/path/to/mode-0600-key-file
```

Raw, sanitized evidence lands under `dist/evaluator/<run-id>/`, which is
gitignored. Each case emits `case.json`; the run emits `summary.json`. Publish
only the reviewed, sanitized records selected for `docs/v0.4/evidence/`.

The runner refuses a dirty worktree, a release manifest from another commit, a
bad checksum, a symlinked key path, or a key file not mode `0600`.
Before spending on an outer evaluator turn, it also verifies the dedicated
inner worker's authenticated Droid path through the inner proxy.
After the browser follow-up settles, the outer model blocks in a one-way
handoff command while the evaluator captures live daemon and browser state.
The collector releases that barrier before the model exits.

The baseline pins Ubuntu by digest, Node and Chrome archives by SHA-256, and
Droid, agent-browser, and proxy packages by exact version. Each case also
records the exact evaluator image ID.

## Objective task

The visible fixture starts with a case-sensitive `filter_lines` function. Turn
one must implement case-insensitive substring matching and commit it. The exact
phone-composer follow-up must also trim query-edge whitespace and commit it.
A hidden oracle checks mixed-case behavior, edge whitespace, order, and empty
results. The original checkout must stay unchanged while the Wisp worktree has
at least two commits and is clean.

## Evidence

Each case includes:

- pinned image/tool/Wisp identity and process exits;
- installer, doctor, daemon, and model logs;
- Wisp API plus SQLite lifecycle assertions;
- hidden fixture oracle and Git isolation assertions;
- 390×844 accessibility snapshot, screenshot, HAR, request ledger, console,
  and page-error captures;
- role-separated sidecar egress decisions;
- real-key and key-shaped leak scan.

The HAR omits response bodies. The collector redacts Wisp's browser token
before the host-side key scan. Any credential finding fails the case and is
scrubbed before evidence validation.
