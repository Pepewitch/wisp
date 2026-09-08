# wispd

`wispd/` owns the Wisp daemon and the `wisp` command-line client. They share
`src/index.ts`: `wisp serve` starts the daemon, while the other commands enter
the CLI.

- `src/` contains daemon, API, persistence, worktree, runner, adapter, terminal,
  and CLI code.
- `tests/` contains the daemon and CLI test suite.
- `scripts/` contains binary builds, daemon releases, smoke tests, harness
  synchronization, evaluator tooling, and the source-development launcher.

The daemon embeds `../web/ui-dist/index.html`, the same generated bundle that
Wisp Desktop packages. Build and validation orchestration stays at the
repository root. The public `scripts/install.sh` and `scripts/uninstall.sh`
entrypoints also stay at the root so existing release URLs remain stable.

```sh
bun install --frozen-lockfile
bun run check
bun run smoke
bun run build
```

Use `bun run --cwd wispd test -- tests/<name>.test.ts` for a focused daemon
test.
