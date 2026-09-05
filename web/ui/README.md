# web/ui — the Wisp web app

The app Wisp serves at `/`. React 19 + vite + tailwind v4 + shadcn (on base-ui
primitives), built to **one committed single-file bundle** at
[`web/ui-dist/index.html`](../ui-dist/index.html) that the daemon text-imports.
It is a Bun workspace managed by the repository root lockfile.

Two files are binding law before you write any of it:

- [Frontend conventions](../../skills/wisp-dev/references/frontend.md) — the
  design language (graphite & violet).
  No new hues, no chips, sentence case, honest states. A new surface ships with
  its gallery entry in the same diff.
- [../../brand/README.md](../../brand/README.md) — the mark. `wisp-mark.tsx`
  and the favicon in `index.html` are **generated**; edit the generator.

## Run it

From the repository root, after `bun install --frozen-lockfile`:

```sh
bun run dev           # watched daemon + Vite
```

The app opens at `http://localhost:5173`. Vite hot-reloads UI changes and
proxies `/api` (WebSocket included) to the daemon; Bun fully restarts the
daemon when an imported server source file changes. The contributor scripts
set process-local state under `~/.wisp-dev`; both processes read its
`config.json`, defaulting to port `18710`. Install the dedicated source CLI
once with `bun run dev:install-cli`, then use `wisp-dev` against this daemon.
Bare `wisp` and `~/.wisp` remain the installed production service.

For only one half, use `bun run dev:server` from the repo root or
`bun run dev:ui` for Vite. With no daemon up, the token dialog is as far as you
get; `#/gallery` is the one route that renders standalone, off
`src/lib/fixtures.ts`.

## The one-file rule

`bunx vite build` writes exactly one artifact to `web/ui-dist/`. Everything is
inlined — xterm.js, the Geist fonts, the favicon — because **the daemon serves
that file and nothing else**: there are no asset routes, and `tests/web.test.ts`
asserts both halves (a 404 on `/vendor/*`, and no `src=`/`href=` in the built
`<head>` except the `data:` favicon). That is what makes Wisp work over
tailscale with nothing else reachable, and it is a hard invariant (D1, D12).

`web/ui-dist/index.html` is **committed**, so a web change that ships needs
`bun run build:ui` in the same commit. A test compares the served bytes to the
committed artifact, which is what catches a stale bundle.

## Layout

```
src/
  App.tsx            route split (main vs #/gallery), the three-pane shell
  index.css          tokens — the ONLY place a colour is defined
  components/        surfaces; ui/ holds the vendored shadcn primitives
  lib/               state.ts (STATE_LABEL), api.ts, queries.ts, diff.ts, …
  stream/            the log-stream reducer
  hooks/             useLogStream, useMediaQuery
```

Data flow: TanStack Query for reads, a bridge from the daemon's `/api/events`
SSE stream for invalidation, and `useLogStream` for the live turn. Provider PR
state and the daemon-cached release status are the only polling exceptions.

Writes use the centralized TanStack mutation hooks in `hooks/mutations.ts`;
feature hooks add only their local confirmation or refusal state. Keep that
boundary when adding a write rather than calling `api()` directly from a
component.

## The gate

Every one of these must pass before a web change lands:

```sh
bun run check
bun run build
git diff --exit-code -- web/ui-dist/index.html
```

The root gate covers both workspaces: lint, typecheck, and unit tests. The
build plus diff check proves that the committed single-file bundle matches its
source.

For pixel checks, prefer `bun scripts/capture-app.ts [outdir]` (zero-dep, raw
CDP against system Chrome) over eyeballing a browser pane: it emits
deterministic desktop, mobile, and gallery PNGs.
