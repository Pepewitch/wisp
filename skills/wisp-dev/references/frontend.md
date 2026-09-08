# Wisp frontend conventions

`web/ui/` is the one shared React app (Vite + React + TypeScript + Tailwind v4
+ shadcn on base-ui primitives). The daemon serves it in a browser and Tauri
packages it for Wisp Desktop. It is the only one: the classic `web/index.html`,
the abandoned first rewrite in `web/app/`, and the vendored xterm in
`web/vendor/` were all deleted at the v0.2 cutover (D12). The daemon serves
this app's generated bundle at `/` and Tauri packages the same bytes.
`web/ui-dist/` is a Git-ignored build directory: use the supported commands to
generate it, and never edit, stage, or commit it.

## 0. Two shipped runtimes

Every UI change must classify its impact on both clients:

- The browser runtime represents one implicit same-origin daemon and owns its
  token-to-cookie session flow.
- The desktop runtime represents Local plus saved remotes. Native code owns
  targets and credentials; React receives immutable, connection-qualified
  `DaemonTransport` instances.
- Shared components and hooks use `useDaemonRuntime()` and its pre-bound query
  keys. They do not import the browser transport, derive daemon URLs from
  `window.location`, or treat a task ID as globally unique.
- The exported `qk` in `lib/query.ts` is Local-only compatibility for legacy
  tests. Product code never imports it; use `useDaemonRuntime().qk`, or
  `createConnectionQueryKeys(connectionId)` in connection-explicit test
  infrastructure.
- Daemon-owned state, drafts, attachments, preferences, streams, terminals,
  daemon updates, and late async callbacks stay bound to their initiating
  `connectionId`. Pure layout and theme state may remain global.
- The Desktop application updater is deliberately global. Render it separately
  from the selected connection's daemon updater, name both actions, and retain
  the initiating connection for any daemon operation across tab changes. See
  [`docs/DESKTOP-UPDATES.md`](../../../docs/DESKTOP-UPDATES.md).
- Browser-only auth and native-only connection/folder-picker/setup behavior
  stay behind their runtime boundaries. Any intentional difference is named in
  the change and covered without regressing the other client.
- Styling is only runtime-neutral when it ships **in the bundle**. The daemon
  serves the page with no CSP; the packaged app has one, so anything that
  reaches the DOM as a `<style>` element created after load — the terminal
  pane, and xterm's own renderer — depends on the desktop policy keeping
  inline stylesheets allowed. See `desktop/README.md`; a blocked stylesheet
  renders wrong rather than failing, so it is invisible to the browser gate.

Every shared UI PR gets the root/UI source gate, which generates the bundle it
exercises, and an explicit browser/Desktop impact note with evidence for both
runtimes. A browser screenshot is not Desktop evidence when CSP, native chrome,
window sizing, proxying, or a Tauri branch can change the result. Run
`bun run desktop:check` when native code or an
enforced native transport/connection contract is affected. Build with
`bash scripts/desktop/build-macos.sh --app-only` and exercise both clients when
the change branches on Tauri, touches connection/runtime/native integration,
or qualifies a material shared flow for release. Runtime-neutral styling does
not need Cargo or a packaged-app build. See
[Architecture](../../../docs/ARCHITECTURE.md) for the impact matrix and
`web/ui/README.md` for the exact generated-bundle sequence.

This file is the law. `#/gallery` is the law rendered on real components — when
you add a primitive, add its gallery entry in the same diff. An undocumented
primitive is an incomplete change.

Every value below is in `web/ui/src/index.css`. Read it once; then never write
a hex in a component again.

---

## 1. Colour budget — the five places

The theme is a neutral scale (never `#000`, no cast on the grays — and never
`#fff` for a *page* surface; light's floating ones are the one exception, see
below), a four-level gray text hierarchy, and **one** violet at hue 300:
`oklch(0.705 0.155 300)` = `#AF87F1` on graphite, `oklch(0.5 0.19 300)` on
paper. Every accent shade is derived from that hue at fixed lightness and
chroma *within its theme*, so moving the hue moves the family without touching
contrast.

The accent appears in exactly five places:

1. the **running** state dot (with its `--accent-wash` halo)
2. the **one primary action** on a screen — `<Button tone="primary">`, and never
   two at once
3. the **send** button in the steer box
4. the **focus ring**
5. **inline code** in agent prose

Selection and active tabs are a **background change** — `bg-accent`. They never
take the hue. If a sixth accent appears, one of the five was not load-bearing.

Semantic hue survives in three more places and nowhere else:

- **state dots** — `--color-state-*`, on 6px dots only
- **diff add/del** — `--color-diff-*`, text and 10% row tints
- **destructive/error** — `--destructive`, for real failures only

`failed` and `needs-input` are the only two states allowed to tint their own
line of *text*, because they are the only two a person has to act on. Every
other state line is `text-muted-foreground`.

### The transcript's one brightest surface is the prompt bubble

With no hue to spend, the stream separates the person's words from the agent's
by *lightness alone*, so only one surface in a turn may be the lightest: the
right-aligned prompt bubble, `--card`. A code block used to share that fill and
the two became one shape when scanning for "where did I say something", so code
blocks have their own surface — `--code` (`#101014`), one step above the reading
column rather than four. Anything new inside a turn recedes toward `--background`;
it never meets or passes `--card`.

### Two themes, and every token paired

Wisp ships **dark** and **light**, and the switch is `System` / `Light` /
`Dark` in **Wisp settings** (§5g), under `Appearance`.

- **Dark is the default**, not the OS's answer. It is what `:root` paints and
  what `index.html` already carries, so an update repaints nobody's window and
  an unclassed subtree still looks like the app. `System` is opt-in.
