# `wisp capture`

`wisp capture` takes a screenshot of an app running on this machine. Wisp opens
the page in its own headless Chrome and keeps the shot in the running turn's
images. It records what it saw, and gives the agent a file to look at. It works
the same from every harness: the agent runs one command, and no harness has to
know how to drive a browser.

```sh
wisp capture http://127.0.0.1:$PORT/settings --area web
wisp capture http://127.0.0.1:$PORT/ --script open-dialog.js --viewport mobile --dark
```

| Flag | What it does |
| --- | --- |
| `--area <name>` | the recipe area the shot shows (auto-review's evidence rule counts it there) |
| `--viewport desktop\|mobile\|<w>x<h>` | 1280×900 by default. Mobile is 390×844 with touch and a phone user agent |
| `--dark` | `prefers-color-scheme: dark` |
| `--selector <css>` | shoot one element instead of the viewport |
| `--full-page` | the whole page, cut to the size limits |
| `--wait-for <css>`, `--wait <ms>` | the state to wait for before the shot (after the script, when there is one) |
| `--script <file.js>` | JavaScript run in the page after it loads, awaited, for up to 10 s: click a tab, fill a form, open a dialog |
| `--allow-port <n>` | another local port the page may use (an API beside the app) |
| `--name <label>`, `--json` | the stored image's name; machine-readable output |

It runs inside a task's turn. It reads the task from `WISP_TASK_ID`, and Wisp
stores the image in that task's running turn. The command prints:
- a copy of the image with a `.png` or `.jpg` extension under
  `$TMPDIR/wisp-captures/<task>/`, which any harness's file or image tool can open;
- the final URL and HTTP status;
- where the page was served from;
- any page errors and blocked requests.

## What a capture proves, and what it does not

A capture proves that **Wisp** took these pixels from that URL at that moment.
The agent does not supply the bytes, and the metadata is Wisp's own. It does
**not** prove the app works: whether the page shows the change is still the
reviewer's judgement.

Wisp records every attempt, failed ones included, with a reason:
- `no-chrome`
- `launch-failed`
- `unreachable`
- `http-error`
- `timeout`
- `script-error`
- `busy`
- `browser-error`

A page that fails to load, answers 4xx/5xx, or lands on Chrome's error page is
never stored as an image.

**Served from.** For each capture, Wisp looks up the process listening on the
page's port. If that process runs inside the capturing task's worktree, the
capture is `worktree`. If not, it is `elsewhere`: for example a dev server the
author left running, or one an earlier task left on a reused port. When Wisp
cannot tell, it is `unknown`. Only `worktree` captures count toward
auto-review's evidence rule.

## The boundary

The agent already holds a shell and Wisp's token, so `wisp capture` is not a
boundary against the agent. It keeps three things safe:

1. **Acquisition.** Wisp produces the image and its record.
2. **The network around the page.** The app under review, or anything it
   loads, cannot use the daemon's browser to reach your LAN, link-local or
   cloud-metadata addresses, other local services, or Wisp itself. All of the
   browser's traffic goes through a proxy Wisp runs for that one capture,
   loopback included: frames, workers, service workers, popups, WebSockets and
   redirects. The proxy:
   - allows the page's own port, the task's port range, and `--allow-port`
     ports on loopback, and never Wisp's own port;
   - refuses private and reserved ranges;
   - allows public hosts (fonts, CDNs) unless a project sets
     `capturePublic: false`.

   It resolves a name itself and connects to the address it checked, so DNS
   rebinding gains nothing.
3. **Browser state.** Every capture starts a fresh Chrome profile under
   `~/.wisp/browser/` and deletes it afterwards. Wisp keeps no cookies or logins
   between captures; a `--script` can log in within one capture. A daemon that
   died mid-capture kills its leftover Chrome on its next start.

Only `http` and `https` pages on `localhost`, `*.localhost`, `127.0.0.0/8` and
`[::1]` can be opened. To capture a static build, serve it on 127.0.0.1;
`file://` is refused. URLs are stored without a user name or password, with
every query value replaced by `*`, and without a fragment that looks like a
credential.

## Limits

- At most 2 captures at once across Wisp, 1 per task; others wait up to 60 s.
- Chrome gets 60 s to start; the page, script and shot get 45 s together.
- A shot is at most 7680 px on a side and 5 MiB. It is a PNG when that fits,
  and otherwise a JPEG. These limits let a shot reach any harness as an
  attachment.
- A page may open at most 8 tabs; downloads are refused.

## Chrome

Wisp uses `chromePath` in `config.json`, else `CHROME_PATH`, else the first of
Chrome, Chromium, Edge or Brave in their usual places (on Linux, on `PATH`).

It refuses three setups:
- a snap build, which cannot use profiles under `~/.wisp`;
- running as root, where Chrome refuses its sandbox (Wisp never turns the
  sandbox off);
- a machine with no browser at all.

`wisp doctor` says which Chrome Wisp found, or why there is none. Without one,
`wisp capture` records `no-chrome`. Agents then publish images they made
themselves with `wisp output add`, and a reviewer can waive a required
screenshot (see [Auto-review](AUTO-REVIEW.md)).

## Ports

Reviewer and recipe tasks get `PORT` and `WISP_PORT_RANGE`: ten ports from
`20000 + slot × 10`, below Linux's ephemeral range. This lets reviewers run
side by side without fighting over :3000. These ports are a preference, not a
reservation: an agent checks that a port is free and stays inside its range.
Author tasks do not get them, since an app that reads `PORT` would change its
behaviour.
