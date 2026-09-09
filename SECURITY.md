# Security

Wisp runs coding-agent CLIs with access to your repositories. Treat the daemon,
its access token, desktop connection credentials, task logs, and every
configured harness credential as security-sensitive.

## Supported versions

| Version | Security fixes |
|---|---|
| Current `0.4.0-alpha.x` | Best effort while the alpha is current; public Desktop alpha.17 is Developer ID signed, notarized, stapled, and updater-signed |
| Earlier development versions | No |

There is no production-supported release yet.

## Trust model

- Wisp is a single-user, self-hosted tool. It has no account, tenant, or role
  boundary.
- A Wisp API token grants full control of the daemon, including the ability to
  launch coding agents and terminal shells and to install a published Wisp
  update on a recognized managed installation. Do not share it.
- Built-in harness adapters run unattended turns with the harness's permission
  bypass. Isolation comes from a dedicated Git worktree, not from an OS
  sandbox.
- Repository code, `.wisp/setup.sh`, `.wisp/cleanup.sh`, configured project
  hooks, and copied allowlisted files are trusted operator inputs.
- Harness output may repeat source code, prompts, command output, or secrets.
  Wisp size-caps logs, but it does not make their contents non-sensitive.
- Stopping a turn signals the process group Wisp owns. That reaches the
  builds, servers, and sub-agents a harness started; it does not reach a
  descendant that deliberately left the group by calling `setsid`, and Wisp
  does not walk the process tree to hunt one down, because that races pid
  reuse. Group membership and PID/start-time identities are persisted across
  turns and daemon restarts, bound to the host's boot identity so Linux start
  ticks cannot be reused across reboots. A matching living member is required to recover
  ownership; uncertain ownership blocks signalling and workspace deletion.
  The indicator describes tracked groups, not every process on the machine.
- The worktree file viewer (`GET /api/tasks/:id/file`) checks the requested
  path against the worktree and then FOLLOWS symlinks, so a symlink inside a
  worktree can display a file outside it. Under the trust model above — a
  full-control token and operator-trusted repository contents — that is not a
  privilege boundary being crossed, but it does mean the viewer is not a
  containment guarantee. Do not treat it as one, and do not reuse its path
  check as a sandbox.

## Safe deployment

1. Keep the daemon on its configured `127.0.0.1` loopback bind.
2. Reach it through a private mesh proxy or an SSH tunnel. Never publish port
   `8710`, or any replacement Wisp port, directly to the internet.
3. Keep `~/.wisp` private. Wisp creates it as mode `0700` and repairs
   `config.json`, which contains the API token, to mode `0600`.
4. Put only files a task truly needs in a project's copy allowlist. A copied
   `.env` becomes readable by that task's harness.
5. Use separate, revocable harness credentials with the smallest practical
   scope and spend limit for automated or evaluation runs.
6. Review task branches before merging or pushing them.
7. For the experimental Apple Silicon alpha, install only through the
   documented `Pepewitch/tap/wisp` Formula or `wisp-desktop` Cask, verify the
   GitHub owner and checksum, and do not disable Gatekeeper globally. Current
   Desktop tag releases require Developer ID signing, notarization, stapling,
   and updater-signature verification before immutable publication, followed
   by anonymous public-byte verification before channel promotion.

The update API accepts only a newer release returned by the fixed
`Pepewitch/wisp` GitHub endpoint. Linux activation verifies the published
manifest, artifact hash, and embedded build identity. macOS delegates
installation and checksum verification to Homebrew. Neither path accepts a
caller-provided URL or uses `sudo`.

The browser keeps the bearer token in its origin-scoped `localStorage` and
sends it explicitly on every hop: API requests, the event streams (served over
`fetch` rather than `EventSource`, which cannot set a header), the terminal
socket (whose first frame carries the token, because a WebSocket handshake
cannot set one either), and attachment media (fetched, then rendered from a
blob URL). Nothing is authenticated ambiently.

