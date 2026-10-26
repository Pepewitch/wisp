# Wisp frontend conventions

`web/` is the one shared React app (Vite + React + TypeScript + Tailwind v4
+ shadcn on base-ui primitives). The daemon serves it in a browser and Tauri
packages it for Wisp Desktop. It is the only one: the classic `web/index.html`,
the abandoned first rewrite in `web/app/`, and the vendored xterm in
`web/vendor/` were all deleted at the v0.2 cutover (D12). The daemon serves
this app's generated web build at `/` and Tauri packages its single-file build.
`web/web-dist/` and `web/ui-dist/` are Git-ignored build directories: use the
supported commands to generate them, and never edit, stage, or commit them.

## 0. Two shipped runtimes

Every UI change must classify its impact on both clients:

- The browser runtime represents one implicit same-origin daemon and owns its
  token: it is the credential on every hop, including the ones a browser
  cannot put a header on (see `fetch-event-source.ts`, the terminal socket's
  `auth` frame, and `useAssetSrc`).
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
  and late async callbacks stay bound to their initiating `connectionId`. Pure
  layout and theme state may remain global.
- The Desktop Updates surface is deliberately global. Render its application
  and **Local daemon** rows separately, and bind every daemon check, install,
  recovery callback, error, and query key to the built-in `local` transport,
  never the selected remote tab. The native proxy must keep refusing remote
  daemon installation. The browser retains its one-daemon updater. See
  [`docs/DESKTOP-UPDATES.md`](../../../docs/DESKTOP-UPDATES.md).
- Browser-only auth and native-only connection/folder-picker/setup behavior
  stay behind their runtime boundaries. Any intentional difference is named in
  the change and covered without regressing the other client.
- Styling is only runtime-neutral when it ships **in the bundle**. The daemon
  serves the page under its same-origin script CSP and the packaged app has a
  separate one, so anything that
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
`web/README.md` for the exact generated-bundle sequence.

This file is the law. `#/gallery` is the law rendered on real components — when
you add a primitive, add its gallery entry in the same diff. An undocumented
primitive is an incomplete change.

Every value below is in `web/src/index.css`. Read it once; then never write
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

Semantic hue survives in four more places and nowhere else:

- **state dots** — `--color-state-*`, on 6px dots only
- **diff add/del** — `--color-diff-*`, text and 10% row tints
- **destructive/error** — `--destructive`, for real failures only
- **syntax** — `--syntax-*`, INSIDE a code block that named a language, and
  nowhere else (below)

`failed` and `needs-input` are the only two states allowed to tint their own
line of *text*, because they are the only two a person has to act on. Every
other state line is `text-muted-foreground`.

### Code: a chip in a sentence, a surface on its own, colour only inside

Markdown hands inline code and a fence's contents to the same `code` element,
and the only thing that tells them apart is the `language-*` class it gets when
— and only when — the fence names a language. Three cases, three answers:

- **`` `inline` ``** is a **chip**: `bg-accent-wash` and `text-accent-soft`,
  the fifth of the accent's five places. It is a phrase inside running prose
  with no box of its own, so it needs the wash to be picked out at all.
- **a fence with no language** is **plain mono on `--code`**. The block already
  says "this is code" with its fill, its border and its face; hue would be
  saying it a fourth time. A bare fence used to fall through to the inline
  branch and wear the chip around a whole block — `pre` now resets whatever its
  child chose (`[&>code]:bg-transparent`), because a mapper cannot see its own
  parent and the block is the parent.
- **a fence that named a language** is the same box with **colour inside the
  text**. Naming a language never moves the box.

Highlighting is `rehype-highlight` (lowlight → highlight.js) appended to
Streamdown's rehype chain in `lib/prose-highlight.ts`. Three things about it
are load-bearing:

- It runs **after `sanitize`**, or its spans would be stripped.
- `detect: false` — an unlabelled fence is never guessed at, which is what
  keeps the plain case plain. `ignoreMissing: true` — a fence naming something
  outside the common set (`mermaid`, a typo) renders plain rather than
  throwing. An agent's prose is not a build input and must not be able to take
  a turn down with it.
- Highlighting reruns on **every chunk** while a fence is still arriving, so
  past `PROSE_HIGHLIGHT_LIMIT` (20 000 characters — ~73ms per pass, measured)
  the language class comes off and the block renders as what it then is: plain.

In the browser build the highlighter is a lazy chunk, asked for when a task is
selected. A fence drawn before it lands is the same box in plain mono and takes
its colour when it does; Desktop's single file has it from the first render.

It emits **classes, not colours**, which is the whole reason to prefer it over
a bundled VSCode theme: the palette is ours. Five roles in `index.css`, mapped
once for every language rather than a theme per language:

| role | token | what it holds |
|---|---|---|
| keyword | `--syntax-keyword` | what the language reserves — hue 300, the app's own |
| string | `--syntax-string` | what is quoted |
| number | `--syntax-number` | a literal value |
| entity | `--syntax-entity` | what has a NAME: functions, types, keys |
| comment | `--syntax-comment` | an aside — grey, and italic |