- The preference is **client-local and global**: `lib/theme.ts`, one
  `wisp_theme` key, a tiny external store. It is deliberately NOT
  connection-scoped — theme is not daemon state, and switching connection tabs
  must not switch the theme. `useTheme()` for what is on screen,
  `useThemePreference()` for what a person chose.
- One key shared by two browser tabs means the store listens for `storage`
  too, so a change in one tab lands in the other without a reload. `system` is
  likewise a LIVE `matchMedia` query, not a value read once at startup — macOS
  changes appearance at sunset and the packaged webview follows it.
- `lib/theme.ts` writes `light` or `dark` on `<html>` and **nowhere else**.
  The light block is `:root.light`, not `.light`: `:root` and a bare class have
  equal specificity, so a plain class would leave the pairing to be settled by
  whichever block a later edit moved last.
- **`color-scheme` is load-bearing**, and it is told twice on purpose. The
  platform's own overlay scrollbar, caret and default form controls take their
  colour from it; without it the packaged Mac app flashed a **white scrollbar**
  over the reading column on hover whenever macOS was in light appearance — a
  native control painting in a theme the app never declared. The CSS property
  in the token blocks is the authority, and the `<meta name="color-scheme">` in
  `index.html` is what answers BEFORE it: the bundle is one file whose
  `<style>` follows a 1.8 MB inlined module, so the meta covers the parse.
  `applyTheme` rewrites both the meta and `theme-color` from one place, so they
  can never disagree with the class. `scroll-slim` still sets
  `scrollbar-color` from tokens; all of it is needed.
- **Light is not an inversion.** Dark stacks every surface UP from the reading
  column; white is a ceiling, so light sends page surfaces DOWN into gray while
  the surfaces that FLOAT — menus, hover cards, the palette — stay `#fff` and
  earn depth from a shadow. That `#fff` is the **only** licensed one, and it is
  licensed *because* it floats: a page surface reaching white would leave
  nothing above it, which is the same argument as never using `#000` on
  graphite. `TERMINAL_THEME.light.background` is the same exception — a
  terminal is a hole in the app, so it takes the extreme its theme allows. What is preserved is the ordering that carries
  meaning: the prompt bubble is still the surface furthest from the background
  inside a turn, code still sits between the two, row hover is still stronger
  than a resting card, selection is still the strongest neutral, and the four
  text levels hold the same contrast ratios they held on graphite.
- **A colour that needs both themes is a token pair, never a `dark:`
  utility.** Every family is paired: surfaces, text, the accent, the six state
  dots, diff add/del, destructive, the three elevations, and the modal veil.
  Three values that used to be hand-copied are now tokens because a pair is
  impossible otherwise — `bg-scrim` (thirteen hand-picked `bg-black/60`s, three
  of them at other alphas), `hover:bg-primary-hover` and
  `hover:bg-destructive-hover` (`brightness-110` walks a light-mode violet up
  into its own white label).
- **One licensed exception.** xterm paints to a canvas and takes JS colours, so
  `TERMINAL_THEME` in `components/terminal-pane.tsx` holds both scales as hex
  and follows the store. A theme switch repaints the live terminal in place;
  it never rebuilds one, because that would drop a running shell's scrollback.

## 2. The chip ban

No outlined pills or badges for status — not task states, not git facts, not
connection state, not counts. Status is a **dot plus muted text**: the dot
carries the hue, the words stay gray. No tinted or boxed prompt blocks either.

The anti-pattern is rendered in the gallery under *The shape to delete on
sight*. Five chips, four hues, three lines of metadata: every fact present and
none of them readable.

## 3. Case

Sentence case for anything Wisp wrote: `Changes`, `Show archived`,
`Needs input`, `Stop turn`. Lowercase survives only where it is **literal
data** — `droid`, `kimi-k3`, `wisp/t5qmha-…`, `needs-input` in a payload, a log
line, a palette command. Uppercase is reserved for the one `Eyebrow` per pane.

### The product is `Wisp`; the command is `wisp`

The same rule, applied to our own name. **Wisp** is the product: the header, the
page title, the README, anything the app says about itself. **`wisp`** stays
lowercase wherever it is literal data a person types or a machine reads — the
CLI (`wisp serve`), the config directory (`~/.wisp`), the branch prefix
(`wisp/t5qmha-…`), the cookie (`wisp_token`), the package name, and every path.

The test: could you paste it into a shell or a config file? Then it is lowercase.
Is it the name of the thing? Then it is `Wisp`.

`STATE_LABEL` in `web/ui/src/lib/state.ts` is the only place a state's display
name lives. Never render `task.state` directly in chrome.

## 4. Typography

Geist Sans (`font-sans`) and Geist Mono (`font-mono`), bundled from the
fontsource variable packages — zero CDN, OFL 1.1 text in `web/ui/licenses/`.
No third face, ever.

| Size | Weight | Use |
|---|---|---|
| 22 / −1.8% | 600 | page titles only |
| 14.5 / −1% | 600 | task header |
| 13 / 1.7 (~22px) | 400 | agent prose — long-form reading at the widest measure in the app |
| 12.5 | 500 | list rows, buttons, tabs |
| 11.5 | 400 | one metadata line, never two |
| 10.5 / +7.5% caps | 600 | the one eyebrow per pane |
| mono 11.5 | 400 | paths, ids, branches, diff rows |
| mono 11 / 1.75 | 400 | step output, terminal |

Mono means *a machine wrote this exact string*. It is not a texture to reach for
when a line should look technical.

## 5. The scroll contract

The centre column is ONE conversation — prompt, the tool calls it made, then the
result — not a raw stream pane stacked on a chat pane. Five rules:

1. **One scroller owns the whole task.** No per-turn clamp, no nested
   `overflow`, no separate stream pane. `GET /api/tasks/:id` already returns
   every turn, so scrolling from turn 7 back to turn 1 costs nothing. Do not
   paginate turns.
2. **Activity rows render as summary lines only.** The live stream retains
   only its current turn. A settled turn's structured activity is fetched when
   someone chooses **Show activity**, its SSE closes at `turn-end`, and the
   body is dropped on **Hide activity** or task switch. Logs cap at
   `turnTranscriptBytes` (5 MB default) **per turn**, and the live reducer also
   keeps a bounded visible tail with an explicit omission marker. Eagerly
   retaining every settled body does not slow the tab down, it kills it.
3. **The live turn appends into the same list.** `overflow-anchor: auto` plus a
   60px pin threshold; a group expanding above the viewport compensates
   `scrollTop` by the height delta so the reader's line stays put.
4. **Raw format replaces the pane.** It never interleaves with the chat.
5. **A steer belongs to the turn's order, not to its prompt.** A message
   accepted by a RUNNING turn is an event inside it, so the daemon writes one
   plain-text marker (`· steer <message id>: …`) to that turn's log at native
   admission — same fd as the harness's own output, so the position is the
   harness's order rather than the browser's arrival order, and a reload, a
   second tab and a settled turn's refetch all rebuild it. The activity
   projection turns that marker into a `message` event keyed by the message
   id; the conversation splits the timeline there and renders the bubble
   immediately before whatever the harness did next. Never reorder by render
   time. A message the timeline cannot place — an older log with no marker, or
   a settled turn whose activity is not on screen — falls back to the head of
   the turn rather than disappearing, and the message ROW still decides what
   the bubble says: a still-queued or cancelled message keeps its own
   queued-for-the-next-turn wording no matter what the log anchored.

There is no `Turn N` rule between turns. The right-aligned prompt bubble is the
boundary, and the gap carries the rhythm: 30px above a bubble, 16px inside a
turn.

### The bubble holds the words; its caption and its controls hang off it

`PersonBubble` in `components/person-bubble.tsx` is the ONE shape for anything
the person said — a turn's prompt, a steer, a queued message — and it holds
their words. Everything about the bubble rather than in it hangs off it, split
by KIND rather than by convenience:

- the **caption** states FACTS — what this bubble is, and when it was sent. One
  muted register, in the gutter to the bubble's left, on its bottom edge.
- the **actions** ACT on it — copy, and a queued message's edit and cancel. One
  small floating toolbar wholly above the bubble's top-right corner, revealed
  by a pointer.

**Nothing else is ever inside a bubble.** Not the queued bubble's four-way
delivery status, not the two delivery-uncertain notes: they are facts, so they
go in the caption with every other fact. A line inside is what made the queued
bubble look unlike its neighbours. The one exception is a bubble being EDITED,
which is a form (below).

Because a delivery state is a SENTENCE and not a label, the caption wraps
within itself as well as onto its own line — `flex-wrap`, `max-w-full`,
`text-right`.

The toolbar is **in-pane chrome, not a popup**: no padding of its own,
`border-border`, and `shadow-float` — the lightest of the three depths, the one
documented for in-pane surfaces. At `POPOVER_SURFACE`'s `shadow-popover` a 22px
box outweighed the 12.5px message it belonged to.

The toolbar sits **clear of the top edge** (`bottom-full`), not straddling it.
Straddling reads better until a three-control toolbar meets a one-line bubble,
and then it sits on the words; 2px clear can never do that, whatever the
toolbar grows to hold. Hover still carries across the gap, because the toolbar
is a DOM child of the bubble.

**`pointer:` is the variant that makes hover-reveal safe** (`index.css`).
Tailwind's own `hover:` is already `@media (hover: hover)`, so a bare
`opacity-0 group-hover:opacity-100` leaves the control hidden and unreachable
FOREVER on touch — §6b's rule, broken silently. Pair them —
`pointer:opacity-0 pointer:group-hover/…:opacity-100` — so the resting state is
only hidden where a pointer exists to bring it back, and add
`pointer:group-focus-within/…:opacity-100` so a keyboard can reach it too.

Inside, that chrome was a right-aligned row under left-aligned prose — two
alignments in one box, so the bubble read lopsided, and a line plus its gap
turned the bottom third of a short bubble into padding. Outside, it costs
**nothing**: the bubble is capped at 76%, so the 24% beside it was already
empty.

`flex-row-reverse` + `flex-wrap` is the whole responsive story, and there is no
breakpoint to keep in sync. Reversed, the bubble is the first item and sits at
the right edge with its caption to the left; when the two no longer fit — a
phone, or the exact UTC instant, which is twice as wide as `5 min ago` — the
caption wraps to its own line beneath, still right-aligned, rather than
squeezing the words. Never add a second layout for the narrow case.

What the caption carries, and nothing else:

- **when it was sent**, for anything actually sent: a prompt bubble from the
  turn's `started_at`, a steer from the message's `created_at`. Relative by
  default, because "5 min ago" is the fact you want while a task is live, and
  **one click swaps that bubble alone** to the exact UTC instant in mono — the
  form you paste into a log search. The toggle is per bubble and never
  persists: asking when one message was sent is a question, not a mode.
- **`sent mid-turn`**, on a steer. Two words, and they are load-bearing rather
  than decoration: a settled turn renders with its activity collapsed, so every
  steer in it falls back to the head of the turn and lands directly under the
  prompt bubble. Without the word, two right-aligned cards sit there with only
  12px against 30px of gap to say which one started the turn. It was a line
  INSIDE the bubble and made every steer a row taller for a fact that fits in
  space already going spare.