Releases before 0.4 also minted an HttpOnly `wisp_token` cookie whose value was
the root token. Cookies are scoped to host and path, never to port
(RFC 6265 §8.5), so any other HTTP service on the same host — a development
server, something behind a local tunnel — received a full-control credential in
its `Cookie` header. That exchange is gone; an upgraded daemon expires the old
cookie the next time a browser authenticates, and no cookie authenticates a
request. If a browser used an affected release on a host that also ran
untrusted HTTP services, rotate the token (`wisp token --rotate`, then restart
the daemon).

A terminal upgrade is command execution, so it is also origin-checked: the
daemon refuses a handshake whose `Origin` is not its own, another port on the
same host included. Set `WISP_ALLOWED_ORIGINS` when a reverse proxy rewrites
`Host` and the daemon therefore cannot derive the browser's origin itself.

Tokens in URL query parameters are not accepted. Treat any script running in
the Wisp origin as able to read the bearer token; the self-contained bundle and
private encrypted transport remain part of the security boundary.

The daemon-served page carries a content security policy built from the bundle
it is serving: `default-src 'none'`, the inline script's own sha256 hash (never
`'unsafe-inline'` for scripts), `frame-ancestors 'none'` alongside
`X-Frame-Options: DENY`, `object-src`/`base-uri`/`form-action` at `'none'`, and
`Referrer-Policy: no-referrer`. `style-src` keeps `'unsafe-inline'` because
xterm creates stylesheets after load, so it deliberately carries no hash — a
hash would disable the allowance the terminal depends on.

Agent-supplied remote images are placeholders until the reader explicitly
chooses **Load image** for that URL. The destination and disclosure consequence
are shown first, and changing the URL resets consent. This applies to internet,
loopback, and internal-network URLs in both browser and Desktop. Consented images
use `referrerPolicy="no-referrer"`; static image CSP permits their HTTP(S)
requests. Wisp does not proxy arbitrary image URLs through the daemon.

Attachment blob caches are scoped by connection and path. Task/message changes,
reconnection, and browser credential changes invalidate affected entries and
prevent old pending responses from repopulating them. Unmounted entries are
evicted to targets of 32 images and 64 MiB; visible images remain pinned until
released. This clears Wisp's display/cache, not screenshots, downloads, or copies
made by older versions or other applications.

Attachment responses are `Cache-Control: private, no-store`. Permanent deletion and message cancellation
remove bytes, and a long-lived cache entry meant a browser kept serving them
from its own profile after the daemon began answering 410.

Wisp Desktop keeps remote tokens in the macOS Keychain and reads Local's token
from the standard Wisp profile into native process memory. The webview receives
neither. Its native proxy is bound to loopback, requires a per-launch
capability, resolves immutable connection routes from native metadata, strips
cookies, refuses redirects, verifies TLS, and overwrites upstream
Authorization. Plain HTTP remotes are accepted only on an exact loopback
address for a user-managed tunnel. Removing a remote revokes its route before
removing it from the active registry, then attempts Keychain deletion. A
failure is reported and retained as a cleanup tombstone for **Reset desktop
data** or the next launch to retry. It never deletes daemon data.
See [Desktop transport contract](docs/DESKTOP-TRANSPORT.md) for the complete
boundary.

Desktop application updates use a native-owned fixed channel and embedded
public key. The webview cannot choose the endpoint, artifact URL, signature,
key, download path, or installation path. Release automation verifies the
updater signature independently, rechecks Developer ID and notarization after
archiving, and advances the channel in a separate resumable promotion job only
after the public bytes pass anonymous verification. Homebrew remains the
bootstrap and recovery installer. See
[Desktop updates](docs/DESKTOP-UPDATES.md).

See [Remote access](docs/REMOTE-ACCESS.md) for supported access patterns.

## Reporting a vulnerability

Do not put an exploit, token, private log, or affected repository content in a
public issue. Use GitHub's private vulnerability-reporting flow:

<https://github.com/Pepewitch/wisp/security/advisories/new>

Include the affected Wisp version and commit, the exact platform/OS baseline,
impact, reproduction steps, and a redacted proof. Alpha response times are not
guaranteed.