Four of the five sit at **one lightness and one chroma** (0.78 / 0.09 on
graphite, 0.48 / 0.14 on paper — the same move down the lightness axis the
accent makes), so no role shouts over another, and all of them sit BELOW the
accent's chroma: colour in a code block must never out-compete the one violet
the app spends on the send button and the running dot. A `` ```diff `` fence
borrows `--diff-add` / `--diff-del`, because two surfaces must not disagree
about what "added" means.

**Everything else stays plain, and that is the design.** Identifiers,
parameters, operators and punctuation are most of a line; colouring them would
leave nothing for colour to pick out. Adding a sixth role means arguing that
one of the five was not load-bearing.

### The transcript's one brightest surface is the prompt bubble

With no hue to spend, the stream separates the person's words from the agent's
by *lightness alone*, so only one surface in a turn may be the lightest: the
right-aligned prompt bubble, `--card`. A code block used to share that fill and
the two became one shape when scanning for "where did I say something", so code
blocks have their own surface — `--code`, above the reading column and below
the prompt bubble. Anything new inside a turn recedes toward `--background`;
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
  `index.html` is what answers BEFORE it: Desktop's main module and both
  builds' styles follow the meta, so it covers the parse.
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
  text levels preserve their reading hierarchy.
- **A colour that needs both themes is a token pair, never a `dark:`
  utility.** Every family is paired: surfaces, text, the accent, the six state
  dots, diff add/del, destructive, the three elevations, and the modal veil.
  Three values that used to be hand-copied are now tokens because a pair is
  impossible otherwise — `bg-scrim` (thirteen hand-picked `bg-black/60`s, three
  of them at other alphas), `hover:bg-primary-hover` and
  `hover:bg-destructive-hover` (`brightness-110` walks a light-mode violet up
  into its own white label).
- **One licensed exception.** xterm paints to a canvas and takes JS colours, so
  `TERMINAL_THEME` in `components/shell-view.tsx` holds both scales as hex
  and follows the store; the find highlights beside it (`FIND_DECORATIONS`)
  are the same exception for the same reason. A theme switch repaints the live terminal in place;
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
(`wisp/t5qmha-…`), the storage key (`wisp_token`), the package name, and every path.

The test: could you paste it into a shell or a config file? Then it is lowercase.
Is it the name of the thing? Then it is `Wisp`.

`STATE_LABEL` in `web/src/lib/state.ts` is the only place a state's display
name lives. Never render `task.state` directly in chrome.

## 4. Typography

Geist Sans (`font-sans`) and Geist Mono (`font-mono`), bundled from the
fontsource variable packages — zero CDN, OFL 1.1 text in `web/licenses/`.
No third face, ever.

| Size | Weight | Use |
|---|---|---|
| 22 / −1.8% | 600 | page titles only |
| 14.5 / −1% | 600 | the phone's task title |
| 13 / −0.5% | 600 | the top bar's task title |
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

1. **One scroller owns the visible conversation window.** No per-turn clamp,
   nested `overflow`, or separate stream pane. The UI requests 50 newest turns
   from `GET /api/tasks/:id/conversation?limit=50`; **Load earlier turns**
   prepends cursor pages in chronological order and compensates `scrollTop` by
   the added height. A cross-project search hit automatically loads pages until
   its named turn is mounted. The endpoint remains unpaginated when `limit` is
   absent for older clients, and the UI still falls back to legacy
   `GET /api/tasks/:id` when a protocol-1 daemon lacks the conversation route.
   `/tokens` does not total only the mounted window: while its panel is open,
   `GET /api/tasks/:id/usage` fetches task-wide totals and at most 50 newest
   reporting-turn rows. A 404 falls back to the full turns supplied by an older
   daemon.
2. **Activity rows render as summary lines only.** The live stream retains
   only its current turn. A settled turn's structured activity is fetched when
   someone chooses **Show activity**, its SSE closes at `turn-end`, and the
   body is dropped on **Hide activity** or task switch. Logs cap at
   `turnTranscriptBytes` (25 MB default) **per turn**, and the live reducer also
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

### One reading column

The transcript and the composer share ONE centred column, `--reading-measure`
(680px, its own 18px side padding included, `index.css`). A wider centre pane
grows the margins either side, never the line: unbounded, a line ran to ~130
characters at 1512px and a prompt bubble sat ~1000px from the prose it
answered. Below the measure (the phone, a narrow window, a dragged divider) the
column is simply the pane, so nothing changes there.

- **The scroller spans the pane; its CONTENT keeps to the measure.** A wheel
  over a margin still scrolls the transcript, the scrollbar stays at the
  pane's edge, and rule 1's one scroller is untouched.
- **The composer keeps to the same measure,** and its `@container` sits inside
  it, so the control bar answers the column's width, not the pane's.
- **What anchors to the conversation anchors to the column.** The jump-to-latest
  float sits at the column's bottom-right corner; the palette and the reports
  already share the composer's width. The find bar is pane chrome and stays at
  the pane's top-right, clear of the words it searches.
- **Wide content scrolls inside the column, never the page:** a code fence and a
  table carry their own `overflow-x-auto`, and a mermaid diagram fits to the
  column's width with its own pan and zoom.
- Reference the width as `max-w-(--reading-measure)`; never repeat `680px`.

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
is a DOM child of the bubble. Its right edge is **flush with the bubble's**
(`right-0`): inset by 8px it read as a box that had missed the corner it
belongs to, two edges 8px apart with nothing between them.

Every control in it is `BUBBLE_ACTION` in `person-bubble.tsx` — a class, for
`POPOVER_SURFACE`'s reason: `CopyButton` owns its own element, so `cn()` is the
one way copy, edit and cancel can share a shape. That shape is a **square with
its glyph in the middle**: 20px around 12px with a pointer, so the toolbar is
22px — a control height the app already has — and **32px around 16px by
default**, the drawer footer's icon-button size, because the toolbar does not
hide on touch and §6b's floor is about the hit box, not the look. Sizing is
`pointer:`-relative for the same reason the reveal is: the generous size is the
default, and a pointer is what makes the compact one safe. The frame is one
step up the radius scale from its buttons (8 over 6), so the corners nest.

It was a 16px button — a 12px glyph plus 2px of padding — in an 18px frame:
the border traced the icon with nothing to spare, so the toolbar read as a box
drawn too small rather than as a control, and any asymmetry in a glyph had
nowhere to average out. A button whose size comes from PADDING has no centre of
its own; give it equal dimensions and one `justify-center` instead.

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
  not been sent, so there is no time to state. `queued for the next turn`,
  `held for the next turn` for one the queue toggle held, or the archived /
  cancelled / retry-uncertain wording the state calls for.

What the toolbar carries: **copy**, on every bubble, and **send now, edit and
cancel** on a queued one. Send now (the send arrow) lifts a hold and delivers
the message the way a mid-turn send does; a workflow's generated instruction
does not offer it, and a daemon without `steerDelivery` hides it. While a queued bubble is being EDITED it is a form, so `Save` and
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

`web/src/lib/activity.ts`'s `summarizeStep()` prefers a nonblank string
`description`, then `summary`, for the tool row title, then falls back to the
useful input (`file_path` → `path` → `command` → `pattern` → …). Expanding the
row shows the input arguments, including the command, plus output and errors.

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
  create dialogs with no unsent draft, never the selection in the current
  project's draft. A restored draft keeps its model until that project is
  successfully created. The preference is client-local and connection-scoped;
  a missing or retired model falls back normally for a new draft.

An unfinished create composer stays in webview memory when the dialog closes:
prompt, raw pending files and task choices restore for the same project on the
same connection. Switching projects opens that project's own draft, and the
global New task action reopens the last selected project. Successful creation
clears only the submitted project's draft; a refusal keeps it for retry.
Nothing is written to browser storage or shared across tabs. Fast mode still
starts off for a new task because it spends more usage, but an unfinished
draft restores the toggle exactly as it was left.

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

The modal has TWO bars, and the split is by what a control scopes. The row
above the prompt carries the two decisions that scope everything below them:
the project on the left and where the task runs — **Worktree**/**This repo**
plus its **Base** — on the right. The project's path is a parenthetical inside
that trigger, `wisp (/path/to/wisp)`, so it costs no width of its own and is
the first thing to truncate when the row tightens; every control keeps its
natural width. The mode and base pickers own no glyph in common: mode pairs a
layered-copy sheet with This repo's monitor because it answers *where*, while
base keeps the branch glyph because it answers *which ref*.

The bar UNDER the prompt answers the MODAL's own width (`@container`), never
the window's. On a wide modal it is one line: what the task is on the left
(attach, harness·model, effort, suffix) and **Create** on the right, with
`flex-wrap` as overflow insurance. On a narrow modal the left cluster becomes a
COLUMN of those choices — only the model trigger truncates; the rest keep their
natural width — and **Create** stays pinned to the bottom right by `ml-auto` +
`justify-end`, so the commit action never scrolls out of reach. Where the task
runs is a scoping decision, not a control-bar one:

- **Worktree** (default) — an isolated checkout on its own `wisp/…` branch,
  created at start and removed at archive. A project runs any number at once.
- **This repo** — the project directory itself, on the branch it is already
  on. Nothing is created and *nothing is ever removed*: archiving a local task
  is a bookkeeping flip. Setup and archive scripts are skipped for it, because
  they exist to make a fresh worktree usable and re-running them over a live
  checkout is how you delete someone's `node_modules` mid-edit. The daemon
  refuses a second live local task in one repo — two agents, no isolation.

Worktree is the default and a `wisp/…` branch already announces itself, so only
**local** is marked in the UI (the top bar's `Local` word and the hover card). Marking both
would be two labels where one is news.

## 5d. Project settings

The gear on a project row opens its settings: **setup script**, **archive
script**, **files to copy**, and **base branch**. All four are worktree-only,
and the modal says so once at the top rather than four times.

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
- **Remove from Wisp** unregisters a configured project. It is a two-step
  confirm in this modal, not a sidebar control. When active tasks exist, the
  confirmation offers **Archive all N active tasks**, checked by default.
  Normal archive safety checks still apply, and archiving removes task
  worktrees but never the project folder. Clearing the option leaves active
  tasks visible as an unconfigured project. Once an unconfigured project's
  tasks are all archived, it disappears from Projects; archived history remains
  available through **Show archived**.
- Scripts run in a fixed order: the repo's committed `.wisp/setup.sh` (the
  team's) before the configured one (this machine's). Both run — dropping
  either would silently change behaviour for a repo already relying on it.
- **Verification** (`project-verification.tsx`, only with
  `features.autoReview`) is the project's verification recipe, which lives in
  the Wisp home and never in the repo: its state as a dot plus muted text, its
  areas (proven or not, and what a reviewer reported), a waiting draft with
  **Activate draft** (outline: the modal's one primary stays Save), the recipe
  task at work with Open, the **Reviewer agent** (saved with Save as `verify`),
  the **Second reviewer** under it (only with `features.reviewPanel`: *Same
  agent as the reviewer* = null, *Off — one reviewer* = `"off"`, or a model
  from the same list; saved with Save as `verifySecond`, sent only once a
  person picked one and never to a daemon without the panel),
  **Fallback for A** and **Fallback for B** (only with
  `features.reviewFallback`; B's only while the second reviewer is not Off:
  *None — the round needs you* = null, or a model from the same list; saved as
  `verifyFallback` and `verifySecondFallback`, each sent only once a person
  picked one), and a note with **Set up verification** / **Improve** and a per-area **Fix**.
  A named reviewer on an effort-capable harness has an effort menu beside its
  model: *Harness default*, which saves no `effort`, and the harness's levels
  (`effortOptions`, as the composer offers them); the current effort stays
  listed even when the harness names no levels, so it can always be cleared. A recipe task runs on the reviewer agent. It belongs to
  the project, so while the reviewer is "Each task's own agent" it has no
  task's agent to borrow: a **Recipe agent** row then picks its harness, model
  and effort on the spot, starting from what a new task would use (the
  project's drafted composer agent, else the preferred model, else the first
  usable harness in the composer's order, at its configured effort), and is
  never saved. The buttons are disabled only with no agent to offer or a recipe task
  already at work, and a muted line beside them says why (a disabled button
  shows no title and takes no focus). A started
  task is selected behind the modal, so unsaved edits survive. The sidebar's
  shield button on a project row opens the modal at this section; it carries a
  dot only when there is something to say (red: a reviewer reported the recipe
  failing; blue: a recipe task is working; neutral: a draft waits).

`⌘↵` belongs to the **form**, not the prompt box — the model and effort fields
are part of the composer, and a shortcut bound to the textarea alone silently
does nothing once focus moves off it.

Selection inside a menu is a checkmark plus `bg-hover`. The accent appears in
the composer exactly twice: the focus ring, and the Create button.
A menu's on/off switch (`MenuCheckboxItem`) ends in a small neutral switch
(foreground when on, never the accent) instead of a leading checkmark. A radio
row's empty checkmark slot is explained by its checked neighbour or its group's
header. A switch shares a menu with actions and has neither, so a bare
unticked `Auto-merge` would read as a command. The trailing switch shows off as
plainly as on, and keeps the label aligned with the actions.

## 5e. The `/` palette

`/` is a real picker, not a prefill. It opens when the draft is empty or the
character before the caret is whitespace, and it binds to the **slash token
under the caret** — the `/` through the next whitespace. `src/lib` is a path;
`look at src/lib /st` is a command. Hiding is cmdk's, driven by a
visually-hidden `Command.Input`; the textarea stays the real input and forwards
↑/↓/Home/End/↵ to the cmdk root. No component above the composer may install a
document-level handler for a bare key. ⌘-, Ctrl- and ⌃-modified chords are
never in that set (find ⌘F, the tool panel's ⌃` and ⌘\\). The palette and
report panels share one positioned wrapper with the composer, so their left and
right edges answer the input width, not the outer footer before its responsive
padding.

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
a dedicated recorded turn (a prefill, not a dispatch), codex's is a turn in
codex's own thread; droid's summarizes without one and says "costs tokens".
Prompt compact turns are identified by the daemon so browser and Desktop show
the same `compacting the session…` / `compacted` lifecycle as action-based
compaction without parsing private harness transcripts. A recorded prompt
compact owns that copy in its transcript row; an out-of-band action owns one
composer note instead. Never echo either lifecycle in both places. They are idle-only:
an active turn gets the same `compaction waits for it` refusal as the action
route, never a live steer. Harnesses with no declared compaction (currently
cursor and opencode) keep honest absence—no dead palette command. A compaction
owns the session until it settles: the composer disables send immediately,
and the daemon refuses a racing message before it can be steered or queued.
A compaction failure names what failed and points at `/fresh` — Q7's fallback
doing its job on the path where it is actually needed.

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
the diff; `/changes` opens it), and **`/log` pins the conversation to the live
tail** rather than focusing a stream pane, because §5 deleted that pane.