- **where the delivery stands**, on a queued one, in place of a time: it has
  not been sent, so there is no time to state. `queued for the next turn`, or
  the archived / cancelled / retry-uncertain wording the state calls for.

What the toolbar carries: **copy**, on every bubble, and **edit and cancel** on
a queued one. While a queued bubble is being EDITED it is a form, so `Save` and
`Cancel` appear inside it and the toolbar disappears: a form owns its own
commit, and only a form puts controls in a bubble.

`lib/time.ts` is the app's ONE relative clock — dayjs for the arithmetic,
Wisp's own terse vocabulary for the words (`just now`, `5 min ago`, `3h ago`,
`2d ago`), and thresholds that FLOOR so 90 minutes is never read back as
"2h ago". `since()` in `lib/state.ts` is that same function, so a sidebar row
and a prompt bubble can never disagree. Never hand-roll a second one.

The stream starts at byte zero. Its first read is budgeted to 1 MB so opening a
large turn does not block the first frame; subsequent 256 KB reads continue
progressively with one offset, no gaps and no overlap.

## 5b. Activity rows, and what the adapters actually give you

The web conversation consumes `format=activity`, a structured projection made
by the adapter's named `activity` strategy. It never reparses `wisp log`'s
human text. Canonical events preserve tool ids, subagent ids, parent ids,
lifecycle, arguments and failures; raw JSONL remains the evidence ledger.
`EVENT_FORMATTERS` still own the intentionally compact CLI output.

The adapter boundary is the only place harness wire shapes may appear. A new
harness either reuses an `ACTIVITY_NORMALIZERS` key or adds one there. The
reducer and components receive the same `ActivityEvent` union regardless.
Unknown/custom adapters degrade to unstructured human prose, never leaked JSON
and never a fabricated lifecycle.

`web/ui/src/lib/activity.ts`'s `summarizeStep()` owns the one tool input worth
reading (`file_path` → `path` → `command` → `pattern` → …). A row that shows an
unreadable argument object instead of its useful path or command is a bug.

The right edge of an activity row carries **one short fact** ("ok",
"7 passed", "wrote 5 lines") and nothing else. Real results are arbitrary
prose, so only a result of 24 characters or fewer earns the slot; everything
longer lives behind the chevron. Never put a line count there — it is not a
fact anybody wanted.

Subagents are one compact two-line card across every harness: bot, assignment,
role/effort/model, state dot + word, then chevron. They start collapsed and
never open or close themselves as status changes. Expansion keeps the harness
order of prose, thinking, tools and nested children; parallel children are
siblings correlated by stable ids, never guessed from adjacency. Failed is
visible while collapsed and the exact issue sits inside. If a harness reports
only spawn/result, the card says so honestly rather than inventing a child
transcript. There is no nested scroller.

## 5c. The composer

The create modal is a composer, not a form: one prompt box with a quiet
control bar under it. Project, harness·model and effort are decisions you make
rarely, so they are dropdowns in that bar — never a stack of labelled fields
above the prompt, which buries the one thing you came to type.

Five contract rules the modal must keep:

- **Never hardcode a model id or effort value *in the UI*.** Options come from
  `GET /api/harnesses`; the harness→model dropdown is ONE control, grouped by
  harness. A harness with no usable list falls back to a free-text model input
  and surfaces `modelsError` as a note in the menu.
- **The one exception lives in the adapter, never here.** `claude-code`
  enumerates no models and validates no `--model` string, so
  `AdapterDef.staticModels` carries a curated list for it (verified against
  2.1.258) and the daemon serves that under the same shape as a probe. A real
  probe always wins. The exception is claude's alone and must not spread — any
  harness that *can* be asked keeps `modelDiscovery`.
- **Every create sends an explicit model** (wisp policy). Submit is blocked
  rather than letting a silent default through. Aliases like `opus`/`sonnet`
  are deliberately absent from the list: an alias re-points at whatever is
  newest, which is the opposite of explicit.
