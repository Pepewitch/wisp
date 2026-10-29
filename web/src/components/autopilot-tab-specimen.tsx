import type { ReactNode } from "react"

import type { AutoReviewEvidence, AutoReviewReview, AutoReviewRound, AutoReviewSignals } from "../../../shared/api/auto-review"
import type { AutopilotHistoryEntry, AutopilotStatus } from "../../../shared/autopilot"
import { AutopilotView, type AutomationModel, type HistoryLinks } from "@/components/autopilot-pane"
import { Section } from "@/components/gallery-chrome"
import { Tab } from "@/components/primitives"
import { cn } from "@/lib/utils"

/*
 * The Autopilot tab, drawn by the REAL components from fixed models: the same
 * `AutopilotView` and history grouping the app runs, fed
 * synthetic daemon answers (a made-up repository, PR numbers, SHAs and
 * reviewers). Lives outside `gallery.tsx` for the reason the other specimens
 * do — that file is the route, not a warehouse. Each frame carries a
 * `data-frame` id, so a screenshot can be taken of one state at a time.
 */

const NOW = Date.parse("2026-09-30T10:00:00Z")
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()
const noop = () => {}

/* ── auto-merge and auto-fix ────────────────────────────────────────────── */

const OFF: AutopilotStatus = {
  autoMerge: false, autoFix: false, pr: null, state: "off", reason: "", about: "task", by: "auto-merge",
  mergedByWisp: false, lastMerged: null, pendingFix: null, fixRounds: 0, done: false, updatedAt: null,
}
const WAITING: AutopilotStatus = {
  ...OFF, autoMerge: true, autoFix: true, pr: 318, state: "waiting", reason: "Waiting for checks (2 running)", about: "pr", fixRounds: 1, updatedAt: ago(3),
}
const PAUSED: AutopilotStatus = {
  ...WAITING, state: "paused", reason: "Merge failed twice: a required check, deploy-preview, never reported", updatedAt: ago(6),
}
const PENDING_FIX: AutopilotStatus = {
  ...WAITING, by: "auto-fix", reason: "Auto-fix will send: lint failed on 3f8e0c1", fixRounds: 0,
  pendingFix: { summary: "lint failed (no-unused-vars in save-guard.ts)", sendsAt: new Date(NOW + 45_000).toISOString() },
}
const DONE: AutopilotStatus = {
  ...WAITING, pr: null, reason: "#318 merged by Wisp · Waiting for the task's next PR", about: "task",
  lastMerged: { pr: 318, byWisp: true }, done: true, fixRounds: 0, updatedAt: ago(40),
}

/* ── history, newest first, in the daemon's own words ───────────────────── */

let seq = 0
const e = (min: number, kind: string, detail: string, pr: number | null, sha: string | null = null, messageId: string | null = null): AutopilotHistoryEntry =>
  ({ at: ago(min + (seq++ % 3) * 0.01), kind, detail, pr, sha, messageId })
const waits = (from: number, count: number, step: number, pr: number, detail: (i: number) => string) =>
  Array.from({ length: count }, (_, i) => e(from + i * step, "wait", detail(i), pr))

const H_WAITING: AutopilotHistoryEntry[] = [
  ...waits(3, 4, 4, 318, (i) => (i % 2 ? "Waiting for checks to start" : "Waiting for checks (2 running)")),
  e(20, "rerun", "Rerunning e2e (chromium)", 318, "5d2b8aa"),
  e(26, "wake", "lint failed (no-unused-vars in save-guard.ts)", 318, null, "m198"),
  ...waits(29, 6, 3, 318, (i) => (i % 2 ? "Waiting for checks to start" : "Waiting for checks (3 running)")),
  e(48, "bound", "Watching PR #318", 318),
  e(52, "armed", "Auto-merge on, Auto-fix on", null),
]