On the pointer shell a **Tools** group, under `Wisp`, names the tool panel's
tools: `/terminal`, `/changes`, `/autopilot`, `/subtasks`, `/workflows`, only
the ones this daemon has (§6). A pick opens the tool and leaves it open — a
command you typed does not close what it names — and consumes only its token,
like Tier 1. Their row values carry a `tool:` prefix, so a skill called
`changes` is a different row. The phone, whose tabs are its tools, has no such
group.

## 5f. The pull-request link

A pull request is a provider-owned branch outcome, not task state and not proof
that the agent created it. Wisp looks up **every branch the task made** against
that repository's `origin`, and shows the NEWEST pull request of them — the
highest number the provider ever issued — with a muted count of the rest. It
still never substitutes the branch currently checked out.

The branches are enumerated from LOCAL git by the task id in their name
(`wisp/<id>-…`), which is why there is nothing to record at push time and
nothing to keep in sync. Local refs, not remote ones: a squash-merged branch is
gone from `origin` within seconds, and its pull request is the one you most want
to see. The task's stored branch always leads the list and is included even when
git cannot be read, so this can only widen the answer, never narrow it. A cap
(`PULL_REQUEST_TASK_BRANCH_LIMIT`) keeps one task from filling a GraphQL
document it shares with every other task in the repository — and because a cap
TRUNCATES, the rest are ordered by `-committerdate` rather than by name: a name
sort could drop the branch holding the newest pull request, which is the one
thing this is for. The enumeration is timeout-bounded like every other spawn,
falling back to the branch of record, so one stuck `git` cannot hang the
sidebar's whole refresh.

One task, one answer: a provider failure on ANY of its branches beats a success
on another, because the newest could be the one that failed and showing the
older as current would be a confident lie. The public response is the provider-neutral
`found` / `none` / `unsupported` / `unavailable` union. The first provider
implementation is GitHub through the daemon's authenticated `gh`, and it
accepts same-repository heads only — fork pull requests are outside this slice.

Only `found` renders a link. The pointer shell says it in the summary card's
Pull request row (§5n: `#318 · Open`, opening to CI, review, merge state and
*Open on GitHub*), with the words `pullRequestWords` (`lib/pull-request-words.ts`)
gives every surface; mobile uses the same facts in a thumb-sized two-line link.
Both replace the old prominent Push button. The
branch icon relays GitHub's policy-aware merge state: green is ready, yellow is
mergeable despite failed checks, red is a known blocker, purple is merged, and
pending or unknown stays muted. Never recreate branch protection,
CODEOWNERS, or required-approval rules in Wisp. `/push` remains a Tier-1 palette
command. `none`, `unsupported`, and `unavailable` all render nothing: an absent
PR is not an error, and a missing provider CLI or credential is not task news.

**Auto-merge on the PR line.** While a task's auto-merge is on, its reason
REPLACES the CI and review words — `PR #271 · Open · Auto-merge: Waiting for
checks (2 running)` — because the reason already accounts for both, and the
line truncates: a reason appended at the end would be the first thing cut. The
hover title keeps every fact. A PR Wisp merged reads `Merged by Wisp`. The
switches — Auto-merge, Auto-fix and Auto-review — live in the Autopilot tab (§5k) with
their live line, the one action the state asks for, and History; the task's
summary card's Autopilot row (§5n) opens to the same switch rows, and the phone's
`⋯` menu keeps them as checkbox rows (`MenuCheckboxItem`, a trailing switch)
naming the PR they are bound to, and nothing else. Only a reason about the PR's own state
(`about: "pr"`) may stand in for CI and review; one about the task never does.
The daemon checks armed PRs on its own loop (docs/PR-AUTOPILOT.md), separate
from the UI polling below. The new-task dialog arms both from the start with a
PR picker on the scoping row (`AutopilotPicker`, worktree tasks only, hidden on
a daemon without `features.taskAutopilot`). In the sidebar, an armed task carries a
2px rail on the row's left edge (`AutopilotRail`, from `autopilotRail` in
`lib/autopilot-words`): `state-background` blue while on, `primary` violet
once `status.done` (the daemon's word: its PR merged on this row, or auto-fix
alone found a green PR quiet for 15 minutes; never while a turn runs),
`destructive` red when it needs a person or paused. The touch row carries it
too, and an sr-only line says the same to a screen reader. A
needs-you also turns the PR icon's `blocked` red with the reason in its label,
and the hover card has an Autopilot row saying which switch is on.

The count rides the header link and the hover card, not the sidebar icon: the
icon compresses to three glance states on purpose, and the card is where the
branch of record and a later pull request sit one row apart and can disagree.

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
| `@xl` 576px | + the `↵` hint. Not wider: the reading column (§5) caps the bar at 644px |

On `touch` the bar is one row of thumb targets instead: the model chip, the
effort glyph, the paperclip, the suffix glyph and the send.

**While a turn runs, the send says what it will do, and one toggle changes
it.** The daemon reports the running turn's input (`turn_input`: `steer`,
`wait` or `interrupt`, and the agent it runs), and `lib/steer-delivery.ts`
turns that and the picker's agent into the running note and the send
button's name: `send steers this turn`, `finishing · send starts the next
turn`, or `send stops this turn, then sends` in the needs-input tone, since
it is the one that stops work. A different agent than the running turn's can
only start a new turn, so it reads as a stop too. The **queue toggle**
(`PeopleQueue`, Regular off and Filled on, glyph only in both states) sits
beside the send and holds that one send for the next turn; it turns itself
off after the send, on a task switch, and when the turn ends, so it can never
quietly hold every later message. The send keeps its arrow in every case.
Against a daemon without `steerDelivery` there is no toggle, no `when`, and
the older `send won't interrupt` note.

Both things that yield are things the **title menu (the phone header on touch)
still says**, so nothing becomes unreachable. Width is not `touch`'s question: `touch` sizes
controls for a thumb, it does not know how much room the bar has. A squeezed
bar announced itself as `xhigh` above `effort` and a four-word note wrapped
between the suffix picker and the send button; every item in the bar is
`shrink-0` and unbreakable now, and the layout answers the width instead.

The one exception is the **agent picker**, which is a control and not a
repetition: a per-turn model switch has no other home, so it renders at every
width. Two container steps cannot make five spelt-out controls fit 342px of
phone, and while the picker was `shrink-0` with a spelt-out label they simply
overlapped — the paperclip sat on top of `Default effort`, which sat on top of
`Suffix prompt`. So `touch` answers what a *thumb* needs, and the two rules
compose:

- **An unchosen optional control is its glyph; a chosen one shows its value.**
  Effort at the harness default and an unselected suffix prompt are the
  `Prompt` and `Effort` glyphs alone, named by `aria-label`/`title`. Pick
  either and its value comes back as text, because it changes what a send
  delivers. The model chip is never a glyph — it always names the model.
- **One item yields, and it is the model.** The chip drops its sparkle
  (a mono model name under a chevron is unmistakable), keeps `min-w-0 shrink`
  and truncates; the header still says harness · model in full. Everything
  else is `shrink-0` at 44px, so nothing can overlap again.

Three more things touch owns here, none of them a width question:

- **The box grows with the draft** (`useAutosizeTextarea`), from a one-line
  floor to the `max-h-[40vh]` cap. `rows` alone fixed the height, so a long
  prompt scrolled three lines at a time while the cap applied to nothing — and
  on a phone the room the box does not need yet belongs to the transcript,
  which the keyboard has already taken half of.
- **Return is a newline under a soft keyboard**, and the 44px button is the
  send (`⌘/Ctrl+Return` still sends, for a phone with a keyboard). There is no
  Shift to hold on a soft keyboard, and a stray Return firing a half-written
  prompt costs a turn. This one asks `hasCoarsePointer()` as well as `touch`,
  because the mobile shell also covers a 720px **Desktop** window: sizing for
  a thumb must never take a real keyboard's shortcut away.
- **No hairline and no `↵` hint.** The separator's job — who answers on one
  side, what to send on the other — is done by the gap, and a keyboard hint on
  a device with no keyboard is noise. The hairline now ships WITH the identity
  it separates, so `@lg`'s absence cannot leave a rule with nothing on either
  side of it.

**The resume hint hangs off the same right edge.** Once a turn has ended,
`components/resume-hint.tsx` names the stored session so it can be continued
outside Wisp — from the daemon's own `GET /attach` answer, built from the
adapter's `attach` template, never reconstructed client-side from the harness
name, so a harness that declares none renders nothing rather than a guess. It
shows only when a session exists AND no turn is running: mid-turn the command
is not paste-ready, and the running note owns the row. The display is one
short fact — `session: <id>`, mono and muted — because the full working line
(`cd <worktree> && …`, the same one `/attach` writes into its note, since a
harness resolves its sessions per directory and the bare command fails pasted
anywhere else) is what the copy button carries, not what the line spells out;
hovering the id still names the whole line via `title`. The id truncates from
the LEFT (`dir="rtl"` on an all-LTR string) so its identifying tail survives
a phone. The copy button (the bubble toolbar's `BUBBLE_ACTION` shape, 32px
under a coarse pointer) always carries the whole working line.