- **Effort is a pick, from levels the harness itself named.** Per-harness
  discovery is no longer parked: each adapter declares `effortLevels`, read off
  its own CLI (droid prints them when handed a bad one, claude documents them
  in `--help`, codex's API names them in its rejection). The lists genuinely
  differ — droid alone has `dynamic`/`off`, claude alone lacks `none`/`minimal`
  — so there is no shared ladder and never should be. A level used here that
  the harness did not declare stays offered, so a stale list cannot hide a
  value that works, and Custom remains for anything new. The control renders
  only when the harness has an effort template.
- **The opening selection uses the active connection's preferred model when available**,
  then prefers a harness that has a model list, so a daemon whose first harness
  has no installed binary does not open the composer already in the free-text
  fallback. Every model row has a star: setting or clearing it affects future
  create dialogs only, never the selection in the dialog already open. The
  preference is client-local and connection-scoped; a missing or retired model
  falls back normally.

The **suffix prompt** picker is shared by create and steer. It starts at **No
suffix prompt**, lists the daemon-wide records in
`~/.wisp/suffix-prompts.json`, and keeps **Create a new prompt** as its last
row. Creation is a nested dialog: opening it closes the picker menu and puts a
scrim between it and the composer underneath; saving selects the new record
without closing that composer. Its own `⌘↵` must never leak into the create
task form.

Every saved row manages itself with two quiet icon buttons. The pencil
reopens the same nested dialog prefilled, and saving an edit keeps the
record's id, so a composer already pointing at it never loses its selection.
The trash is a two-click inline confirm — the first click only arms the row's
red **Delete?**, the second removes the record — and deleting the SELECTED
prompt drops the composer back to none rather than leaving a dangling id.

Selection changes no draft text. The shared UI submits only `suffixPromptId`;
the daemon resolves it at the write boundary and stores
`user text + "\n\n\n" + suffix`, which is why the conversation shows the full
prompt naturally. Task titles still come from the user text alone. A refused
steer keeps both draft and suffix selection; success or a task switch resets
the suffix to none.

The bar answers the MODAL's own width (`@container`), never the window's. On
a wide modal it is one line: what the task is on the left (attach,
harness·model, effort, suffix), where it runs plus **Create** on the right,
with `flex-wrap` as overflow insurance. On a narrow modal the left cluster
becomes a COLUMN of those choices — only the model trigger truncates; the
rest keep their natural width — and the right cluster stacks **Worktree**
directly above **Create**, pinned to the bottom right by `ml-auto` +
`justify-end`, so the commit action never scrolls out of reach. Where the
task runs rides with the commit action because it outranks every other choice
in the modal:

- **Worktree** (default) — an isolated checkout on its own `wisp/…` branch,
  created at start and removed at archive. A project runs any number at once.
- **This repo** — the project directory itself, on the branch it is already
  on. Nothing is created and *nothing is ever removed*: archiving a local task
  is a bookkeeping flip. Setup and archive scripts are skipped for it, because
  they exist to make a fresh worktree usable and re-running them over a live
  checkout is how you delete someone's `node_modules` mid-edit. The daemon
  refuses a second live local task in one repo — two agents, no isolation.

Worktree is the default and a `wisp/…` branch already announces itself, so only
**local** is marked in the UI (the task header and the hover card). Marking both
would be two labels where one is news.

## 5d. Project settings

The gear on a project row opens its settings: **setup script**, **archive
script**, and **files to copy**. All three are worktree-only, and the modal says
so once at the top rather than three times.

- **Files to copy** solves the `.env` problem: git does not carry ignored files,
  so a fresh worktree cannot run without them. One glob per line; a pattern with
  no `/` matches at **any depth**, so `.env*` also takes `backend/.env`.
  `node_modules` and `.git` are never walked, and the match is capped.
- **Show the match, always.** The daemon resolves the patterns against the real
  repo and the modal lists what they take, debounced. A glob is only trustworthy
  once you have seen its output — the failure mode without this is silent, and
  surfaces as a worktree missing the one `.env` nobody checked for.
- **Every field is a PATCH.** The modal saves the three fields it owns; the
  project's display name, which it does not edit, is preserved rather than
  blanked. An explicit empty value is the only thing that clears.
- **Remove from Wisp** unregisters a configured project — the same verb as
  `wisp project rm`. It is a two-click confirm in this modal, not a sidebar
  control: the contained red button first arms a red **Remove?**, then the
  second click drops the config entry. Tasks stay and nothing on disk is
  deleted. A history-only repo (one Wisp only knows from tasks) has no config
  entry to drop, so the footer explains why the control is absent.
- Scripts run in a fixed order: the repo's committed `.wisp/setup.sh` (the
  team's) before the configured one (this machine's). Both run — dropping
  either would silently change behaviour for a repo already relying on it.

`⌘↵` belongs to the **form**, not the prompt box — the model and effort fields
are part of the composer, and a shortcut bound to the textarea alone silently
does nothing once focus moves off it.

Selection inside a menu is a checkmark plus `bg-hover`. The accent appears in
the composer exactly twice: the focus ring, and the Create button.

## 5e. The `/` palette

`/` is a real picker, not a prefill. It opens when the draft is empty or the
character before the caret is whitespace, and it binds to the **slash token
under the caret** — the `/` through the next whitespace. `src/lib` is a path;
`look at src/lib /st` is a command. Hiding is cmdk's, driven by a
visually-hidden `Command.Input`; the textarea stays the real input and forwards
↑/↓/Home/End/↵ to the cmdk root. No component above the composer may install a
document-level key handler. The palette and report panels share one positioned
wrapper with the composer, so their left and right edges answer the input width,
not the outer footer before its responsive padding.

### Ranking is OURS, and it is what Enter runs

cmdk selects the **first row it finds**, so the order of the list is not
presentation — it is the answer. `slashScore` and `rankSlashGroups` in
`lib/slash.ts` decide it, in the render that produces the DOM, and cmdk's own
score-sort becomes a no-op over an already sorted list rather than the thing
correctness depends on. Never leave the order to cmdk: it re-sorts by moving
nodes React owns, and it did not reach these rows at all.

cmdk's scorer cannot do this job, because it knows nothing about which part of
a row is its **name**. Asked to rank `context` it returned **0.891 for every
one** of `/context`, `/compact` and `/fresh` — the last two only because they
carry `context` as an alias, and `/context` no better because its cmdk value is
the disambiguating `probe:context` rather than its own name. Equal scores fell
back to list order, so the row under the cursor was whichever tier happened to
come first, and Enter started a fresh harness session for someone who typed
`/context` in full.

The bands say what a `/` palette is for. **You are typing a command's name.**
An alias is how you FIND a name you did not know; it never outranks the name.

| score | match |
|---|---|
| 1 | the name IS what you typed |
| 0.7–0.9 | the name starts with it, shortest completion first |
| 0.6 | an alias IS what you typed |
| 0.5 | an alias starts with it |
| 0.15–0.4 | cmdk's fuzzy score over the NAME (`ctx` → `context`) |
| 0.05–0.14 | cmdk's fuzzy score over the aliases |
| 0 | no match — cmdk unmounts the row |

Groups stay contiguous and are ordered by their best row, so the best match is
always the first row of the first group. A tie keeps the order the tier
declared. The floor is not decoration either: cmdk scores `usage` against
`status` at ~0.004, and every one of those is a row you have to look past.

