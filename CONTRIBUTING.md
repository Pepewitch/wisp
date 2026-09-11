# Contributing to Wisp

Small, focused contributions are welcome. For a bug report, include your Wisp
version, OS, harness, what you expected, and steps to reproduce. Discuss larger
changes in a [GitHub issue](https://github.com/Pepewitch/wisp/issues) before
building them.

Do not include tokens, private code, task transcripts, or personal paths.
Report vulnerabilities through the private route in [Security](SECURITY.md),
not a public issue.

## Run locally

Install Git and **Bun 1.3.14**, then run these commands from a Wisp checkout:

```sh
bun install --frozen-lockfile
bun run dev:install-cli
bun run dev
```

Open the URL Vite prints, normally `http://localhost:5173`. In another terminal,
run `wisp-dev token` to get the token for that development daemon.
Running real tasks also needs an installed and authenticated harness.

`wisp-dev` runs source from the current checkout and uses `~/.wisp-dev`.
Installed `wisp` uses `~/.wisp`. Never point development at your production
profile. `wisp-dev` ignores a globally exported `WISP_HOME`; set `WISP_DEV_HOME`
only if you need another isolated development location.

The development daemon defaults to port `18710`. If it is occupied before
initialization, use `wisp-dev init --port 18711` before `bun run dev`.
Vite follows that profile's persisted daemon address.

## Check your change

Start with the smallest relevant check:

```sh
bun run docs:check
bun run --cwd wispd test -- tests/config.test.ts
bun run --cwd web test -- src/components/start-here.test.tsx
```

The last two commands run one daemon test file and one UI test file;
substitute the file closest to your change.

For code changes, run `bun run check` before opening a PR. It covers docs,
release versions, workflow pins, lint, type checks, and tests. Use
`bun run smoke` for a daemon end-to-end check and `bun run build` to verify the
self-contained binary. Native bridge/proxy changes also need
`bun run desktop:check`; see the [Desktop guide](desktop/README.md).

Browser and Desktop share one UI. Describe the effect on **both clients** and
what you tested; keep deliberate runtime differences behind their existing
boundary. Do not commit `web/ui-dist/`, native build output, or local logs.

Documentation-only changes need link checks and verification of any commands
or claims they change, not an unrelated native build.

## Find the right code

- [Architecture](docs/ARCHITECTURE.md): daemon, clients, and ownership boundaries.
- [Contributor skill](skills/wisp-dev/SKILL.md): detailed development rules and
  guides for server, frontend, and harness changes.
- [Adding a harness](docs/ADDING-A-HARNESS.md): adapter capabilities and tests.
- [Release playbook](skills/wisp-dev/references/releasing.md): maintainer-only
  packaging, qualification, and publication.
- [Brand assets](brand/README.md): generated assets and their source.

Keep a PR about one change. Explain the user-visible result, link its issue
when there is one, and list checks run or skipped. Screenshots should use a
synthetic sample project. Keep investigation notes and plans in ignored
`.context/`, not in public documentation.