`Menu` owns thumb sizing for every dropdown, so no call site rolls its own:
`touch` makes a trigger 44px (`w-11` when `iconOnly`) and adds `active:`, and
the `menu-row` class takes a 44px floor under `@media (pointer: coarse)` in
`index.css`, beside the rule that stops iOS zooming a focused field.

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
  - The one exception is a secret: `Review judge` takes a pasted API key.
    Half a key must never be sent, so the key has its own `Save` (and
    `Cancel` while replacing one). The section says "Not saved yet" while a
    typed key is unsaved, and `Done` leaves it unsaved.
  - The key is write-only on the client too. The field is uncontrolled, and
    it remounts on any change of key. Its mutation is uncached
    (`gcTime: 0`). No `<form>` wraps it, so a browser does not mistake it
    for a login.
  - `Usage limits` holds the second secret, the Factory API key droid's
    plan limits are read with. Both keys are one component
    (`secret-key-field.tsx`) with a spec per key; a third secret is a new
    spec, never a copy of the field.
- **A section per family, one labelled row per setting.** `Appearance` owns
  `Theme` today. The section's eyebrow is the group and the row carries the
  field's name, so a second appearance setting is a row rather than a rewrite.
- **A pick from a set is the app's one dropdown** (`Menu` + `MenuRadioGroup`),
  the same control the composer uses for the decisions you make rarely. Its
  trigger text is the VALUE, so the trigger takes an explicit `aria-label` for
  the field — `Dark` alone announces nothing.
- Preferences that already live in their own surface stay there while that
  surface is where the decision belongs (the updater's *Check Desktop after
  launch* sits with the update it governs). This modal is not a junk drawer
  for everything client-local.
- **A preference the daemon owns says so in its hint**, and hides itself when
  the daemon is too old to hold it. `Task names` and `Models` are both
  daemon-wide (`/api/settings`); on a 404, or on an answer missing the field,
  the section is absent rather than a control that would silently do nothing.

### 5g-i. Models — the picker is curated, the catalog is not

opencode reports ~150 model ids and cursor its whole catalog, so the one
dropdown that picks harness AND model is mostly scroll. `hiddenModels` in
daemon settings is the curation, and three rules keep it honest:

- **It is a view filter, never a capability.** `wisp create --model <hidden>`
  still runs, `/api/harnesses` still reports every id, and a task already on a
  hidden model keeps it. Every read takes a `keep` model that survives the
  filter (`lib/model-visibility.ts`) — a menu whose radio value is absent from
  its own options has no checked row, and the trigger would then name a model
  the list denies exists.
- **A denylist, not an allowlist.** A model a later probe discovers appears on
  its own. An allowlist would silently swallow tomorrow's model, which is the
  same bug cursor's old `auto`/`composer-*`/`cursor-*` probe filter had — that
  filter is gone, because deciding what is *useful* is the user's, and a probe
  only reports what this install can RUN.
- **A shortened list says how much is missing.** The menu footer carries
  `Show N hidden` — a ONE-SHOT reveal scoped to that opening, so a hidden model
  stays reachable without undoing the curation — and `Manage models…`. A
  harness with nothing shown drops out of the menu entirely; the count is what
  says it is still out there.

The manager (`model-visibility-dialog.tsx`) **is the dropdown, unfiltered,
with a shown/hidden checkmark**: same grouping, same order, same left slot —
in the picker that slot answers *is this chosen*, here *is this shown*. Per §1
it is a checkmark and a dimmed name, never a tinted box. `Hide all` per harness
is the fast path, because retiring opencode is one decision and not 150.

The per-row eye is a POINTER affordance: `opacity-0` until hover, keyboard
highlight (`:has([data-highlighted])`, because the button is a sibling of the
row base-ui owns) or its own focus. On a coarse pointer it is not rendered at
all — a finger reveals nothing by hovering, and the manager does the job there.

Each manager row also carries the model's **task defaults**
(`modelTaskDefaults` in daemon settings, built-in defaults in
`shared/model-task-defaults.ts`: both autopilot switches off). They
are said only by exception: a row whose model starts like every other shows
nothing, and one that differs ends in a muted note
(`Auto-fix · Auto-merge`). A `…` on the row opens a menu of
`MenuCheckboxItem`s, offering only the switches the composer would offer
there. The `…` is a `.model-row-action` like the picker's eye (hover, focus,
or open), except that a coarse pointer always shows it, because the manager
is where touch edits these. A column of switches on every row was tried and
dropped: three labels repeated down 150 rows is the chip clutter §1 rules
out. The composer starts each switch at
the chosen model's default and follows it until the switch is pressed; the
draft keeps only pressed switches, so a default changed mid-draft still
lands, and picking another model forgets the presses the way it reseeds
effort.

### 5h. The top bar: which daemon, which task, this app