Four dismissals — Escape, a space (commands take no arguments), the caret
leaving the token, and picking an item — and one rule that makes them bearable:
**the palette never deletes typed text.** A dismissal also suppresses reopening
until that token is gone or a new `/` token begins, so Escape genuinely leaves
you alone. Only a PICK consumes the token.

Three tiers, and the tier is information rather than decoration:

| Tier | Heading | Costs a turn? |
|---|---|---|
| 1 — wisp-native | `Wisp` | no — a daemon API call |
| 2 — harness reads | the harness's name | no — an out-of-band probe |
| 3 — skills | `Skills` | **yes** — it is prompt text the harness honors |

Tier 3's entries are the harness's OWN registry, enumerated per task by the
daemon (`GET /api/tasks/:id/skills`): claude's init-event list unioned with
the frontmatter scan, droid's `list_skills` filtered by its own
`userInvocable`, codex's `skills/list`. Never a hardcoded list — droid's was
stale within one release, which is the rot discovery deletes. A name-only
skill renders a name-only row (droid ships them); codex's malformed-skill
`errors[]` and claude's pre-first-turn partial list are confessed in one
muted, non-selectable footer row under the group — never silently absent.
Codex entries show a bare name and prefill a plain-text ask, because codex
has no headless `/name` and the row must not pretend otherwise.

The harness group also carries `compact` (A5), the ONE entry among the free
reads that costs — so the marking rule gains a clause: cost is marked
per-entry first (`costLabel`), and the group marker is the default.
"runs a turn" is said only where it is literally true: claude's compact IS
an ordinary recorded turn (a prefill, not a dispatch), codex's is a turn in
codex's own thread; droid's summarizes without one and says "costs tokens".
A compaction failure names what failed and points at `/fresh` — Q7's
fallback doing its job on the path where it is actually needed.

Tier 2's entries come from the adapter's declared `probeCommands`, never from
a hardcoded list — availability is uneven (claude: both; droid: context only;
codex: usage only) and a hardcoded row would be a promise the harness cannot
keep. Its entries carry the harness's OWN command names: `/usage` means plan
and limits wherever the harness exposes it, matching the harness's familiar
semantics, while Wisp's persisted per-turn telemetry is the separate Tier-1
`/tokens`. Do not give `/tokens` a `usage` filter alias: on a harness without
an account read, typing `/usage` must not silently open another report. The
answer is a **report**, not a note: it opens in the probe panel above the
composer (markdown through Prose; structured numbers as tables Wisp owns),
`cached` is marked because a stale number is news, and a refusal is the same
one muted note as every other command's — never an empty panel.

**Only the tier that costs something is marked** — a muted, right-aligned
`runs a turn` on Tier 3 rows and nothing at all on the others. Same law as
§5c's "only **local** is marked, because marking both would be two labels where
one is news", and the §2 chip ban forbids the pills the alternative wants. A
tier with no entries renders **no group**: a task whose skills haven't been
answered yet (loading, or refused while a turn runs) sees no Skills heading,
and a harness with no declared reads is absent Tier 2 the same way rather
than as an empty promise.

Tier 1 dispatches; Tier 2 probes and opens the report panel; Tier 3 prefills
`/name` and sends nothing, because a person should see what is about to cost
them a turn. Every result and every refusal lands in **one muted note** above
the composer, keyed to its task — a 409 is an expected state and stays muted;
only a real failure is destructive.

Two entries that are not what they were: **`/diff` is cut** (the Changes pane IS
the diff and is always on screen — there was no hidden pane to reveal), and
**`/log` pins the conversation to the live tail** rather than focusing a stream
pane, because §5 deleted that pane.

## 5f. The pull-request link

A pull request is a provider-owned branch outcome, not task state and not proof
that the agent created it. Wisp looks up the worktree task's ORIGINAL stored
branch against that repository's `origin`; it never substitutes the branch
currently checked out. The public response is the provider-neutral
`found` / `none` / `unsupported` / `unavailable` union. The first provider
implementation is GitHub through the daemon's authenticated `gh`, and it
accepts same-repository heads only — fork pull requests are outside this slice.

Only `found` renders. Desktop uses one neutral external link in the task header;
mobile uses the same facts in a thumb-sized two-line link. Both say PR number,
lifecycle, CI, and review, and replace the old prominent Push button. The
branch icon relays GitHub's policy-aware merge state: green is ready, yellow is
mergeable despite failed checks, red is a known blocker, purple is merged, and
pending or unknown stays muted. Never recreate branch protection,
CODEOWNERS, or required-approval rules in Wisp. `/push` remains a Tier-1 palette
command. `none`, `unsupported`, and `unavailable` all render nothing: an absent
PR is not an error, and a missing provider CLI or credential is not task news.

The sidebar carries one smaller, non-interactive branch icon before the Git
marks for every non-archived task with a PR. It compresses detail to three
glance states: muted means associated, red means blocked, and purple means
merged. Do not turn it into a nested link: the row is already a button. Its
title is the flexible `min-w-0 flex-1 truncate` item; the PR icon and Git marks
are `shrink-0`, and all right-edge status yields to the desktop archive button.
The row hover card names the PR and reports stale provider data.

PR state is the deliberate polling exception. Query the selected task every 30
seconds and one all-live-tasks overview every 60 seconds while the document is
visible. The overview groups original branches by origin repository, uses
GraphQL aliases in chunks of 20 instead of one provider call per row, caches
for 55 seconds, and shares successful/in-flight answers with the selected
query. Keep polling `none` so a newly opened PR appears; stop asking for each
terminal merged/closed PR. On provider failure, keep the last successful answer
with an explicit stale bit and back that repository off exponentially, capped
at 15 minutes. One unavailable repository must not throttle the others.

