# Security

Wisp runs coding-agent CLIs with access to your repositories. Treat the daemon,
its web token, its task logs, and every configured harness credential as
security-sensitive.

## Supported versions

| Version | Security fixes |
|---|---|
| Current `0.4.0-alpha.x` | Best effort while the alpha is current; experimental Apple Silicon builds are not Developer ID signed or notarized |
| Earlier development versions | No |

There is no production-supported release yet.

## Trust model

- Wisp is a single-user, self-hosted tool. It has no account, tenant, or role
  boundary.
- A Wisp API token grants full control of the daemon, including the ability to
  launch coding agents and terminal shells. Do not share it.
- Built-in harness adapters run unattended turns with the harness's permission
  bypass. Isolation comes from a dedicated Git worktree, not from an OS
  sandbox.
- Repository code, `.wisp/setup.sh`, `.wisp/cleanup.sh`, configured project
  hooks, and copied allowlisted files are trusted operator inputs.
- Harness output may repeat source code, prompts, command output, or secrets.
  Wisp size-caps logs, but it does not make their contents non-sensitive.

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
   documented `Pepewitch/tap/wisp` Formula, verify the GitHub owner and
   checksum, and do not disable Gatekeeper globally. Developer ID signing and
   notarization remain mandatory before an Apple Silicon RC.

The browser exchanges the bearer token once for an HttpOnly, SameSite=Strict
cookie. Tokens in URL query parameters are not accepted. This protects browser
storage and history, but it is not a substitute for a private, encrypted
transport.

See [Remote access](docs/REMOTE-ACCESS.md) for supported access patterns.

## Reporting a vulnerability

Do not put an exploit, token, private log, or affected repository content in a
public issue. Use GitHub's private vulnerability-reporting flow:

<https://github.com/Pepewitch/wisp/security/advisories/new>

Include the affected Wisp version and commit, the exact platform/OS baseline,
impact, reproduction steps, and a redacted proof. Alpha response times are not
guaranteed.
