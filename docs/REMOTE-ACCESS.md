# Secure remote and phone access

Wisp's web UI can create tasks, run coding agents, open worktree shells, and
change repository content. Its token is therefore a remote-code-execution
credential in practice.

## Rules

- Keep Wisp on its configured `127.0.0.1:<port>` loopback bind. A new
  `WISP_HOME` initialization prefers port `8710`, but may persist another port
  if it is unavailable.
- Use an encrypted private mesh or an SSH tunnel.
- Never port-forward the configured Wisp port from a public router, publish it
  with Tailscale Funnel, or place it behind an unauthenticated public reverse
  proxy.
- Paste the output token from `wisp token` only into a Wisp page reached over
  the private path. Never put it in a URL, screenshot, issue, or shell log.
- Give tailnet access only to devices and people trusted to run code on the
  Wisp host.

## Phone path: Tailscale Serve

Install Tailscale on the Wisp host and phone, put both in the same tailnet, and
confirm the daemon is healthy locally. Run `wisp token` and note the port in
its URL. Then proxy that loopback service to an HTTPS tailnet URL. For example,
if Wisp printed `http://127.0.0.1:8710`:

```sh
tailscale serve --bg http://127.0.0.1:8710
tailscale serve status
```

Open the HTTPS URL printed by `tailscale serve status` on the phone. On the
host, run:

```sh
wisp token
```

Paste that token into the Wisp authentication screen once. The browser trades
it for an HttpOnly, SameSite=Strict cookie. Test a harmless follow-up on a
disposable task before relying on the connection.

Tailscale ACLs and device approval remain the access boundary. Wisp does not
interpret Tailscale identity headers and does not create separate Wisp users.
See the current
[Tailscale Serve documentation](https://tailscale.com/docs/reference/tailscale-cli/serve)
before applying this to a shared tailnet.

## Desktop path: SSH local forwarding

From the client machine:

```sh
# Replace 8710 if `wisp token` prints another host port.
WISP_HOST_PORT=8710
# Choose any unused port on this client.
WISP_LOCAL_PORT=18711
ssh -N -L "${WISP_LOCAL_PORT}:127.0.0.1:${WISP_HOST_PORT}" user@wisp-host
```

Keep that session open and browse to the chosen client URL, for example
<http://127.0.0.1:18711>. Use `wisp token` on the host to authenticate. The
Wisp port stays loopback-only on both ends; SSH provides transport encryption
and host authentication.

## Direct bind is not the supported shortcut

Changing `host` or `WISP_HOST` to `0.0.0.0` makes every network interface a
potential control surface. A bearer token does not provide TLS, user
separation, brute-force controls, or an audit boundary. Keep the loopback bind
and proxy it through a private transport instead.

If the page loads but API calls fail, verify the private proxy carries HTTP,
SSE, and WebSocket traffic and that `/api/health` is reachable at the URL
printed by `wisp token`.

When changing the configured port, update Tailscale Serve, SSH forwarding,
bookmarks, and any webhook consumer that stored the old local URL. Wisp never
changes an already persisted port silently.