### 5c-ii. The steer box's control bar answers its own width too

`SteerBox`'s bar is the create modal's rule applied to a pane instead of a
modal, and for a third reason on top of the phone and the dragged divider:
**Desktop's zoom leaves the window alone and shrinks every pane in CSS
pixels**, so a media query would never fire for it. `@container`, in two steps:

| width | the bar holds |
|---|---|
| any | attach · suffix · send, and a running note on its own line |
| `@lg` 512px | + harness · model · effort, truncating before it wraps |
| `@2xl` 672px | + the note or the `↵` hint inline; the stacked note goes |

Both things that yield are things the **task header two rows up still says**,
so nothing leaves the screen. Do not reach for `touch` here: `touch` sizes
controls for a thumb, it does not know how much room the bar has. A squeezed
bar announced itself as `xhigh` above `effort` and a four-word note wrapped
between the suffix picker and the send button; every item in the bar is
`shrink-0` and unbreakable now, and the layout answers the width instead.

### 5g. Wisp settings — the gear that is not a project's

`components/settings-dialog.tsx` is the app's own settings modal, opened by the
**gear at the right end of the top bar** and, on touch, by the gear in the
drawer footer — the drawer has no top bar to carry one. There the drawer's
dismissal and the modal's opening are ONE commit, the same pair a project's
gear already makes on touch; do not leave the drawer up over a dialog, and do
not invent a timer to sequence them. Exactly one gear per shell: a second one
on the pointer footer would be two doors to one room.

Two gears exist in this app and they are not the same door. A **project row's**
gear opens that project's settings — daemon state about one repo (§5d). The
**top bar's** gear opens Wisp's, which is client-local preference state for
this app on this device, and the modal's header says exactly that rather than
leaving someone to wonder whether a remote just changed.

- **Nothing is saved and nothing is cancelled.** A preference applies the
  moment it is picked, so the footer holds `Done` and no `Save`. A modal that
  can be abandoned needs draft state; a preference does not have any.
- **A section per family, one labelled row per setting.** `Appearance` owns
  `Theme` today. The section's eyebrow is the group and the row carries the
  field's name, so a second appearance setting is a row rather than a rewrite.
- **A pick from a set is the app's one dropdown** (`Menu` + `MenuRadioGroup`),
  the same control the composer uses for the decisions you make rarely. Its
  trigger text is the VALUE, so the trigger takes an explicit `aria-label` for
  the field — `Dark` alone announces nothing.
- Preferences that already live in their own surface stay there while that
  surface is where the decision belongs (the updater's *Check after launch*
  sits with the update it governs). This modal is not a junk drawer for
  everything client-local.

## 6. Panes and dividers

Every divider is draggable **and says so**: a hairline with a 3px grip in its
middle (`web/ui/src/components/panes.tsx`). Panes carry no border toward a
handle — the handle *is* the divider. Layouts persist through the library's
own `useDefaultLayout`; never hand-roll layout JSON.

The right column is a vertical split, not tabs: **Changes** over **Terminal**.
Terminal holds as many shells in the worktree as you want, tabbed, each its own
websocket, connecting only while active. A shell with something long-running
keeps its own dot so a finishing test run is visible without switching to it.

`Changes` is a label, not a tab — this pane has one view. It keeps a tab's shape
so `Checks` can slot in beside it later, but carries no underline and no hue.

## 6b. Mobile — touch is not a small mouse

Below the `md` breakpoint (`useIsMobile`) the three-pane grid is **replaced,
not squeezed**: `MobileShell` renders a header, ONE tab strip (Chat · Changes ·
Terminal), and a pinned composer. No resizable group mounts there at all, so
desktop pane geometry is neither applied nor overwritten by phone dimensions.

### The header is BANDED, and each band answers one question

This shell covers 320px to 767px — a phone AND a narrow Wisp Desktop window,
whose `minWidth` is 720. One row carrying app chrome, task identity and task
actions at once cannot align at either end of that range, and did not: the
hamburger and the overflow menu centred against a two-or-three line stack, so
nothing in the header shared a line with anything else, and an idle daemon
version wrapped onto two lines inside the width the title needed.

1. **The app band is Wisp Desktop's alone**, and it is not decoration. That
   window is `titleBarStyle: Overlay` with `hiddenTitle`, so the traffic lights
   float over whatever sits at the top left and a hidden title bar leaves the
   window nothing to drag by. The band is `pl-20` — the room the pointer shell's
   top bar already gives them — and `data-tauri-drag-region`, and it carries the
   connection switcher and the zoom control. A browser has neither problem and
   neither control, so it gets **no band at all**.
2. **The task band is a title over ONE metadata line**, between two 44px
   controls. Exactly two lines, so the hamburger and the overflow menu centre on
   the axis the title sits on. The line is state, `Local` when the task is one,
   then harness · model — the composer's control bar used to carry harness and
   model as well, three rows down and truncated to `claudeI…`, and one place
   un-truncated beats two places truncated.
3. **A pull request gets its own full-width row**, not a share of the header.
   The compact link is a 44px two-line thumb target; splitting the header with
   the title left both unreadable.
4. **The tab strip is three equal thirds** (`flex-1`), a segmented control
   rather than left-packed pills with a dead right half.

**App-level state lives in the drawer footer on touch**, beside the gear that is
already there, because below `md` there is no persistent top bar to carry it.
Wisp's update surface goes there in BOTH runtimes; the app band is for the
window's own chrome, not for app news.

The rules that differ from desktop, and why:

