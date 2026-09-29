import { type ReactNode } from "react"

import { Section } from "@/components/gallery-chrome"
import { PaneHeader, Tab } from "@/components/primitives"
import { BriefBody, BriefSwitch } from "@/components/task-brief"
import { briefBand, type BriefView } from "@/lib/brief"

/*
 * The task brief tab, drawn by the real component from real models: the
 * same `briefBand()` the app runs, fed fixed daemon answers. Lives outside
 * `gallery.tsx` for the reason the other specimens do — that file is the
 * route, not a warehouse.
 */

const NOW = Date.parse("2026-09-28T10:12:00Z")

const DECISION = {
  question: "Where should the duplicate-save guard live?",
  recommendation: "In the document store, so every save path gets it.",
  options: [
    {
      label: "In the document store",
      gain: "Covers the button, the shortcut and autosave in one place.",
      downside: "Touches a module every editor shares; needs the full editor test run.",
      impact: "All editors. No API or file-format change.",
      effort: "Small — about the size of the current fix.",
    },
    {
      label: "In the save button only",
      gain: "Smallest change; already on the branch.",
      downside: "Autosave and the shortcut can still write twice.",
      impact: "Only the toolbar path; autosave users keep the bug.",
      effort: null,
    },
  ],
  unknowns: ["Whether the offline queue replays saves — not assessed."],
}

const BASE: BriefView = {
  enabled: true,
  generation: 1,
  archived: false,
  harness: "codex",
  supported: true,
  activation: "next-turn",
  report: {
    turn: { n: 4, status: "done", contextN: 1, endedAt: "2026-09-28T10:00:00Z" },
    revision: 1,
    savedAt: "2026-09-28T10:00:00Z",
    brief: {
      version: 1,
      goal: "Stop the editor saving a document twice, without changing how a normal save behaves.",
      outcome: "The double save came from the toolbar button firing on press and release; that path is fixed and its test passes. Autosave has the same race.",
      remaining: ["Guard autosave and the shortcut the same way.", "Check the fix in a real browser; only the unit test ran."],
      decision: DECISION,
    },
  },
  latestEligibleTurn: { n: 4, status: "done", reported: true },
  latestTurn: { n: 4, status: "done", contextN: 1 },
  latestInput: {
    kind: "message",
    id: "m1",
    text: "Also check the autosave path, but don't touch the public API.",
    truncated: false,
    length: 61,
    question: null,
    delivery: "steered",
    turnN: 4,
    at: "2026-09-28T09:52:00Z",
    legacy: false,
  },
  reasons: [],
}

const NEWER: BriefView = {
  ...BASE,
  latestInput: {
    ...BASE.latestInput!,
    id: "m2",
    text: "Go with the store. Before you start, list every place that calls save() so I can check nothing is missed — the plugin API, the offline queue and the collaborative session handler included.",
    length: 190,
    delivery: "queued",
    turnN: null,
    at: "2026-09-28T10:05:00Z",
  },
  reasons: ["newer-input"],
}

/** The right column's task panel, with a real height: the tab scrolls within it. */
function Panel({ children, height, touch = false, note }: { children: ReactNode; height?: number; touch?: boolean; note?: string }) {
  return (
    <div className="flex w-full flex-col overflow-hidden rounded-lg border border-border bg-sidebar" style={height ? { height } : undefined}>
      <PaneHeader touch={touch} className="pl-2">
        <div role="tablist" aria-label="Task panel" className="flex items-center gap-0.5">
          <Tab role="tab" size={touch ? "lg" : "sm"} active aria-selected>Brief</Tab>
          <Tab role="tab" size={touch ? "lg" : "sm"} count={3}>Changes</Tab>
          <Tab role="tab" size={touch ? "lg" : "sm"}>Workflows</Tab>
        </div>
      </PaneHeader>
      {/* the REAL switch row, with fixed props — not a re-implementation */}
      <BriefSwitch enabled disabled={false} note={note ?? null} error={null} touch={touch} onChange={() => {}} />
      <div className="scroll-slim @container min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  )
}

function Body({ view, touch = false }: { view: BriefView; touch?: boolean }) {
  const model = briefBand(view, null, NOW)
  if (model.kind === "hidden") return null
  return <BriefBody model={model} touch={touch} />
}

export function TaskBriefSpecimen() {
  const lines: BriefView[] = [
    { ...BASE, report: null, latestEligibleTurn: null, reasons: ["no-report"] },
    { ...BASE, report: null, latestEligibleTurn: null, reasons: ["awaiting-next-turn", "no-report"] },
    { ...BASE, report: null, latestEligibleTurn: { n: 5, status: "done", reported: false }, reasons: ["no-report"] },
    { ...BASE, report: null, supported: false, harness: "opencode", reasons: ["unsupported", "no-report"] },
  ]
  return (
    <Section title="Task brief — where the task stands, a tab of the task panel">
      <div className="grid grid-cols-2 gap-10">
        <div className="flex flex-col gap-6">
          <div className="w-[420px]"><Panel height={760}><Body view={BASE} /></Panel></div>
          <div className="w-[420px]"><Panel height={760}><Body view={NEWER} /></Panel></div>
        </div>
        <div className="flex flex-col gap-6">
          <div className="w-[420px]">
            <Panel height={520}>
              <Body view={{ ...BASE, report: { ...BASE.report!, brief: { ...BASE.report!.brief, decision: null } }, reasons: ["newer-turn", "newer-turn-unreported"], latestEligibleTurn: { n: 5, status: "done", reported: false }, latestTurn: { n: 5, status: "done", contextN: 1 } }} />
            </Panel>
          </div>
          {lines.map((view, i) => (
            <div key={i} className="w-[420px]"><Panel><Body view={view} /></Panel></div>
          ))}
          <div className="w-[420px]">
            <Panel>
              <BriefBody model={briefBand(undefined, new Error("offline"), NOW) as never} onRetry={() => {}} />
            </Panel>
          </div>
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
            The Brief is the first tab of the task panel, beside Changes and Workflows, and the one it opens on. It
            takes no height from the conversation. The switch on top turns briefs on and off, the same one as the
            task menu&apos;s <em className="not-italic text-foreground">Task brief</em>. Your words as Wisp recorded
            them come first, then the agent&apos;s report under a divider that says whose it is and whether it
            predates you. No accent, no chips; Compare opens the options in place. On touch it is a tab of its own,
            level with Changes.
          </p>
          <div className="w-[390px]">
            <Panel touch><Body view={BASE} touch /></Panel>
          </div>
        </div>
      </div>
    </Section>
  )
}