The pointer shell's top bar is its only bar, and it answers three questions,
left to right. The **left end** is *which daemon am I on*: the mark in the
browser, the connection tabs on Desktop (after the traffic lights' 80px). It
is at least the sidebar's width (`--sidebar-width`, written by the sidebar
panel's `onResize` straight onto the bar's style, so a divider drag never
re-renders the app), with a hairline that continues the sidebar's divider. It
is at most 40% of the bar (`TopBarLeft`; the sidebar's width wins where it is
wider), so connection tabs can never starve the task's title: past the cap the
strip scrolls (`ConnectionTabList`), and the selected chip scrolls itself into
view. (A chip cannot usefully shrink instead: a truncating name still counts
its full text toward the chip's minimum width.) The gallery shows a 900px
Desktop bar with four long connection names.

The **middle** is *which task* (`top-bar-task.tsx`), and it is why there is no
task header above the conversation. `● Title ⌄` is one control: the state dot,
the `h1` title and a chevron open the **title menu**, whose header carries the
facts the old meta line showed and nobody needs in view (id · branch, then
state · harness · model · effort, then a subtask's kind and base). Under it sit
the task's verbs: Find ⌘F, Rename, New subtask…, Archive, Export or delete, then Copy task id
and Copy branch name. The autopilot switches are the summary card's (§5n). The phone reaches the same verbs from its task sheet (§6b). A subtask leads
with `Parent ›`: the parent opens the parent, is capped at 14rem and shrinks
three times as fast as the title, so the task you are in stays readable.
`Local` and `Archived` follow as quiet words, only when true. Where the centre
is too narrow for the summary card, its chip sits right after the title and
takes the title's dot with it (§5n).
The dot's hover names background work, as everywhere (`StateDot`).

Then **what you can open** for that task (`top-bar-tools.tsx`): the tool
icons, before a hairline that sets them apart from the app's own cluster. §6
owns what they do. Each is a toggle (`aria-pressed`) whose `title` names it, and
the Terminal's names its chord.

What is left of the old header is `task-notices.tsx`: the archive-cleanup panel
and the worktree reason, in the reading column above the transcript, and only
when there is something to decide: a cleanup that is `complete` gets no band.
The title menu's facts are the `GroupLabel` of a base-ui `Menu.Group` holding
the verbs, because `role=menu` may hold only items, groups and separators.

**On Desktop the whole bar is the window's drag region.** Tauri starts a drag
only when the element under the pointer carries `data-tauri-drag-region`
ITSELF (a bare attribute does not reach children) and never on a button, link
or other control. So every non-interactive box in the bar carries the
attribute (the three sections, the empty stretch, the quiet words, a
subtask crumb's gap and its `›`), glyphs
inside them are `pointer-events-none`, and no control carries it. The empty
stretch between the title and the tools is the big drag target; the tools'
wrapper and the hairline after it drag too, the icons do not.

The **right end** is *this app*: the connection indicator states what it is
doing, and then everything you can do TO it sits in one
cluster, `gap-1` against the header's `gap-2.5`, so three same-sized icon
buttons read as a group rather than as three controls that happen to be near
each other. Usage limits, then Updates, then zoom (Desktop only), then the
gear — last, because the gear is the top-right corner (§5g).

**Usage limits is a ring, not a number.** `usage-limits-control.tsx` draws a
glyph-sized progress ring for the selected task's harness at its shortest main
window, because that is the one that moves turn to turn: claude's 5h, a codex
plan's 5h, or its 7d when the plan has none. Main means the harness's own
allowance: a per-model window (claude's week for one model) and a side pool
(droid's `core`) never speak for the ring; droid's is its `standard` pool.
With no task, or a harness with no limits read, the ring is an empty track
rather than a missing icon. The arc is neutral until 80%, then
`--state-needs-input`, and `--destructive` from 99%, a step before the hard
stop: the same two hues the Updates dot may carry, on a mark the same size.
Any other main window at 99% turns a short arc `--destructive` too, because
the next turn stops either way, and the trigger's name says which. Hover opens the popover and a click pins it; on touch it
is a tap. The popover groups windows per harness (droid's `standard` and
`core` pools as sub-groups), bars fill with the share USED, as every harness's
own report words it, and each row says when it resets. A harness with nothing
to show says why in one line; only a real read failure is red, and a missing
or wrong-account Factory key links to Settings. The limits are account state,
so `useHarnessLimits` polls every five minutes while the page is visible,
against a daemon cache that expires just before, so a poll is one fresh read
however many clients ask. Between polls the daemon checks only the harness a
turn just ended on; that check shares the same cache, and a `harness-limits`
event makes clients re-ask it only after a fresh read. Automatic probe errors
back off from about five to at most thirty minutes instead of spawning a
broken or slow harness every poll; configuration states keep the normal cache
window so installing a CLI or changing its local login recovers promptly.

**App news is not connection chrome.** The update surface used to sit at the
left end, hard against the connection tabs: the only labelled button in a bar
of icons, in the corner that answers a different question. It is a
`Download`-glyph icon button now, and its count is a 6px dot in the corner —
`--state-needs-input` for an update waiting on you, `--destructive` for one
that failed, which is the badge budget §1 already allows at that size. An
icon-only trigger's accessible name carries what the dot cannot say
(`Updates, 2 available`), and the name still starts with the surface's own
word, because that is what someone searches for. The browser's one-daemon
control is the same glyph when there is nothing to install from here: the
daemon's version used to sit in the bar as a mono label, and it is in the
glyph's popover now (`VersionLine`), with the reason a manual update cannot be
installed. Only an update the daemon can install itself turns it into the
labelled `Update daemon <version>` action.

On touch this cluster does not exist: there is no persistent top bar, so the
gear, the usage ring and the update surface live in the drawer footer (§6b).

## 5i. Search — two questions, two shapes

"Where in this task did that happen" and "which task said that" are different
questions, and one box cannot answer both without lying about its scope. So
there are two surfaces, one chord each, and they hand off to each other.

**⌘F — find in the task you are reading.** A bar in the top-right of the
reading column (`components/find-in-task.tsx`), never a dialog: you are
narrowing the thing you are looking at, and a modal would cover it. Box,
`3/17` counter, the two steppers, dismiss. Enter and ⇧Enter step and wrap,
Escape closes and gives focus back to the scroller, and pressing ⌘F again
selects what is already typed rather than doing nothing.

Two rules carry it:

- **The DOM is the haystack.** `GET /api/tasks/:id` has every turn, but a
  settled turn's activity is fetched on demand and dropped again (§5), so a
  search over the task JSON would count matches nobody can see and miss the
  ones inside a timeline just opened. Searching what is RENDERED is both
  simpler and more truthful — and when it finds nothing it names the turns it
  could not see (`data-activity="collapsed"`) instead of implying they were
  empty.
- **Highlighting never mutates the tree.** Matches are painted with the CSS
  Custom Highlight API — `::highlight(wisp-find)` and
  `::highlight(wisp-find-current)` in `index.css`, registered from
  `lib/find.ts`. Wrapping hits in `<mark>` would mean rewriting a tree React
  owns while a live turn appends to it, and would take the scroll contract's
  pin threshold and `overflow-anchor` with it. A webview without the API still
  counts and still walks; it says so in one muted line rather than pretending
  to paint.

**⌘⇧F — search every live task.** The box opens inside the sidebar and pushes
the tree DOWN (`components/project-search.tsx`): the projects are the context
for the answer, which is exactly why this is not a palette floating over the
app. A result is TWO lines, because a 26px row cannot say why it matched — the
task on the first, the daemon's own snippet on the second with the hit lit and
the field that answered it (`prompt 2`, `result 1`, `queued`). Same argument as
`TaskRowTouch`: the anatomy genuinely differs, so it is its own row rather than
a prop on the one that carries the tree. ↑/↓ walk the results from the box and
Enter opens one; the match count rides the right edge only when it is more than
one (§5b's "one short fact", and the §2 chip ban forbids the pill).

**Picking a result is ONE gesture.** It selects the task and issues the find
intent with the same query, so the transcript opens already looking for the
words. The two surfaces are one search, not two boxes that happen to rhyme.

**The scope is stated, never implied.** The daemon searches five places —
title, turn prompt, turn result, a queued or steered message, and the agent's
own prose from inside a turn. The empty state says so; a summary line with
results does not repeat it.

That fifth one is an INDEX, not a log scan: prose lives only in the per-turn
JSONL, which caps at 25 MB a turn and is the evidence ledger, so the daemon
projects it into `turn_texts` when the turn ends (`wispd/src/turn-texts.ts`).
Two consequences the UI owns:

- A row's field label distinguishes them — `said 3` is what the agent wrote
  mid-turn, `result 1` is how the turn concluded. A row shows ONE snippet, so
  which one is ranked rather than first-come (`displaySnippet`): never the
  `title`, which the row's own first line already says, and what was said
  before how it ended.
- While the daemon is catching up on turns older than the index, the response
  carries `indexing` and the pane prints one muted line — beside results, and
  INSTEAD of letting a miss read as final ("still indexing what the agent said
  in 412 older turns"). A search that has not read half your history must not
  look like one that has.

Tool calls and reasoning are deliberately still out. They are the same index
with another `kind`, which is what keeps adding them additive.

**Archived tasks are searched, and the pane's own switch decides whether you
see them.** They cost nothing to search (`LIKE '%x%'` cannot use an index, so
the filter only discarded rows already read), so the daemon flags every hit
instead of dropping it and the client chooses. With *Show archived* on they are
one `Archived` section under the live projects; with it off the rows are held
back and COUNTED — `· 1 archived task hidden` — because "no match" and "no
match I am willing to show you" are different sentences and only one of them
is true. When every hit is archived, the empty state names the switch.

**One layout owns the render AND the keyboard.** `lib/search-sections.ts`
returns the sections; ↑/↓ walk `searchOrder()` over the same layout. A ↓ that
skips a row you can see, or stops on one the switch is hiding, is worse than
no keyboard at all.

**A result row renders from the response alone.** The hit carries the task's
state and archived flag, so nothing resolves it against the client's task list
— that list does not contain archived tasks while the switch is off, and it
lags a task created since the last fetch, and both cases used to drop a real
hit without a word.

**Cross-version:** the daemon advertises `features.taskSearch` on
`/api/harnesses`, the same mechanism `taskAgentSwitching` uses. Absent reads as
unsupported: Wisp Desktop can hold a remote connection older than this route,
and there the pane renders no search control and ⌘⇧F does nothing. ⌘F is
client-side and always works.

**Colour.** A match is a text RANGE, which is the family `::selection` already
belongs to, so the resting hit is `--find-match` (the neutral the app spends on
a selected row) and the current hit is `--find-match-current` (the selection's
own hue, one step louder — a caret you can find in a 40-turn transcript). Both
are paired in the two theme blocks; no app chrome takes either, so §1's five
accent places are untouched.

**The chords.** `hooks/useSearchShortcuts.ts` claims ⌘F and ⌘⇧F on the window,
taking both from the browser: the native find sees only what is rendered at
that instant and cannot say "none of the other twelve tasks either". This is
§5e's rule rather than an exception to it — what may not be intercepted above
the composer is a BARE key, because the textarea forwards ↑/↓/Home/End/↵ to
cmdk and owns the rest of what it is typing. A ⌘ chord is never in that set,
which is how `lib/desktop-zoom.tsx` already claims ⌘+/−/0.

## 5j. First run — the empty state IS the onboarding

`components/start-here.tsx` replaces the centre column when a connection has
no tasks. It is not a tour, a carousel, a coach mark or a route, and adding one
later is a regression, not a feature. Three reasons, all of them specific to
this app:

- A tour teaches the happy path to someone whose daemon is not running. It
  cannot know which wall this person is behind.
- It goes stale the moment the shell moves, and nothing fails when it starts
  lying — it is invisible to every gate.
- "Has this person been onboarded" is not one bit here. It is one bit **per
  daemon**, and Desktop has up to five.

So the panel is DERIVED and owns no state. `lib/first-run.ts` builds its rows
from `LocalSetupReport`, `GET /api/harnesses` and `GET /api/repos`;
`hooks/useFirstRunPanel.ts` binds them to the active connection. There is no
`hasOnboarded` flag, nothing per-connection to keep straight, and nothing in
Settings to restart it (§5g). It shows because `tasks.length === 0`, and it
stops for the same reason — archive every task and it comes back, correctly,
which is the behaviour a veteran wants from an empty workspace anyway.

The rules it exists to keep:

- **Exactly one primary action** (§1), and it is the first outstanding step
  that can be acted on **from inside the app**. `primaryStepKey` decides;
  a component never picks a second. Installing a harness happens in a
  terminal, so that row's button is `outline` and a quiet line says so.
- **The row COUNT is derived too.** The browser owns one daemon and that
  daemon served the page, so it has no "Wisp is running" row at all and the
  heading counts down to "Two things". A step that can only be green teaches
  nothing.
- **A step that cannot be evaluated says so.** When Local is not running, the
  harness and project rows read *"Checked once Wisp is running."* with no
  action — never faked green, never hidden, and never answered from a cache
  the current daemon never filled.
- **Hue on the 6px marker and nowhere else.** Filled `state-done`, a neutral
  `state-creating` ring, `state-failed` for blocked. No badges, no chips, no
  progress bar, no step numbers: it is a status list you keep, not a sequence
  you finish.
- **It replaces the whole centre column, and the top bar shows no task.** That
  band said *"Select a task"* over a panel already explaining there were none.
  The right column keeps its panes — they show the workspace you are about to
  get, which is worth seeing, and they no longer repeat the centre.
- **The heading is a 14.5px title, not a second eyebrow.** The centre pane has
  none.

When every row passes it collapses to one **New task** button and two
sentences — the branch-and-worktree contract, delivered at the one moment it
becomes true rather than in a slide nobody read. The base is named only when a
project actually configured one: `""` means "let Wisp resolve the remote
default", which is not a branch name, so the sentence omits it rather than
inventing `main`.

### An empty state ends in the control, not in a noun

The panel is the centre column's share of this; the sidebar owes the same debt
and it is the same bug three times over. A placeholder that names an
affordance instead of being one is unfinished:

- **No projects** ends in an `Add project…` button, not in a sentence pointing
  at an unlabelled folder icon in the pane header.
- **A project with zero tasks** turns its *"No tasks yet"* line INTO the
  create control. Hover-reveal is right for a dense populated list and wrong
  when the row's only content is an empty state — a fresh install has exactly
  one project, no tasks, and otherwise no visible way to make one.
- **The error row carries its own repair.** A tasks/status failure takes an
  `errorAction` from the caller, because only the caller knows which repair
  applies: a stopped local daemon needs setting up, anything else needs
  another try. An indicator that is not also the door to its fix is half a
  feature — which is exactly what the `Local` tab's red glyph still is, and
  why the panel and this row are the two doors to `LocalSetupDialog` rather
  than a third one in the header (§5g: two gears for one room).

**The browser registers projects too.** A browser cannot produce an absolute
path, so it does not ship a picker — it ships the daemon-side path field a
remote Desktop tab already used (`AddProjectDialog`, with its own `hint`
naming whose filesystem the path is on). The disabled button it replaced meant
the web UI could not be taken from zero to one project without a terminal, on
the one surface — a phone — where that costs the most.

## 5k. The Autopilot tab — what auto-merge, auto-fix and auto-review are doing

`components/autopilot-pane.tsx` (`AutopilotPane`, drawn from its models by
`AutopilotView`). Autopilot is the first tab of the task panel, beside Changes
and Workflows, and the tab the panel opens on. The header says **which task
this is**; the tab says **where it stands**, and what Wisp is doing about its
PR. Its one section, **Automation**, fills the tab's scroller: the Auto-merge,
Auto-fix and Auto-review switch rows (Auto-review only where the daemon
advertises `features.autoReview`), the current PR's review rounds while
Auto-review is on (`auto-review-view.tsx`: a dot, the round and its
verdict, and an Open action for the reviewer task), then History. With
`features.reviewPanel` a round also says its tier (`deep review`, muted;
its `title` is what Wisp measured from the diff) and lists one row per
reviewer under it, A then B: the letter, the agent (`harness · model`), a
dot and its words (`Waiting for a slot`, `Kept` for a pass carried from an
earlier round on the head, `escalated: <reason>` when a light round's A
asked for B), and Open for that reviewer's task, which replaces the
round's own. A reviewer that stood in for a failed one carries a faint
`fallback` mark after its agent and a faint line under its row naming the
agent it replaced and why (`reviewFallbackWords`), in text so touch reaches
it; the line's `title` adds the failed task's own words. The row's `title` holds the findings, blocking first; there
is no red text, because a rejection's dot already carries it. A round from
before the panel (`legacy`) keeps its one line and a faint `before the
panel`. Without the flag every round is drawn exactly as phase 1.
With `features.capture` a **settled** reviewer's row is followed by its
evidence (`ReviewEvidence`): A's waived captures first, as a notice
(`Capture waived`, then `area — the reason Wisp recorded`, in the
needs-input amber), then small thumbnails that wrap — six, then
`+N more`, which shows the rest. Each loads through the output route with
`useAssetStatus` and expands in `AttachmentViewer`, as a turn's outputs do,
and says who made it: `Captured by Wisp` with `area · viewport · path`, or
`Published by the reviewer`. A capture served from outside the reviewer's
worktree says so in amber (the page may not be this change); an unknown
source and `after a script` are faint; the `title` holds the full URL.
Nothing says *verified* — a capture proves only what Wisp saw. A round
whose areas need a capture says `Needs a capture: web, admin` under its
line. While a round runs (`running`, `pending`, a withheld `submitted`)
no evidence is drawn, and without the flag none of this is. Words live in
`lib/auto-review-words.ts`.

- **Section headers are 12.5 / 600**, the §4 row size at a heavier weight, so
  they outrank the `Auto-merge` row under them without an eyebrow.
- **The switch rows.** The top line is the `role="switch"` hit target. Off,
  the second line teaches what the switch does (the empty state is the
  onboarding, §5j). On, the switch the reason speaks for (`autopilotSpeaker`)
  carries the live line: a dot in the sidebar rail's tone (§5f), `#PR` when
  the reason is about the PR, the reason, and how long it has stood. A
  needs-you or paused line is red, text and all. The other switch says one
  quiet fact (`On · merges #318 once it is ready`, `On · round 1 of 3`). The one action the state
  asks for (`autopilotAction`: Resume, Continue now, or Send now / Skip with
  its countdown) sits under that line as buttons.
- **History** (`autopilot-history-view.tsx`, words in `lib/autopilot-history.ts`):
  the three latest meaningful events, two lines each (the event word you scan
  down, then the detail with its links), and `All history N ›`, which swaps the
  pane for the dense per-PR log with a `‹ Autopilot` back row (the Workflows
  drill-down). The log groups by PR under sticky headers, folds each run of
  routine waits into one line (`Waiting · for checks ×7`, a click opens it),
  and has a `Routine checks` switch that opens them all. The dot carries the
  tone (violet merges, red trouble, faint routine); the words stay gray.
  `#PR` and a SHA link to GitHub when the task's PR names its repository and
  stay plain text otherwise; `View message` asks the conversation to scroll to
  the message an auto-fix round queued (`revealMessage`, `useRevealMessage`).
  The data is `GET /api/tasks/:id/autopilot/history` (`useAutopilotHistory`),
  refreshed by the SSE `workflow` event; a daemon without
  `features.autopilotHistory` draws no History at all and is never asked.
- **No red dot on the tab.** The rail and the PR icon already say it.
- **Which daemon, which tab.** `taskAutopilot` brings the tab. The panel
  opens on it; a person's own pick wins after that, and a daemon without it
  opens on Changes. All panes stay mounted, so a scroll position and the log
  survive a look at the diff. On touch it is its own surface in the
  mobile shell's strip (`Chat · Autopilot · Changes · Workflows · Terminal`);
  a task still opens on Chat.
- **The summary card's Autopilot row opens to these switch rows**
  (`Switches`, exported for it), and the phone's `⋯` menu keeps them as
  shortcuts — `Auto-merge #318`, `Auto-fix`, `Auto-review` — and nothing
  else: no reason notes, no action rows. A menu that repeats a paragraph is why this tab exists. Each surface
  owns its own write: a pending write or its error shows only on the control
  that sent it.

The gallery's *Autopilot tab* section draws every state from the real
components and models, one `data-frame` per state for screenshots.

## 5l. Motion — quick in, quicker out

Motion is part of how Wisp feels made, never decoration. It has one
vocabulary, defined once in `web/src/index.css` (*Motion*), and every rule
there turns instant under `prefers-reduced-motion`.

- **Tokens, not literals.** `--ease-out` arrives and settles; `--ease-spring`
  starts quick, goes ~4% past and rests; `--ease-glide` is a size change you
  can watch. `--dur-in` 180 ms, `--dur-out` 110 ms, `--dur-size` 200 ms. Never
  a bare `duration-300` or a hand-tuned `cubic-bezier` in a `className`.
- **Quick in, quicker out.** Leaving is always faster than arriving, and it
  never springs.
- **The spring is for small things you summoned:** a tooltip, a menu, a
  popover, a hover card. A modal is a big surface and eases in without one.
- **Grow from the source.** An anchored popup scales out of its trigger
  (base-ui's `--transform-origin`). The shared rule keys on
  `[data-side][data-align]` and the `data-starting-style` /
  `data-ending-style` base-ui sets, so a new menu or popover gets it for free.
  It animates the `scale` property, never `transform`, so a positioner's own
  translate is never fought. A drawer swipes and is left out.
- **Size glides; it does not jump.** The composer animates its height
  (`useAutosizeTextarea` measures, CSS moves) and reveals a new line rather
  than scrolling to it.
- **What you read never moves.** Streaming text, diffs and transcript rows
  appear without motion; only the containers around them move.

### Tooltips are a `title`

Name a control with a plain `title`, plus an `aria-label` when it is an icon.
`web/src/lib/title-tips.ts` shows every `title` as Wisp's own tooltip: it holds
the attribute aside while the tip is shown, so the browser draws nothing; the
tip opens as a hairline on the side facing the control, then unfolds. The
first one waits 450 ms; a neighbour right after opens at once, without the
unfold. Keyboard focus shows it too, except in a text field. Never wrap a
control in a tooltip component or draw one by hand. A tip is neutral: the
accent stays in its five places (§1). A device with no hover keeps the OS
behaviour.

## 5m. Subtasks — nested, rolled up, archived as a family

Gated on `features.subtasks`; without it the sidebar is flat and none of this
renders. One answer drives the sidebar and the keyboard alike:
`lib/subtask-tree.ts` (pure) nests each list, and `hooks/useSidebarTree.ts`
hands the same lists to `Sidebar` and to Ctrl+Tab (`visibleIds`), so the two
never disagree about which rows are on screen.

- **Nesting.** A task sits under its parent only when the parent is in the
  same list (a project, or one archive section); reviewers sit a level under
  the task they review. Roots sort by their FAMILY's latest activity, so a
  parent with a busy child does not sink; children keep the order they were
  made in, so a busy child does not reshuffle its siblings. The archive still
  splits into Cleanup then Archived first, and nests inside each.
- **Collapsed by default**, per parent, in connection storage
  (`useSubtaskDisclosure`). Selecting a hidden child from anywhere (search, a
  deep link, a notification, Ctrl+Tab) opens every parent above it ONCE:
  collapsing one again while the child stays selected sticks.
- **The disclosure is its own button beside the row**, never inside it (a
  button in a button, and opening must not select). It takes the left gutter
  on a pointer, and every row in a list with a family keeps that gutter so the
  dots line up; on touch it is a 44px target at the row's right edge.
- **The rollup** is the count plus one dot on a COLLAPSED parent: blue while a
  subtask runs (a reviewer counts: the parent's PR waits on it), amber when a
  subtask needs the person. A reviewer needing input lights nothing — Wisp
  answers it. Display only; nothing decides anything from it.
- **A subtask drawn apart from its parent** (the parent is archived, or in the
  other archive section) names it: `↳ <parent>`. An orphan says
  `parent deleted`.
- **The task view.** `SubtaskCrumb` puts `↳ <kind> subtask of <parent> · from
  <base>` over the title, and the parent's name opens it; the phone header
  carries it as one meta item. The **Subtasks** tab (`subtasks-pane.tsx`)
  lists children with state, kind, clipped result and where their reports
  stand. The daemon announces a child's change about the CHILD (a PR event
  moves a report without touching any task row), so the events bridge
  refreshes a parent's list for every event about it or one of its children
  (`lib/sse.ts`); nothing polls. On a phone the sheet offers the tool only while the
  task has subtasks, and if it goes while open, Chat takes over.
- **Reading the live task list** (a parent's title, a subtask count) goes
  through `useLiveTasks(select)`, which registers the list's real fetch with
  `enabled: false`. Never a `skipToken` query on that key: a query runs
  whichever observer's options were set last, so a passive reader there turned
  the next refresh into "Missing queryFn".
- **New subtask** (`new-subtask-dialog.tsx`, from the tab and the task menu) is
  the new-task composer scoped to the parent: kind, the base it pins
  (`subtaskBasePreview`), Report back (on), the agent pickers, and autopilot
  for `explore` only. Its draft is the parent's (`subtaskDraftScope`), apart
  from the project's. The daemon's refusals (caps, no PR, merge rights) show
  inline, verbatim.
- **Archiving a parent** goes through the same `useArchiveFlow` and dialog at
  all three entry points. The first attempt is unforced and without
  `subtasks`, so the daemon names the family; the dialog lists every child
  with what happens to it (`familyPlan`). Taking them (`subtasks: "archive"`),
  forcing them (`"force"`) and stopping their autopilot (`stopAutopilot`) are
  three separate yeses, and each one given is kept for the next attempt.
- **A report turn is Wisp's**, not the person's: `ReportBubble` sits on the
  left under Wisp's name, Wisp's fact lines first, each child's words quoted
  and labelled as theirs (`lib/report-text.ts` reads the fences back). Its end
  is no "finished" banner; the tracker treats report and background turns as
  one kind of quiet turn, and a person's turn that ended just before one is
  still news.

The gallery's *Subtasks* section draws the nesting, both rollup rules, the
archive's nesting, both family-confirm steps and a report turn.

## 5n. The summary card — where the task stands, at a glance

`task-summary-card.tsx` (the card), `task-summary-chip.tsx` (its folded
form), `hooks/useTaskSummary.tsx` (the model), `hooks/useSummaryCard.ts`
(the fold point and the remembered choices). On the phone the same card,
at touch size, is the top of the task sheet (§6b).

**Two quiet boxes in the centre pane's right gutter.** 240px, `bg-surface`,
a hairline, no shadow: it sits beside the reading column, not over it. It is
its own column of the pane's flex row (258px with its margin), so it can
never cover the transcript or the composer, and the reading column centres
in what is left. Box one is where the task stands, box two is the session:

| Row | Says | Opens to |
|---|---|---|
| State (lead) | `● Running 1m 07s`, `Done 4 min ago`, `Exited 1`; amber `Waiting for you · 1 question` | nothing; a waiting question makes it a button that brings the question on screen (`focusStream`) |
| Pull request | toned PR icon, `#318 · Open` (`None yet`, `Unavailable`; no row without a forge) | title, CI · review, merge state, *Open on GitHub* |
| Autopilot | the live reason in the rail's tone, or `Off` | the Automation section's own `Switches`, then *Open Autopilot ›* (history, rounds) |
| Subtasks | `● 1 running · 2` (amber `n waiting` first) | the children, each opens; *Open Subtasks ›* |
| Context | `84.0k` | the `/tokens` report |

There is no gauge beside the context number: Wisp does not know a model's
window, and a bar against a guessed one would be a lie. Box two is dropped
when it has no row.

**One read per fact, no new polling.** The model reads what the app already
reads: the task row (state, autopilot, context), the selected PR status the
sidebar shares (`usePullRequests`), the live task list for the children
(`useSubtaskChildren`, no request), and `GET /api/tasks/:id/usage` only while
Context is open, on the key the composer's `/tokens` uses (`useTokensReport`).
The words are shared too: `pullRequestWords`, `autopilotReason` and
`autopilotTint`, `outcomeWord`.

**Rows open in place**, a base-ui Collapsible each. Which rows are open is
remembered per row for every task in this browser (`wisp_summary_card_open`),
so a row you keep open stays open as you switch tasks. The lead row's clock
ticks by the second only while a turn runs; a settled task's "4 min ago" moves
by the minute (`useMinuteTick`). The card stays mounted across a task switch,
so a pending or refused autopilot write shows only on the task that sent it.

**The fold point is the pane, not the window.** A ResizeObserver on the
centre pane (`usePaneFitsCard`) keeps the card from 1000px
(`SUMMARY_CARD_MIN_PANE`: the 680px measure plus the gutter, and room to
breathe) and folds it below: 999px is the chip, 1001px the card. Opening a
tool is the common way across the line, and it never changes the window. The
first read happens before paint, so a wide pane never flashes the chip.

**The chip** is `● Running · ⎇ #318 ⌄` right after the title, and the
title's own dot moves into it: each fact has one quick look on screen, card
or chip, never both. It is a base-ui Popover (`POPOVER_SURFACE`,
`--z-menu`) holding the same card, grown from the chip by the shared rule.
It hangs from the top bar, so it never flips above it: it keeps its side
and is capped at base-ui's `--available-height`, scrolling inside, so a long
`/tokens` report or many children never push a row or its footer off screen.
A pointer focuses the popup itself and the keyboard the first row. A row that
acts (a question, a child, a panel) closes it.

**Owner decisions.** The card shows by default where there is room and folds
otherwise. A person can fold it on purpose (the card's `⌃`); the choice is
remembered (`wisp_summary_card_folded`, global like the panel's width), and
the chip's popover offers *Show beside the conversation* where it would fit.
Nothing opens by itself: a task that needs you changes its dot, the lead row
and the notification, never the layout.

**Motion.** The card eases up from 97% as it comes back (`--dur-in`,
`--ease-out`, no spring: a surface); a row's panel grows to base-ui's
`--collapsible-panel-height` on `--dur-size` / `--ease-glide` and closes on
`--dur-out`; the chevron turns. All of it is in index.css's Motion block
and instant under `prefers-reduced-motion`.

The gallery's *Summary card* section draws five states, open rows, the chip's
popover and the 999px / 1001px panes from the real components, one
`data-frame` each.

## 6. Panes and dividers

Every divider is draggable **and says so**: a hairline with a 3px grip in its
middle (`web/src/components/panes.tsx`). Panes carry no border toward a
handle — the handle *is* the divider, and a handle whose neighbour is closed is
not drawn and cannot drag it open. Layouts persist through the library's own
`useDefaultLayout`; never hand-roll layout JSON. The one exception is
`lib/pane-layouts.ts`, which moved the always-open right column's saved
layouts to the tool panel's new ids once (below).

The right of the shell is the **tool panel**, closed by default so the reading
column has the room. Terminal holds as many shells in the worktree as you want,
tabbed, each its own websocket, connecting only while its tab is active. A shell
with a program in the foreground puts a 6px dot on the top bar's Terminal icon,
so a finishing test run is visible without opening it.

The **daemon** keeps the tab list (`useShellTabs`, `taskTerminals`), so every
window shows the same tabs, and closing a tab hangs its shell up the way
closing a terminal window or an SSH session does. A close that would stop a
running program asks first; the daemon names the program, because only it can
see the shell's foreground. A tab is named for what it runs (a custom name,
then the foreground program, then the window title, then the shell), and a
repeated name is numbered in tab order. Numbers only count up, so a new tab is
never mistaken for the one just closed. Each tab's ⋯ holds rename, find,
clear, restart and close. Find is ⌘F on Apple platforms and Ctrl+Alt+F
elsewhere: plain Ctrl+F is readline's, and the terminal never takes a key the
shell uses.

### The tool panel: tools on demand

Tools are summoned, not resident. The top bar's icons (§5h) are **Terminal,
Changes, Autopilot (the pull-request icon), Subtasks and Workflows**, the last
three only where the daemon has them (`taskAutopilot`, `subtasks`,
`taskWorkflows`). An icon opens its tool in the panel and closes it when it is
the one showing; the open one wears `bg-accent`, no hue. Each icon carries its
glance form so the panel can stay closed: Changes counts files, Subtasks counts
children, Workflows counts the ones still watching, the PR icon takes its PR's
tone (`PULL_REQUEST_ICON_TONE`), and the Terminal gets the running dot. Every
count is the query the pane makes anyway: one key, one request.

**One tool at a time, and the Terminal docks.** Another icon swaps the panel's
upper tool. The Terminal is the one exception: opened while a tool is up, it
docks below it with a draggable divider (`ToolPanel`), because watching tests
while reading a diff is the common pair. Each tool's header ends in a close
control, and so does the Terminal's strip; Esc closes the tool when focus is in
it and nothing inside took the key. In the Terminal Esc is the shell's, so ⌃`
closes it there.

**Closing hides; it never unmounts.** Every pane stays mounted and `hidden`, so
the diff keeps its scroll, an open drill-down survives, and a shell keeps
running with its socket open and its scrollback growing. The Terminal alone
waits to mount until it is first shown for a task, so selecting a task does not
start a shell nobody asked for. A hidden xterm measures nothing (`shown`), and
it never fits to a sliver: a pane gliding open from zero, or a collapsed dock,
proposes the fit addon's two-column floor, which would reflow the scrollback and
SIGWINCH the shell for a size nobody sees (`MIN_FIT` in `shell-view.tsx`).
Shown again, it refits.

**Memory.** The open tool, or none, is remembered **per task**, per connection,
in this browser (`useToolPanel`), so switching tasks and coming back restores
it. The panel's **width** is one for every task, in px, and only a divider drag
changes it; dragging the divider past the panel's minimum closes the panel. New
tasks start closed, and **nothing ever opens by itself**: a task that needs you
changes its dot and its notification, never the layout.

**Keys.** ⌃` toggles the Terminal on every platform (VS Code's chord);
⌘\\ (Ctrl+\\ off Apple) closes the panel, or reopens what this task last had open,
or Changes for a task that never had a tool. A focused xterm passes both
through (`isTerminalToggleChord`, `isPanelChord` in `lib/terminal.ts`) rather
than sending them to the shell, except Ctrl+\\ off Apple, which is SIGQUIT and
stays the shell's. Both are modified chords on the window, like ⌘F (§5e's rule
is about bare keys). Neither is claimed by a browser or by Wisp Desktop, which
declares no menu accelerators. The `/` palette names each tool too (§5e).

**Focus.** Opening the Terminal gives its front shell the keyboard; a task
switch that lands on a task with its Terminal open does not, because a focused
xterm keeps Ctrl+Tab for the shell and task switching would stop there
(`claimTerminalFocus`). Closing a region that holds the focus hands it to the
composer, since focus in a `hidden` box is focus nowhere.

**Motion.** The panel's width glides open on `--dur-size` / `--ease-glide` and
shut on `--dur-out` / `--ease-out`, and only while it opens or closes
(`data-glide` on the group): a divider drag follows the pointer. Instant under
`prefers-reduced-motion`. A reload restores the layout without performing it.

**Saved layouts.** The always-open column saved `wisp-ui-main` (with a `right`
panel) and `wisp-ui-right` (Changes over Terminal). They moved once to
`wisp-ui-main-v2` (the panel's share back to the centre, closed, and its width
kept as the panel's open width) and `wisp-ui-dock`; an unreadable one is
dropped, so nobody opens to a broken layout.

The tool panel is the pointer shell's. The phone opens one tool full screen from its task sheet (§6b).

**Nothing that CREATES may sit at the right end of a pane's header.** Changes
keeps its Refresh there because refreshing acts on the view. Workflows put a
`+` there and it was wrong twice over: a `+` at the end of a header row is the
universal *new tab* affordance, and one divider below it the Terminal pane uses
exactly that glyph, in exactly that corner, to open a new SHELL TAB. Adding
belongs beside the things it adds to, so the Workflows pane ends its list in a
`+ New workflow…` row — a row the height of a file row in Changes, so it reads
as "one more of these" rather than as pane chrome.

**A workflow is state, so it gets a pane, not a dialog.** The first version of
this feature hung a button under the task header that opened a 640px modal.
Three things were wrong with that and none of them were the feature's: a scrim
sat between you and the task the automation was watching; "pick one" and
"configure it" stacked into one tall scroll that read as a bureaucratic form;
and *what is armed here?* — the one question a person actually has — could only
be answered by opening a door, because a button has room for a count and
nothing else.

The pane answers it on the row: **two lines, what it is and what it is waiting
for**, with the numbers, the controls and the history behind the same click a
file row in Changes takes. Adding is a drill-down in the same pane — picker,
then form, with a back row where a dialog would have put a close button — so
nothing about starting a workflow puts an overlay over the app. The form is ONE
column: a number field beside a prompt textarea is two fields of different
weight sharing a row, and it is most of why the modal read as paperwork.
**The primary says `Start`, not `Arm`.** The row it creates already offers
Pause, Resume and Remove, so Start is the verb that completes the set — and it
names what pressing it does. `Arm` was precise and borrowed from alarms and
explosives: the only word on the pane a reader had to already know.

**The UI and the CLI share one vocabulary**, so neither has to be translated
into the other: `Start` is `wisp workflow start`, `Pause`/`Resume` are
`pause`/`resume`, and `Complete` is `complete`. Completing files the row under
a collapsed **Completed** group rather than deleting it — a task that ran three
watches over a week should not open on three obituaries, and the history that
explains one has to survive it. The list therefore reads live rows → add →
archive.

The empty state keeps a bordered `outline` button rather than that quiet row,
for the reason the sidebar already draws its own two ways: a quiet affordance
is right in a dense populated list and wrong when it is the only thing on the
screen.

## 6b. Mobile — touch is not a small mouse

Below the `md` breakpoint (`useIsMobile`) the three-pane grid is **replaced,
not squeezed**: `MobileShell` renders a header, the conversation and a pinned
composer. No resizable group mounts there at all, so desktop pane geometry is
neither applied nor overwritten by phone dimensions. The task is the pointer
shell's model in three layers: the header (title and one status line), the
**task sheet** (the summary card plus the tools and the verbs), and **one tool
full screen**.

Short landscape phones also keep this shell: coarse input, at most 1023px
wide and 500px tall. Browser mobile windows follow the visual viewport when
the keyboard opens; Desktop keeps native window sizing. The browser's PWA
installation section lives in Settings, with its specimen in the gallery.

### The header is BANDED, and each band answers one question

This shell covers 320px to 767px — a phone AND a narrow Wisp Desktop window,
whose `minWidth` is 720 — so nothing in the header shares a line with
anything it does not belong to.

1. **The app band is Wisp Desktop's alone**, and it is not decoration. That
   window is `titleBarStyle: Overlay` with `hiddenTitle`, so the traffic lights
   float over whatever sits at the top left and a hidden title bar leaves the
   window nothing to drag by. The band is `pl-20` — the room the pointer shell's
   top bar already gives them — and `data-tauri-drag-region`, and it carries the
   connection switcher and the zoom control. A browser has neither problem and
   neither control, so it gets **no band at all**.
2. **The task band is `☰ | title over ONE status line | task button`**, padded
   by `var(--safe-top)`. The line is `● Running · ⎇ #318 open · CI pending`:
   the state, the toned PR icon with its number and lifecycle, CI only while
   the PR is open or a draft, then `Local` or `Archived` when true. The state
   keeps its width and the PR words truncate. The two lines are ONE 44px
   target (a stretched button under the words) that opens the sheet; while a
   question waits, the line reads `Waiting for you · 1 question` in amber and
   the same target goes to the question instead (`focusStream`, after the chat
   is back on screen). The task button (`Task sheet`) always opens the sheet.

There is no tab strip and no PR row: the old 6-tab strip took 185 of 844px
before the first word of the transcript.

### The task sheet

`task-sheet.tsx`, a base-ui `Drawer` swiped down to dismiss, max 640px wide so
a narrow Desktop window centres it. Top to bottom:

- id · harness · model · effort (and, for a subtask, `↳ kind subtask of
  Parent`, whose name opens the parent);
- the summary card itself (`SummaryCard` with `touch`): the same rows as §5n,
  each a 44px row, the Autopilot row opening to the touch-size switches;
- the tools in the top bar's order — Terminal, Changes, Autopilot, Subtasks
  (only while the task has some), Workflows — each with the small form of its
  state from `tool-hints.ts`, the one source the top bar's icons read too;
- Find, Rename, Subtask and Archive as 56px tiles (`useTaskVerbs`, the title
  menu's verbs), and *Export or delete task data…* on an archived task. A
  verb closes the sheet before its dialog opens.

Its body mounts only while it is open, so the card's reads run only then. It
rises on `--dur-in` / `--ease-out`, leaves on `--dur-out`, follows the finger
while swiped, and is instant under `prefers-reduced-motion` (`.wisp-sheet`).

### A tool on the phone is full screen

A tool replaces the conversation, with a 48px `‹ Chat` back row naming it
(Changes names itself in its own header). Every pane stays mounted, so
leaving one never drops the transcript's scroll or a live shell. A task
switch returns to the chat and closes the sheet.

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
  pointer is on it), and on touch archive is a tile in the **task sheet**,
  where a finger already reaches it. A long press for one verb would be the
  app's only long press.
- **Panes stay mounted when they are not shown**, so opening a tool never
  drops the conversation's scroll position or tears down a live shell. They are
  `hidden`, which means a pane can mount at zero height — anything measuring
  itself (xterm) must refit on activation, and any pane root needs `flex-1` as
  well as `h-full` so it fills a flex column as well as a resizable panel.
- **The composer is hidden on the Terminal.** Everywhere else it is
  pinned. On Terminal the shell itself is the input, and two composers fight
  over one keyboard.
- **The composer is one row of thumb targets**, it grows with the draft, and
  Return breaks a line rather than sending — §5c-ii, which owns that bar.
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
  `web/src/index.css` named by meaning, not by hue — and check it against
  the budget in §1 first.
- **Elevation and stacking are scales, not literals.** Three depths
  (`shadow-float` / `shadow-popover` / `shadow-modal`) and the layers
  (`z-(--z-pane)` through `z-(--z-tooltip)`), both defined once in
  `web/src/index.css`. Never write `shadow-[0_16px_40px_…]` or a bare
  `z-50`. A portalled popup does NOT win by being last in the DOM — DOM order
  only breaks ties between EQUAL z-indexes, so a surface that names no layer
  is painted over by any in-pane `z-10`. Shared popup chrome is
  `POPOVER_SURFACE` in
  `web/src/components/primitives.tsx`.
- **Tailwind class names must be literal.** State→class maps are static
  `Record`s in `web/src/lib/state.ts`; `bg-state-${state}` silently
  generates nothing.
- **No `dark:` overrides.** Two themes, one token contract: pair the value in
  both blocks of `web/src/index.css` and let the class on `<html>` choose
  (§1, *Two themes*). A `dark:` utility, a second hex in a component, or a
  token that exists in one block only is the same bug three ways.
- **`className` is for layout, not restyling.** Never override a primitive's
  colours or typography ad hoc. A new variant is born in
  `web/src/components/primitives.tsx` and reused.
- **Control heights are 22 / 26 / 32.** Rows are 26 (list), 34 (pane header),
  36 (top bar). Radii are 6 / 8 / 12. Space is 2 4 6 8 12 18 — not a 4/8 grid;
  dense tooling lives on odd numbers.
- **`flex` + `gap-*`**, never `space-x-*`/`space-y-*`. Equal dimensions:
  `size-*`, not `w-* h-*`. Truncation: `truncate`.
- **`cn()`** for conditional classes — no template-literal ternaries.
- **Icons:** `@fluentui/react-icons`, re-exported through
  `web/src/components/icons.tsx` so there is one import surface.
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