- **44px is the floor for anything tappable.** Not the visual size — the hit
  box. A control that looks 18px must still fill a 44px row (see the shell
  tab's inner button, which is `h-full` for exactly this reason).
- **Two-line task rows, no hover card.** The desktop row is one 26px line
  because branch and state live in a hover card; a finger cannot hover, so on
  touch those facts come back onto the row. `TaskRowTouch`, not a prop on the
  desktop row, because the anatomy genuinely differs.
- **Nothing is revealed by hover.** A project's `+` and a shell tab's `✕` are
  always visible on touch. The desktop row's **archive** control is the one
  thing that does not come back another way: hover reveals it in the
  git-marks slot (the marks fade out, and the hover card suppresses while the
  pointer is on it), and on touch archive simply stays in the **task header**,
  where a finger already reaches it. A long press for one verb would be the
  app's only long press.
- **Panes stay mounted when their tab is inactive**, so switching tabs never
  drops the conversation's scroll position or tears down a live shell. They are
  `hidden`, which means a pane can mount at zero height — anything measuring
  itself (xterm) must refit on activation, and any pane root needs `flex-1` as
  well as `h-full` so it fills a flex column as well as a resizable panel.
- **The composer is hidden on the Terminal tab.** Everywhere else it is
  pinned. On Terminal the shell itself is the input, and two composers fight
  over one keyboard.
- **Safe areas are honoured** with `env(safe-area-inset-*)`: the header clears
  a notch, the composer and the drawer's footer clear a home bar.

The drawer is base-ui's `Drawer` (swipe-to-dismiss), and selecting a task
dismisses it — you tapped it to go and read that task.

## 7. The diff pattern

File list first: one row per changed file, directory muted and basename lit,
clickable, with the `+adds −dels` pair as the only thing on the right edge.
Untracked files share the list, labelled `untracked` instead of a diffstat;
clicking one shows that file as a new-file diff. The detail shows that file
only — numbered gutters, 10% row tints, unmodified regions collapsed to an
`N unmodified lines` strip. A full-branch wall of diff is never the entry
point.

## 8. Golden rules

- **Semantic tokens only.** `bg-primary`, `text-muted-foreground`,
  `bg-state-running`. Never a raw palette class (`bg-purple-400`), never a hex
  in a `className`. Need a new colour? Add a token to
  `web/ui/src/index.css` named by meaning, not by hue — and check it against
  the budget in §1 first.
- **Elevation and stacking are scales, not literals.** Three depths
  (`shadow-float` / `shadow-popover` / `shadow-modal`) and five layers
  (`z-(--z-pane)` through `z-(--z-menu)`), both defined once in
  `web/ui/src/index.css`. Never write `shadow-[0_16px_40px_…]` or a bare
  `z-50`. A portalled popup does NOT win by being last in the DOM — DOM order
  only breaks ties between EQUAL z-indexes, so a surface that names no layer
  is painted over by any in-pane `z-10`. Shared popup chrome is
  `POPOVER_SURFACE` in
  `web/ui/src/components/primitives.tsx`.
- **Tailwind class names must be literal.** State→class maps are static
  `Record`s in `web/ui/src/lib/state.ts`; `bg-state-${state}` silently
  generates nothing.
- **No `dark:` overrides.** Two themes, one token contract: pair the value in
  both blocks of `web/ui/src/index.css` and let the class on `<html>` choose
  (§1, *Two themes*). A `dark:` utility, a second hex in a component, or a
  token that exists in one block only is the same bug three ways.
- **`className` is for layout, not restyling.** Never override a primitive's
  colours or typography ad hoc. A new variant is born in
  `web/ui/src/components/primitives.tsx` and reused.
- **Control heights are 22 / 26 / 32.** Rows are 26 (list), 34 (pane header),
  36 (top bar). Radii are 6 / 8 / 12. Space is 2 4 6 8 12 18 — not a 4/8 grid;
  dense tooling lives on odd numbers.
- **`flex` + `gap-*`**, never `space-x-*`/`space-y-*`. Equal dimensions:
  `size-*`, not `w-* h-*`. Truncation: `truncate`.
- **`cn()`** for conditional classes — no template-literal ternaries.
- **Icons:** `@fluentui/react-icons`, re-exported through
  `web/ui/src/components/icons.tsx` so there is one import surface.
  `lucide-react` is not a dependency and must never become one. Icons are
  components, never string keys, and carry no size classes — their container
  sizes them.
- **One eyebrow per pane.** More than one is a bug.

---

## What changed from the old `web/CONVENTIONS.md`

That file described the classic page and was deleted with it (D12). It is
recorded here because four of its rules INVERTED, and the old page's patterns
still turn up in screenshots, older docs, and git history — so this table is
what to check against before copying one forward:

| Old law | New law |
|---|---|
| accent `#7ea3e2` (blue) | `#AF87F1` (violet), oklch-derived |
| the accent marks the selected row and the active tab | selection and active tabs are **background only**; the accent never marks "which one am I looking at" |
| task row = 3 lines (title, branch·turn, state) | task row = **one 26px line**; the rest lives in a hover card |
| task row's right edge = `+adds −dels` | the **dirty-file and ahead counts** from `/api/status` — `GET /api/tasks` serves no per-task diffstat, so a diffstat per row would mean N requests or a lie |
| right pane = Changes / Terminal **tabs** | right pane = Changes **over** Terminal, draggable split, Terminal itself tabbed per shell |
| stream pane stacked over a turns pane | **one** conversation scroller (§5) |
| all-lowercase UI labels | sentence case for chrome, lowercase for literal data (§3) |
| dark-only, `<html class="dark">` is the whole theme | **two** themes, every token paired, `color-scheme` declared, dark still the default (§1) |

The chip ban, the diff pattern, the zero-CDN font rule and the
literal-class-name rule carry over unchanged — they were right.
