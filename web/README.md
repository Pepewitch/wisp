# web — the shared Wisp React app

The React application used by both Wisp clients: the daemon serves it at `/` in
a browser, and Wisp Desktop packages it in a Tauri webview. React 19 + Vite +
Tailwind v4 + shadcn (on base-ui primitives) build to **one Git-ignored,
derived single-file bundle** at `web/ui-dist/index.html`.
It is a Bun workspace managed by the repository root lockfile.

Three sources are binding law before you write any of it:

- [Frontend conventions](../../skills/wisp-dev/references/frontend.md) — the
  design language (graphite & violet).
  No new hues, no chips, sentence case, honest states. A new surface ships with
  its gallery entry in the same diff.
- [Architecture](../../docs/ARCHITECTURE.md) — the browser/desktop runtime,
  transport, ownership, and connection-scoping contract.
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

This previews the daemon-served browser runtime. For only one half, use
`bun run dev:server` from the repo root or
`bun run dev:ui` for Vite. With no daemon up, the token dialog is as far as you
get; `#/gallery` is the one route that renders standalone, off
`src/lib/fixtures.ts`.

## The one-file rule

`bunx vite build` writes exactly one artifact to `web/ui-dist/`. Everything is
inlined — xterm.js, the Geist fonts, the favicon — because **the daemon serves
that file and nothing else**: there are no asset routes, and `wispd/tests/web.test.ts`
asserts both halves (a 404 on `/vendor/*`, and no `src=`/`href=` in the built
`<head>` except the `data:` favicon). That is what makes Wisp work over
tailscale with nothing else reachable, and it is a hard invariant (D1, D12).

`web/ui-dist/index.html` is deliberately **not committed**. Supported test,
development, Desktop, and release commands generate it before anything consumes
it. Tests compare the daemon-served bytes with that generated artifact, and the
Tauri configuration packages the same directory. There is no second desktop
bundle to update by hand. Tag CI builds one canonical copy, verifies its
checksum after transfer to the macOS runner, and packages those exact bytes in
both release products.

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

`main.tsx` selects one of two runtimes. The browser supplies one same-origin
`DaemonTransport`; Tauri bootstraps native connection metadata and supplies one
immutable proxy transport per connection. Components and hooks consume the
runtime transport and connection-scoped query keys rather than reading an
origin or globally unique task ID themselves.

Data flow uses TanStack Query for reads, a bridge from the daemon's
`/api/events` SSE stream for invalidation, and `useLogStream` for the live turn.
Provider PR state and the daemon-cached release status are the only polling
exceptions.

The Desktop Updates surface is app-global and deliberately does not follow the
active connection: its daemon query, forced check, install, error, and recovery
stay bound to the built-in `local` transport. Saved remotes have no Desktop
package-manager action. The browser runtime retains its one-daemon updater.

Writes use the centralized TanStack mutation hooks in `hooks/mutations.ts`;
feature hooks add only their local confirmation or refusal state. Keep that
boundary when adding a write rather than calling `api()` directly from a
component.

## The cross-client gate

Every shared UI change must identify its effect on both the browser and Tauri
runtimes. Preserve shared behavior by default; document and test any deliberate
runtime-only behavior. In particular, review auth, cache/storage scope, late
callbacks, SSE, WebSockets, media URLs, terminal ownership, and daemon update
recovery whenever a change touches them.

During iteration, run the root gate; it generates the shared artifact before
the tests that exercise it:

```sh
bun run check
```

Do not review or stage `web/ui-dist/index.html`. When the compiled boundary is
affected, build the binary from the generated artifact as a separate check:

```sh
bun run build
```

The root gate covers both workspaces: bundle generation, lint, typecheck, and
unit tests. The build proves the generated single-file application embeds in
the daemon. Release CI separately proves reproducibility and exact sharing
between daemon and Desktop artifacts; Git cleanliness is no longer a proxy for
either property.

Run `bun run desktop:check` when native code changes or when a daemon/UI change
affects rules the native core enforces: capability or identity negotiation,
authentication and headers, redirects, HTTP/SSE/WebSocket/media proxying,
connection metadata, credentials, folder picking, or Local setup. A generic
JSON route/type change still needs root and focused client tests, but Cargo adds
no coverage unless the native boundary changes.

Build with `bash scripts/desktop/build-macos.sh --app-only` and exercise the
same scenario in `bun run dev` and the app when work branches on Tauri, touches
connection/runtime/native integration, or qualifies a material shared flow for
release. A runtime-neutral style change does not need a Cargo or packaged-app
build, but it still requires an explicit browser/Desktop impact review.

For pixel checks, prefer `bun scripts/capture-app.ts [outdir]` (zero-dep, raw
CDP against system Chrome) over eyeballing a browser pane: it emits
deterministic desktop, mobile, and gallery PNGs.
