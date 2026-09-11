# wispd

`wispd/` owns the Wisp daemon and the `wisp` command-line client. They share
`src/index.ts`: `wisp serve` starts the daemon, while the other commands enter
the CLI. `wisp update` refreshes the promoted daemon channel and delegates the
verified installation and supervised restart to the running daemon.

- `src/` contains daemon, API, persistence, worktree, runner, adapter, terminal,
  and CLI code.
- `tests/` contains the daemon and CLI test suite.
- `scripts/` contains binary builds, daemon releases, smoke tests, harness
  synchronization, evaluator tooling, and the source-development launcher.

The daemon embeds `../web/ui-dist/index.html`, the same generated bundle that
Wisp Desktop packages. Build and validation orchestration stays at the
repository root. The public `scripts/install.sh` and `scripts/uninstall.sh`
entrypoints also stay at the root so existing release URLs remain stable.

See [Contributing](../CONTRIBUTING.md) for source setup and focused tests.

## Test a release candidate

From the repository root, build and exercise the installer against a local
Linux candidate:

```sh
bun run release:linux
version="$(bun -p 'require("./wispd/package.json").version')"
artifact="dist/release/v$version/wisp-v$version-linux-x86_64"
WISP_ARTIFACT_PATH="$artifact" \
WISP_SHA256="$(sha256sum "$artifact" | awk '{print $1}')" \
WISP_COMMIT="$(git rev-parse HEAD)" \
sh scripts/install.sh --no-service
```

Use a disposable test environment: this is the real installer and its default
paths belong to an installed Wisp profile. `--no-service` prevents service
activation, not writes to those paths. For automated checks, use
`bun run test:install` and `bun run test:activation` with the candidate's
absolute path in `WISP_ARTIFACT_PATH`. Follow the
[release playbook](../skills/wisp-dev/references/releasing.md) before publishing.