const H_PAUSED: AutopilotHistoryEntry[] = [
  e(6, "paused", "Merge failed twice", 318),
  e(7, "merge-failed", "Merge of #318 at 5d2b8aa failed: required status check \"deploy-preview\" is expected", 318, "5d2b8aa"),
  e(12, "merging", "Merging #318 at 5d2b8aa into main (squash) · checks green, approved by @reviewer-one", 318, "5d2b8aa"),
  e(14, "merge-failed", "Merge of #318 at 5d2b8aa failed: required status check \"deploy-preview\" is expected", 318, "5d2b8aa"),
  e(15, "merging", "Merging #318 at 5d2b8aa into main (squash) · checks green, approved by @reviewer-one", 318, "5d2b8aa"),
  ...H_WAITING.map((x) => ({ ...x, at: new Date(Date.parse(x.at) - 18 * 60_000).toISOString() })),
]

const H_RICH: AutopilotHistoryEntry[] = [
  e(38, "wait", "Waiting for a PR", null),
  e(40, "merged", "Merged #318 into main", 318, "9c41e07"),
  e(41, "merging", "Merging #318 at 9c41e07 into main (squash) · checks green, approved by @reviewer-one", 318, "9c41e07"),
  ...waits(43, 7, 4, 318, (i) => (i < 3 ? "Waiting for checks (2 running)" : i % 2 ? "Waiting for checks to start" : "Waiting for checks (1 running)")),
  e(72, "wake", "Review from @reviewer-one asks for a null check in saveDocument()", 318, null, "m203"),
  e(75, "judged", "@reviewer-one's review: needs changes (0.91)", 318),
  ...waits(78, 5, 6, 318, () => "Waiting for an approving review"),
  e(110, "rerun", "Rerunning e2e (chromium)", 318, "5d2b8aa"),
  e(125, "wake", "lint failed (no-unused-vars in save-guard.ts)", 318, null, "m198"),
  ...waits(128, 4, 8, 318, (i) => (i % 2 ? "Waiting for checks to start" : "Waiting for checks (3 running)")),
  e(165, "bound", "Watching PR #318", 318),
  e(170, "wait", "Waiting for a PR", null),
  e(60 * 22, "merged", "Merged #305 into main", 305, "b7e1d52"),
  e(60 * 22 + 1, "merging", "Merging #305 at b7e1d52 into main (squash) · checks green", 305, "b7e1d52"),
  e(60 * 22 + 30, "resumed", "Continued", 305),
  e(60 * 23, "paused", "Merge failed twice: the base branch was modified", 305),
  e(60 * 23 + 1, "merge-failed", "Merge of #305 at 2ac9f10 failed: the base branch was modified", 305, "2ac9f10"),
  ...waits(60 * 23 + 5, 12, 6, 305, (i) => (i % 2 ? "Waiting for checks to start" : "Waiting for checks (4 running)")),
  e(60 * 25, "wake", "2 failing checks: unit (save-queue.test.ts), typecheck", 305, null, "m141"),
  ...waits(60 * 25 + 5, 6, 6, 305, (i) => (i % 2 ? "Waiting for checks to start" : "Waiting for checks (4 running)")),
  e(60 * 26, "bound", "Watching PR #305", 305),
  e(60 * 26 + 2, "armed", "Auto-merge on, Auto-fix on", null),
]

function automationOf(status: AutopilotStatus, history: AutopilotHistoryEntry[] | null, rounds?: AutoReviewRound[], panel = false, capture = false): AutomationModel {
  return {
    status, locked: null, pending: false, error: null,
    history: history ? { entries: history, error: null } : null,
    reviews: rounds ? { rounds, error: null, onOpenTask: noop, panel, capture, evidenceSrc: capture ? shotOf : undefined } : null,
    onSet: noop, onAct: noop,
  }
}

/* ── auto-review ────────────────────────────────────────────────────────── */

const round = (id: string, n: number, head: string, state: AutoReviewRound["state"], min: number, over: Partial<AutoReviewRound> = {}): AutoReviewRound => ({
  id, pr: 318, head, round: n, counted: true, state, summary: null, findings: [], recipeFeedback: null, recipeArea: null,
  evidence: [], reviewerTaskId: `tr${id}`, recipeVersion: "3", createdAt: ago(min + 9), finishedAt: state === "running" ? null : ago(min), ...over,
})

