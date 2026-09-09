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

## Private HTTPS path: Tailscale Serve

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

Paste that token into the Wisp authentication screen once. The browser keeps
it in origin-scoped storage and sends it as a bearer token on every request,
stream, terminal socket, and image; nothing is authenticated by a cookie. Test
a harmless follow-up on a disposable task before relying on the connection.

If the proxy rewrites `Host`, the daemon cannot derive the browser's own origin
and will refuse terminal upgrades from it. Name the public origin explicitly:

```sh
WISP_ALLOWED_ORIGINS=https://wisp.your-tailnet.ts.net wisp serve
```

Wisp Desktop can use the same private HTTPS address. Click `+`, enter the Serve
URL and the token printed on the daemon host, confirm the authenticated daemon
identity, then enter remote project paths as they exist on that host. Saving a
desktop connection does not configure Tailscale or keep an unavailable route
alive.

Tailscale ACLs and device approval remain the access boundary. Wisp does not
interpret Tailscale identity headers and does not create separate Wisp users.
See the current
[Tailscale Serve documentation](https://tailscale.com/docs/reference/tailscale-cli/serve)
before applying this to a shared tailnet.

## SSH local forwarding

From the client machine:

```sh
# Replace 8710 if `wisp token` prints another host port.
WISP_HOST_PORT=8710
# Choose any unused port on this client.
WISP_LOCAL_PORT=18711
ssh -N -L "${WISP_LOCAL_PORT}:127.0.0.1:${WISP_HOST_PORT}" user@wisp-host
```

Keep that session open. For Wisp Desktop, click `+` and add the forwarded URL,
for example `http://127.0.0.1:18711`, with the token printed by `wisp token` on
the remote host. Exact-loopback HTTP is accepted because SSH supplies transport
encryption and host authentication; another hostname over plain HTTP is
refused. Enter project paths as they exist on the remote host.

For the browser UI, open the same forwarded URL and paste the remote token into
the authentication screen. The Wisp port stays loopback-only on both ends.
Closing Wisp Desktop or the browser does not stop the remote daemon or agents;
closing the SSH session only makes that connection temporarily unreachable.

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
