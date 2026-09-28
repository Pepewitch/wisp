import { useState, type ReactNode } from "react"

import { Section } from "@/components/gallery-chrome"
import { Meta, StateDot } from "@/components/primitives"
import { TaskBriefBand } from "@/components/task-brief"
import { briefBand, type BriefView } from "@/lib/brief"

/*
 * The task brief band, drawn by the real component from real models: the
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

/**
 * A centre column with a real height, because the band's cap is a share OF the
 * column (60%): in a box that grows with its content the cap would chase itself.
 */
function Column({ children, height }: { children: ReactNode; height?: number }) {
  return (
    <div className="flex w-full flex-col overflow-hidden rounded-lg border border-border bg-background" style={height ? { height } : undefined}>
      <div className="border-b border-border px-4.5 pt-2.5 pb-3">
        <div className="text-[14.5px] font-semibold tracking-[-0.01em]">Stop duplicate saves in the editor</div>
        <Meta
          className="mt-1.5"
          items={[
            <span key="state" className="flex items-center gap-1.5"><StateDot state="done" /><span className="text-fg-secondary">Done</span></span>,
            <span key="agent">codex · <span className="font-mono">gpt-5.6-luna</span></span>,
          ]}
        />
      </div>
      {children}
      {height && <div className="flex flex-1 items-end px-4.5 pb-3 text-[12px] text-faint">…the conversation, pinned to its latest turn</div>}
    </div>
  )
}

function Band({ view, touch = false, startOpen = true }: { view: BriefView; touch?: boolean; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen)
  const model = briefBand(view, null, NOW)
  if (model.kind === "hidden") return null
  return <TaskBriefBand model={model} open={open} onOpenChange={setOpen} touch={touch} taskTitle="Stop duplicate saves in the editor" />
}

export function TaskBriefSpecimen() {
  const lines: BriefView[] = [
    { ...BASE, report: null, latestEligibleTurn: null, reasons: ["no-report"] },
    { ...BASE, report: null, latestEligibleTurn: null, reasons: ["awaiting-next-turn", "no-report"] },
    { ...BASE, report: null, latestEligibleTurn: { n: 5, status: "done", reported: false }, reasons: ["no-report"] },
    { ...BASE, report: null, supported: false, harness: "opencode", reasons: ["unsupported", "no-report"] },
  ]
  return (
    <Section title="Task brief — where the task stands, under its header">
      <div className="grid grid-cols-2 gap-10">
        <div className="flex flex-col gap-6">
          <Column height={760}><Band view={BASE} /></Column>
          <Column height={760}><Band view={NEWER} /></Column>
        </div>
        <div className="flex flex-col gap-6">
          <Column>
            <Band view={BASE} startOpen={false} />
            <div className="h-2" />
            <Band view={{ ...BASE, report: { ...BASE.report!, brief: { ...BASE.report!.brief, decision: null } }, reasons: ["newer-turn", "newer-turn-unreported"], latestEligibleTurn: { n: 5, status: "done", reported: false }, latestTurn: { n: 5, status: "done", contextN: 1 } }} startOpen={false} />
            <div className="h-2" />
            <Band view={{ ...BASE, report: { ...BASE.report!, turn: { ...BASE.report!.turn, status: "failed" } }, reasons: ["source-failed"] }} startOpen={false} />
            {lines.map((view, i) => (
              <div key={i}>
                <div className="h-2" />
                <Band view={view} />
              </div>
            ))}
            <div className="h-2" />
            <TaskBriefBand model={briefBand(undefined, new Error("offline"), NOW) as never} open={false} onOpenChange={() => {}} taskTitle="" onRetry={() => {}} />
          </Column>
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
            Collapsed, one line: the decision if one waits, otherwise the result, and one freshness fact. Open, your
            words as Wisp recorded them come first, then the agent&apos;s report under a divider that says whose it is and
            whether it predates you. No accent, no chips; Compare opens the options in place. On touch the collapsed row
            is two lines and an open brief replaces the chat rather than squeezing it. Reading never writes — the only
            switch is the task menu&apos;s <em className="not-italic text-foreground">Task brief</em>.
          </p>
          <div className="w-[390px]">
            <Column><Band view={BASE} touch startOpen={false} /></Column>
          </div>
        </div>
      </div>
    </Section>
  )
}