const ROUNDS: AutoReviewRound[] = [
  round("4", 2, "9c41e07aa11", "running", 1),
  round("3", 1, "5d2b8aa0c3", "fail", 14, { summary: "Saving twice in one frame still sends two PUTs: the shortcut bypasses the store." }),
  round("2", 1, "5d2b8aa0c3", "recipe", 31, { counted: false, recipeFeedback: "The editor area's launch step needs a seeded document; the recipe never creates one.", recipeArea: "editor" }),
  round("1", 1, "3f8e0c1b44", "superseded", 52),
]
const ROUNDS_PASSED: AutoReviewRound[] = [
  round("5", 2, "9c41e07aa11", "pass", 3, { summary: "Saved by button, shortcut and autosave in one frame: one PUT each time. Toast unchanged." }),
  ...ROUNDS.slice(1),
]
const ROUNDS_SPENT: AutoReviewRound[] = [
  round("8", 3, "b7e1d52ffe", "inconclusive", 4, { summary: "The save toast never appeared, so the change could not be observed." }),
  round("7", 2, "2ac9f10de9", "fail", 30, { summary: "Autosave still races a manual save when the network is slow." }),
  round("6", 1, "4e5f6a7b8c", "error", 70, { summary: null }),
]

/* ── the review panel: a reviewer per row, A runs the app, B reads the code ── */

const AGENT_A = { harness: "claude", model: "opus-5" }
const AGENT_B = { harness: "codex", model: "gpt-5.6-luna" }

const review = (id: string, role: AutoReviewReview["role"], state: AutoReviewReview["state"], min: number, over: Partial<AutoReviewReview> = {}): AutoReviewReview => ({
  id, role, agent: role === "primary" ? AGENT_A : AGENT_B, state, summary: null, rationale: null, findings: [], reviewed: [], evidence: [],
  escalated: null, carried: false, reviewerTaskId: state === "pending" ? null : `tr${id}`, createdAt: ago(min + 9),
  finishedAt: state === "pending" || state === "running" ? null : ago(min), ...over,
})

const DEEP: AutoReviewSignals = {
  lines: 412, files: 9, areas: 2, unmapped: 0, sensitive: ["db/migrations/0042_save_queue.sql"], testsTouched: true, docsOnly: false,
}
const STANDARD: AutoReviewSignals = { lines: 138, files: 5, areas: 1, unmapped: 1, sensitive: [], testsTouched: true, docsOnly: false }
const LIGHT: AutoReviewSignals = { lines: 22, files: 2, areas: 1, unmapped: 0, sensitive: [], testsTouched: false, docsOnly: false }

/** A deep round under way: A has passed (its words withheld until B speaks), B still reviewing; under it a round from before the panel. */
const PANEL_DEEP: AutoReviewRound[] = [
  round("p2", 2, "e1f2a3b4c5d", "running", 1, {
    tier: "deep", signals: DEEP,
    reviews: [review("p2a", "primary", "pass", 2), review("p2b", "second", "running", 1)],
  }),
  round("p1", 1, "5d2b8aa0c3", "fail", 40, {
    legacy: true, reviews: [], summary: "Saving twice in one frame still sends two PUTs: the shortcut bypasses the store.",
  }),
]

/** B ended without a verdict; the next round on the same head kept A's pass and ran B again, which rejected it. */
const PANEL_KEPT: AutoReviewRound[] = [
  round("k2", 2, "9c41e07aa11", "fail", 3, {
    tier: "standard", signals: STANDARD, summary: "The shortcut path still bypasses the store's guard.",
    reviews: [
      review("k1a", "primary", "pass", 20, { carried: true, summary: "Saved by button, shortcut and autosave: one PUT each time." }),
      review("k2b", "second", "fail", 3, {
        summary: "The shortcut path still bypasses the store's guard.",
        findings: [
          { title: "The shortcut handler calls api.save() directly", file: "web/src/keys.ts", line: 41, severity: "blocking", lens: "correctness", by: "second" },
          { title: "guardSave() reads like a getter", severity: "note", lens: "slop", by: "second" },
        ],
      }),
    ],
  }),
  round("k1", 1, "9c41e07aa11", "error", 20, {
    tier: "standard", signals: STANDARD,
    reviews: [
      review("k1a", "primary", "pass", 20, { summary: "Saved by button, shortcut and autosave: one PUT each time." }),
      review("k1b", "second", "error", 22),
    ],
  }),
]

