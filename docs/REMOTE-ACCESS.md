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

## If the token leaks

On the Wisp host, stop the daemon using the service manager or command that
normally starts it. Then rotate the token:

```sh
wisp token --rotate
```

The command securely replaces the token in `~/.wisp/config.json` and prints
the new value. It refuses to run while the daemon owns the Wisp home, preventing
token rotation from racing another config update.

Start the daemon again immediately. It loads the new token at startup, and the
old token no longer works. Every browser session and saved Desktop connection
must be updated with the new token. This invalidation is expected and is the
purpose of rotation.

## Private HTTPS path: Tailscale Serve

Install Tailscale on the Wisp host and phone, put both in the same tailnet, and
confirm the daemon is healthy locally. Run `wisp token` and note the port in
its URL. Then look at what this node already serves. A bare `tailscale serve`
takes the base path `/` of the node's HTTPS endpoint, so on a host that already
publishes something there — a dev server, a dashboard, another tool's UI — the
documented command below targets the handler that service occupies:

```sh
tailscale serve status
```

With `/` free, proxy the loopback service onto it. For example, if Wisp printed
`http://127.0.0.1:8710`:

```sh
tailscale serve --bg http://127.0.0.1:8710
tailscale serve status
```

With `/` already taken, give Wisp its own HTTPS port instead of replacing that
mapping:

```sh
tailscale serve --bg --https 8443 http://127.0.0.1:8710
```

Do not mount Wisp under a subpath (`tailscale serve --set-path /wisp`). Built
asset URLs are relative, but everything else about the app is rooted: the
browser runtime requests `/api/...`, the service worker registers at `/sw.js`
with scope `/`, and the web manifest declares `start_url` and `scope` of `/`.
Under a subpath those requests leave the mount and reach whatever owns `/`.

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
and will refuse terminal upgrades from it. Name the origin the browser actually
shows, which includes a non-default port:

```sh
WISP_ALLOWED_ORIGINS=https://wisp.your-tailnet.ts.net wisp serve
# the `--https 8443` mapping above is a different origin:
WISP_ALLOWED_ORIGINS=https://wisp.your-tailnet.ts.net:8443 wisp serve
```

The variable must be in the environment of the process that serves Wisp, so a
daemon started by a user service or a container supervisor needs it there and
not in your shell. `wisp doctor` reports what the running daemon actually
accepts, under `terminal origins`, and the daemon prints the same line at
startup.

The symptom of getting this wrong is narrow: the whole UI works, because every
other request authenticates by bearer token and ignores `Origin`, and only the
terminal pane fails to open. It now says why — the pane asks the daemon for the
reason after a refused handshake — and the daemon logs each refusal with the
rejected origin and the set it would have accepted.

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

## Install Wisp on your phone

Use the **HTTPS URL** printed by Tailscale Serve, at the root of the endpoint
you mapped Wisp onto. A plain HTTP tailnet IP can open the UI, but browsers
require a secure origin for full PWA installation and offline recovery. Wisp
does not require a public URL or an app-store download.

1. Connect the phone's Tailscale app and open the Wisp HTTPS URL.
2. On **iPhone or iPad**, open it in Safari, tap **Share → Add to Home Screen →
   Add**. If Safari offers **Open as Web App**, keep it enabled.
3. On **Android**, use **Settings → Install Wisp** when available, or Chrome's
   **Install app / Add to Home Screen** menu item.
4. Open the new Wisp icon. If the installed app asks for your token again,
   paste the output of `wisp token`; browsers may keep home-screen storage
   separate from the browser tab.

The app opens in its own window with the Wisp icon, follows your chosen Wisp
theme, and leaves room for the notch, home indicator, and keyboard. Settings
also includes installation instructions for the current browser. Keep
Tailscale connected while working; home-screen installation does not run the
VPN or start the remote daemon.

When you return to Wisp, browser event streams reconnect and refresh daemon
state. If the server cannot be reached when launching, an installed service
worker shows a recovery screen with **Try again**, retries on return/network
recovery and periodically while visible. The first visit still needs a working
connection to install that worker. Remote work continues while your phone is
disconnected, provided the server and daemon are running.

The PWA does not save task responses, logs, images, credentials, or the app
bundle in Cache Storage, and does not queue commands offline. Existing
origin-scoped token and draft storage works as before. New launches fetch the
current UI from the daemon; worker updates do not reload an open conversation.

See [browser installation support](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)
for platform requirements.

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
