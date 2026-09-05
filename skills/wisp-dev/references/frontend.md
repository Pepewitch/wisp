# Wisp frontend conventions

`web/ui/` is THE web app (vite + react + TS + tailwind v4 + shadcn on base-ui
primitives). It is the only one: the classic `web/index.html`, the abandoned
first rewrite in `web/app/`, and the vendored xterm in `web/vendor/` were all
deleted at the v0.2 cutover (D12). The daemon serves this app's committed
bundle at `/` and serves no other file, so `bun run build:ui` after a change
that ships — and never hand-edit `web/ui-dist/`.

This file is the law. `#/gallery` is the law rendered on real components — when
you add a primitive, add its gallery entry in the same diff. An undocumented
primitive is an incomplete change.

Every value below is in `web/ui/src/index.css`. Read it once; then never write
a hex in a component again.

---

## 1. Colour budget — the five places

The theme is a neutral near-black scale (never `#000`, no cast on the grays), a
four-level gray text hierarchy, and **one** violet:
`oklch(0.705 0.155 300)` = `#AF87F1`. Every accent shade is derived from that
hue at fixed lightness and chroma, so moving the hue moves the family without
touching contrast.

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
   `logMaxBytes` (5 MB default) **per turn** — eagerly retaining every settled
   body does not slow the tab down, it kills it.
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
- **The opening selection uses the browser's preferred model when available**,
  then prefers a harness that has a model list, so a daemon whose first harness
  has no installed binary does not open the composer already in the free-text
  fallback. Every model row has a star: setting or clearing it affects future
  create dialogs only, never the selection in the dialog already open. The
  preference is browser-local; a missing or retired model falls back normally.

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

Selection changes no draft text. The browser submits only `suffixPromptId`;
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
  control: the first click only arms a red **Remove?**, the second drops the
  config entry. Tasks stay and nothing on disk is deleted. A history-only
  repo (one Wisp only knows from tasks) has no config entry to drop, so the
  control is absent.
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
`look at src/lib /st` is a command. Filtering is cmdk's, driven by a
visually-hidden `Command.Input`; the textarea stays the real input and forwards
↑/↓/Home/End/↵ to the cmdk root. No component above the composer may install a
document-level key handler. The palette and report panels share one positioned
wrapper with the composer, so their left and right edges answer the input width,
not the outer footer before its responsive padding.

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
- **No `dark:` overrides.** v0.2 is dark-only: `<html class="dark">` and the
  token block are the whole theme. If light mode lands, pair every token then.
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

The chip ban, the diff pattern, the zero-CDN font rule and the
literal-class-name rule carry over unchanged — they were right.