/** A light round: A asked for a second opinion, and B waits for a task slot. */
const PANEL_ESCALATED: AutoReviewRound[] = [
  round("e1", 1, "4e5f6a7b8c9", "running", 1, {
    tier: "light", signals: LIGHT,
    reviews: [
      review("e1a", "primary", "pass", 1, { escalated: "the two lines change how the session token is refreshed" }),
      review("e1b", "second", "pending", 0),
    ],
  }),
]

/** A's first agent failed on the network; its fallback took the round over and is reviewing, beside B. */
const PANEL_FALLBACK: AutoReviewRound[] = [
  round("f1", 1, "7a8b9c0d1e2", "running", 4, {
    tier: "standard", signals: STANDARD,
    reviews: [
      review("f1a", "primary", "running", 2, {
        agent: { harness: "claude", model: "opus-5" },
        fallback: {
          cause: "network", detail: "turn exited 1: getaddrinfo ENOTFOUND api.example.test",
          from: { harness: "droid", model: "kimi-k3", effort: null }, taskId: "tf1old", at: new Date(NOW - 3 * 60_000).toISOString(),
        },
      }),
      review("f1b", "second", "pass", 1),
    ],
  }),
]

/* ── captures: what Wisp itself saw, and what A waived ──────────────────── */

/** A stand-in page for a thumbnail: a header, a sidebar (not on mobile) and two cards; a reviewer's own image is dark. */
function shotOf(image: AutoReviewEvidence): string {
  const mobile = image.capture?.viewport === "mobile"
  const [page, bar, card] = image.capture ? ["#f6f6f4", "#e4e4e0", "#ffffff"] : ["#1d1d20", "#2b2b30", "#34343a"]
  const side = mobile ? "" : `<rect x="0" y="14" width="34" height="86" fill="${bar}"/>`
  const left = mobile ? 6 : 42
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100" viewBox="0 0 160 100"><rect width="160" height="100" fill="${page}"/><rect width="160" height="14" fill="${bar}"/>${side}<rect x="${left}" y="22" width="${150 - left}" height="30" rx="3" fill="${card}"/><rect x="${left}" y="58" width="${(150 - left) / 2}" height="24" rx="3" fill="${card}"/><rect x="${left + 6}" y="30" width="44" height="5" rx="2" fill="#AF87F1"/></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

const shot = (id: string, name: string, capture?: Partial<NonNullable<AutoReviewEvidence["capture"]>>): AutoReviewEvidence => ({
  turn: 3, id, name, mediaType: "image/png",
  capture: capture && {
    id: `cap${id}`, area: null, url: "http://127.0.0.1:5173/", servedFrom: "worktree", viewport: "desktop", scriptUsed: false, settled: true, ...capture,
  },
})

/** A passed with three captures — one of a page served from outside its worktree — and one image of its own. */
const CAPTURED_EVIDENCE: AutoReviewEvidence[] = [
  shot("s1", "settings-saved.png", { area: "web", url: "http://127.0.0.1:5173/settings/profile" }),
  shot("s2", "admin-users.png", { area: "admin", url: "http://127.0.0.1:3000/admin/users", servedFrom: "elsewhere", viewport: "mobile" }),
  shot("s3", "settings-toast.png", { area: "web", url: "http://127.0.0.1:5173/settings/profile#saved", viewport: "1440x900", scriptUsed: true, servedFrom: "unknown" }),
  shot("s4", "network-tab.png"),
]

const PANEL_CAPTURED: AutoReviewRound[] = [
  round("c2", 2, "a71c3e9d02f", "pass", 2, {
    tier: "standard", signals: STANDARD, required: ["web", "admin"],
    summary: "One PUT per save on every path; the toast shows once.",
    reviews: [
      review("c2a", "primary", "pass", 3, { summary: "Saved by button, shortcut and autosave: one PUT each time.", evidence: CAPTURED_EVIDENCE }),
      review("c2b", "second", "pass", 2, { summary: "The store's guard covers every caller." }),
    ],
  }),
]

/** A could not capture the admin area, and said why; the web area it did capture. */
const PANEL_WAIVED: AutoReviewRound[] = [
  round("w1", 1, "6b0d9e4c71a", "pass", 4, {
    tier: "standard", signals: STANDARD, required: ["web", "admin"],
    reviews: [
      review("w1a", "primary", "pass", 5, {
        summary: "The settings page saves once; the admin page could not be opened.",
        evidence: [CAPTURED_EVIDENCE[0]!],
        waivers: [{ area: "admin", reason: "the admin app needs a VPN login Wisp's browser does not have (refused: 401 at /admin/login)" }],
      }),
      review("w1b", "second", "pass", 4, { summary: "No concerns in the diff." }),
    ],
  }),
]

/** More than six images: the strip folds the rest behind `+N more`. */
const PANEL_MANY: AutoReviewRound[] = [
  round("m1", 2, "c0ffee12ab3", "pass", 2, {
    tier: "deep", signals: DEEP, required: ["web"],
    reviews: [
      review("m1a", "primary", "pass", 3, {
        summary: "Every settings tab saves once.",
        evidence: ["profile", "billing", "team", "tokens", "webhooks", "danger", "audit", "export"].map((tab, i) =>
          shot(`m${i}`, `${tab}.png`, { area: "web", url: `http://127.0.0.1:5173/settings/${tab}` })),
      }),
      review("m1b", "second", "pass", 2),
    ],
  }),
]

const REVIEW_OFF: AutopilotStatus = { ...WAITING, autoReview: false, reviewRounds: 0 }
const BUDGET = { reviewBudget: 3, reviewSpent: 0 } as const
const REVIEWING: AutopilotStatus = {
  ...WAITING, autoReview: true, by: "auto-review", reviewRounds: 2, ...BUDGET, reviewSpent: 1,
  reason: "Auto-review round 2 · 1 of 3 rejections used: A reviewing", updatedAt: ago(1),
}
const REVIEW_QUIET: AutopilotStatus = { ...WAITING, autoReview: true, reviewRounds: 2, ...BUDGET, reviewSpent: 1 }
const REVIEW_PAUSED: AutopilotStatus = {
  ...WAITING, autoFix: false, autoReview: true, by: "auto-review", state: "paused", reviewRounds: 3, ...BUDGET, reviewSpent: 3,
  reason: "Auto-review did not pass after 3 rounds — resume to try again", updatedAt: ago(4),
}
const HELD_HEAD = "9c41e07aa11b2c3d4e5f60718293a4b5c6d7e8f9"
const REVIEW_HELD: AutopilotStatus = {
  ...WAITING, autoReview: true, by: "auto-review", reviewRounds: 1, ...BUDGET, reason: "Waiting for checks (2 running) before auto-review",
  reviewNow: { head: HELD_HEAD, requested: false },
}
const REVIEW_HELD_FIX: AutopilotStatus = { ...PENDING_FIX, autoReview: true, reviewRounds: 1, ...BUDGET, reviewNow: { head: HELD_HEAD, requested: false } }
const REVIEW_ASKED: AutopilotStatus = {
  ...REVIEW_HELD, reason: "Waiting for a free task slot to start the reviewers", reviewNow: { head: HELD_HEAD, requested: true },
}
const REVIEW_EARLY: AutopilotStatus = {
  ...REVIEW_HELD, reviewRounds: 2, reason: "Auto-review round 2 · 0 of 3 rejections used (started by you, checks still running): A reviewing", reviewNow: null, updatedAt: ago(1),
}
const REVIEW_ON_READY: AutopilotStatus = {
  ...REVIEW_EARLY, reason: "Auto-review round 2 · 0 of 3 rejections used (started on ready, checks still running): A reviewing",
}
const REVIEW_FIX_AFTER: AutopilotStatus = {
  ...REVIEW_ON_READY, by: "auto-fix", reason: "Auto-review round 2 · 0 of 3 rejections used: A reviewing · Auto-fix will send after the review: 1 review thread",
  pendingFix: { summary: "1 review thread", sendsAt: new Date(NOW + 45_000).toISOString(), afterReview: true },
}

const REPOSITORY = "https://github.com/example/editor"
const LINKS: HistoryLinks = { repository: REPOSITORY, pullRequest: { number: 318, lifecycle: "open" }, onViewMessage: noop }
const MERGED_LINKS: HistoryLinks = { ...LINKS, pullRequest: { number: 318, lifecycle: "merged" } }

/* ── frames ─────────────────────────────────────────────────────────────── */

/** The mobile shell's strip, which names the surface on touch (the pane draws no header of its own there). */
function TouchStrip() {
  return (
    <div role="tablist" aria-label="Task surface" className="flex h-11 shrink-0 items-center gap-1 border-b border-border bg-surface px-1.5">
      {["Chat", "Autopilot", "Changes", "Workflows", "Terminal"].map((name) => (
        <Tab key={name} size="lg" active={name === "Autopilot"} className="h-full flex-1 basis-auto justify-center px-1">{name}</Tab>
      ))}
    </div>
  )
}

function Panel({
  touch = false,
  width = 420,
  height,
  children,
}: {
  touch?: boolean
  width?: number
  height: number
  children: ReactNode
}) {
  return (
    <div
      className={cn("flex flex-col overflow-hidden rounded-lg border border-border", touch ? "bg-background" : "bg-sidebar")}
      style={{ width, height }}
    >
      {touch && <TouchStrip />}
      {children}
    </div>
  )
}

function Frame({ id, title, note, children }: { id: string; title: string; note: string; children: ReactNode }) {
  return (
    <div data-frame={id} className="w-fit p-2">
      <div className="mb-3 max-w-[860px]">
        <div className="text-[12.5px] font-semibold text-foreground">{title}</div>
        <p className="mt-0.5 max-w-[720px] text-[11.5px] leading-relaxed text-muted-foreground">{note}</p>
      </div>
      <div className="flex flex-wrap items-start gap-6">{children}</div>
    </div>
  )
}

function Caption({ children }: { children: ReactNode }) {
  return <div className="mb-2 text-[11.5px] text-muted-foreground">{children}</div>
}

function TabPane({
  automation,
  links = LINKS,
  touch = false,
  log = false,
}: {
  automation: AutomationModel
  links?: HistoryLinks
  touch?: boolean
  log?: boolean
}) {
  return (
    <AutopilotView
      // the tool panel's close control, so the header reads as it does in the app
      onClose={touch ? undefined : noop}
      touch={touch}
      now={NOW}
      automation={automation}
      links={links}
      initialView={log ? "log" : "overview"}
    />
  )
}

export function AutopilotTabSpecimen() {
  return (
    <Section title="Autopilot tab — what auto-merge, auto-fix and auto-review are doing">
      <div className="flex flex-col gap-10">
        <Frame id="autopilot-a" title="Everything off, no history"
          note="Every off switch's second line teaches what it does.">
          <Panel height={360}><TabPane automation={automationOf({ ...OFF, pr: 318 }, [])} /></Panel>
        </Frame>
        <Frame id="autopilot-b" title="Armed and waiting"
          note="The live line sits under the switch it speaks for, in the rail's blue.">
          <Panel height={440}><TabPane automation={automationOf(WAITING, H_WAITING)} /></Panel>
        </Frame>
        <Frame id="autopilot-c" title="Needs you, with its action"
          note="The red and Resume sit under the switch that paused. Right: a fix round about to send (Send now / Skip), which is not red.">
          <Panel height={540}><TabPane automation={automationOf(PAUSED, H_PAUSED)} /></Panel>
          <div>
            <Caption>…with a fix round about to send</Caption>
            <Panel height={260}><TabPane automation={automationOf(PENDING_FIX, null)} /></Panel>
          </div>
        </Frame>
        <Frame id="autopilot-d" title="Merged by Wisp, rich history, and All history"
          note="The switches stay on across merges (violet, waiting for the next PR). History shows the 3 latest meaningful events; All history swaps the pane for the per-PR log (right), with ‹ Autopilot to come back.">
          <Panel height={640}><TabPane automation={automationOf(DONE, H_RICH)} links={MERGED_LINKS} /></Panel>
          <Panel height={640}><TabPane automation={automationOf(DONE, H_RICH)} links={MERGED_LINKS} log /></Panel>
        </Frame>
        <Frame id="autopilot-e" title="An older daemon: no history"
          note="Without features.autopilotHistory the History sub-section is not drawn, not even its label.">
          <Panel height={240}><TabPane automation={automationOf(WAITING, null)} /></Panel>
        </Frame>
        <Frame id="autopilot-f" title="Touch, 390px: needs you"
          note="The mobile strip, with Autopilot first after Chat. Rows and actions reach 44px. Right: All history on touch.">
          <Panel touch width={390} height={844}><TabPane touch automation={automationOf(PAUSED, H_PAUSED)} /></Panel>
          <Panel touch width={390} height={844}><TabPane touch automation={automationOf(PAUSED, H_PAUSED)} log /></Panel>
        </Frame>
        <Frame id="autopilot-review" title="Auto-review: the third switch, and its rounds"
          note="On a daemon with features.autoReview the third switch teaches what it does while off. When the reviewer is the speaker the live line sits under it; otherwise it says one quiet fact, the round it is on. Reviews lists the current PR's rounds, newest first: the dot carries the verdict (green pass, blue reviewing, red rejected or no verdict, amber where a person may look, faint superseded), and Open selects the reviewer task.">
          <div>
            <Caption>Off, teaching</Caption>
            <Panel height={360}><TabPane automation={automationOf(REVIEW_OFF, null, [])} /></Panel>
          </div>
          <div>
            <Caption>Reviewing a new head, the reviewer speaking</Caption>
            <Panel height={420}><TabPane automation={automationOf(REVIEWING, null, ROUNDS)} /></Panel>
          </div>
          <div>
            <Caption>Passed, while auto-merge speaks</Caption>
            <Panel height={420}><TabPane automation={automationOf(REVIEW_QUIET, null, ROUNDS_PASSED)} /></Panel>
          </div>
          <div>
            <Caption>Three rounds spent: paused, with Resume</Caption>
            <Panel height={470}><TabPane automation={automationOf(REVIEW_PAUSED, null, ROUNDS_SPENT)} /></Panel>
          </div>
          <div>
            <Caption>Touch</Caption>
            <Panel touch width={390} height={520}><TabPane touch automation={automationOf(REVIEWING, null, ROUNDS)} /></Panel>
          </div>
        </Frame>
        <Frame id="autopilot-review-now" title="Review now: a round on this head without waiting for its checks"
          note="On a project whose auto-review starts after checks pass, offered under Auto-review only while it holds a head with no round yet: its checks still running or failed, or an auto-fix countdown ahead of it. One click for one head: a push cancels it, a rejection from its round spends the budget like any other, and auto-merge still waits for green checks.">
          <div>
            <Caption>Checks still running</Caption>
            <Panel height={300}><TabPane automation={automationOf(REVIEW_HELD, null, ROUNDS.slice(1))} /></Panel>
          </div>
          <div>
            <Caption>…with an auto-fix countdown ahead of it</Caption>
            <Panel height={300}><TabPane automation={automationOf(REVIEW_HELD_FIX, null, ROUNDS.slice(1))} /></Panel>
          </div>
          <div>
            <Caption>Asked for, waiting for a slot</Caption>
            <Panel height={300}><TabPane automation={automationOf(REVIEW_ASKED, null, ROUNDS.slice(1))} /></Panel>
          </div>
          <div>
            <Caption>Its round, started by you</Caption>
            <Panel height={400}><TabPane automation={automationOf(REVIEW_EARLY, null, ROUNDS)} /></Panel>
          </div>
          <div>
            <Caption>Touch</Caption>
            <Panel touch width={390} height={600}><TabPane touch automation={automationOf(REVIEW_HELD_FIX, null, ROUNDS.slice(1))} /></Panel>
          </div>
        </Frame>
        <Frame id="autopilot-review-ready" title="Auto-review on ready: a round alongside CI, and a fix held for it"
          note="By default a round starts once a head is out of draft and has settled for a couple of minutes, while its checks still run. Evidence auto-fix gathers meanwhile (review threads, red CI) waits for the round: it says it sends after the review, with no countdown, and goes once the round settles. Send now and Skip still act on it.">
          <div>
            <Caption>Started on ready, checks still running</Caption>
            <Panel height={400}><TabPane automation={automationOf(REVIEW_ON_READY, null, ROUNDS)} /></Panel>
          </div>
          <div>
            <Caption>A fix held until the round settles</Caption>
            <Panel height={420}><TabPane automation={automationOf(REVIEW_FIX_AFTER, null, ROUNDS)} /></Panel>
          </div>
          <div>
            <Caption>Touch</Caption>
            <Panel touch width={390} height={640}><TabPane touch automation={automationOf(REVIEW_FIX_AFTER, null, ROUNDS)} /></Panel>
          </div>
        </Frame>
        <Frame id="autopilot-review-panel" title="Auto-review's panel: a row per reviewer, and the tier"
          note="On a daemon with features.reviewPanel each round says its tier (deep, standard or light; its title is what Wisp measured from the diff) and lists its reviewers under it: the letter (A runs the app and reviews the code, B reads the code only), the agent, a dot and its words, and Open for that reviewer's task. Kept is a pass carried from an earlier round on the same head; a light round's A may escalate, and a reviewer waiting for a task slot says so. A reviewer that stood in for one whose task failed on the network, its provider or setup is marked fallback; its title names whom it replaced and why. A round from before the panel keeps its one line and a faint hint.">
          <div>
            <Caption>A deep round under way, over a round from before the panel</Caption>
            <Panel height={420}><TabPane automation={automationOf(REVIEWING, null, PANEL_DEEP, true)} /></Panel>
          </div>
          <div>
            <Caption>A kept review, and a rejection with findings</Caption>
            <Panel height={460}><TabPane automation={automationOf(REVIEW_QUIET, null, PANEL_KEPT, true)} /></Panel>
          </div>
          <div>
            <Caption>A light round, escalated: B waits for a slot</Caption>
            <Panel height={360}><TabPane automation={automationOf(REVIEWING, null, PANEL_ESCALATED, true)} /></Panel>
          </div>
          <div>
            <Caption>A&apos;s agent failed on the network: its fallback reviews the same round</Caption>
            <Panel height={460}><TabPane automation={automationOf(REVIEWING, null, PANEL_FALLBACK, true)} /></Panel>
          </div>
          <div>
            <Caption>Touch</Caption>
            <Panel touch width={390} height={560}><TabPane touch automation={automationOf(REVIEWING, null, PANEL_DEEP, true)} /></Panel>
          </div>
        </Frame>
        <Frame id="autopilot-review-captures" title="Auto-review's evidence: what each reviewer showed, and who made it"
          note="On a daemon with features.capture a settled reviewer's row is followed by its images: small thumbnails that expand in the viewer, each saying who made it. Captured by Wisp carries the area, viewport and path Wisp opened; a page served from outside the reviewer's worktree is amber (it may not be this change), an unknown source and a script are quiet. Published by the reviewer is the reviewer's own image. Nothing says verified: a capture proves only what Wisp saw. A's waived captures are a notice, and a round whose areas need a capture says which. While a round runs nothing is drawn.">
          <div>
            <Caption>Captures from the worktree, one from elsewhere, and one the reviewer published</Caption>
            <Panel height={480}><TabPane automation={automationOf(REVIEW_QUIET, null, PANEL_CAPTURED, true, true)} /></Panel>
          </div>
          <div>
            <Caption>A waived a capture, and said why</Caption>
            <Panel height={420}><TabPane automation={automationOf(REVIEW_QUIET, null, PANEL_WAIVED, true, true)} /></Panel>
          </div>
          <div>
            <Caption>Touch, with more than six images</Caption>
            <Panel touch width={390} height={600}><TabPane touch automation={automationOf(REVIEW_QUIET, null, PANEL_MANY, true, true)} /></Panel>
          </div>
        </Frame>
      </div>
    </Section>
  )
}
