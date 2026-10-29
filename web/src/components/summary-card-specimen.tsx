import { useState, type CSSProperties, type ReactNode } from "react"

import type { AutopilotStatus } from "../../../shared/autopilot"
import { PR_SPECIMEN } from "@/components/gallery-fixtures"
import { Eyebrow, Rule } from "@/components/primitives"
import { SummaryCard } from "@/components/task-summary-card"
import { SummaryChip } from "@/components/task-summary-chip"
import { TokensReport } from "@/components/tokens-panel"
import { TopBarLeft, TopBarTask } from "@/components/top-bar-task"
import { WispMark } from "@/components/icons"
import { SUMMARY_CARD_MIN_PANE, usePaneFitsCard } from "@/hooks/useSummaryCard"
import type { SummaryModel } from "@/hooks/useTaskSummary"
import { TASKS } from "@/lib/fixtures"
import type { ApiTask, PullRequestStatus } from "@/lib/types"

/*
 * The summary card and its chip (§5n), drawn by the real components from
 * fixed models: five states, a row open, the chip's popover, and the fold
 * point measured by the real ResizeObserver hook on frames 999px and 1001px
 * wide. Each frame carries a `data-frame` id for a one-state screenshot.
 */

const minutes = (ago: number) => new Date(Date.now() - ago * 60_000).toISOString()
const noop = () => {}

const OFF: AutopilotStatus = {
  autoMerge: false, autoFix: false, autoReview: false, pr: null, state: "off", reason: "", about: "task", by: "auto-merge",
  mergedByWisp: false, lastMerged: null, pendingFix: null, fixRounds: 0, done: false, updatedAt: null,
}
const WAITING: AutopilotStatus = {
  ...OFF, autoMerge: true, autoFix: true, autoReview: true, pr: 318, state: "waiting", reason: "Waiting for checks", about: "pr",
  fixRounds: 1, reviewRounds: 1, reviewBudget: 3, reviewSpent: 0, updatedAt: minutes(4),
}
const REVIEWING: AutopilotStatus = {
  ...WAITING, by: "auto-review", reason: "Auto-review round 1 · 0 of 3 rejections used (started on ready, checks still running): A reviewing",
}
const MERGED: AutopilotStatus = {
  ...WAITING, pr: null, state: "waiting", reason: "#318 merged by Wisp · Waiting for the task's next PR", about: "task",
  lastMerged: { pr: 318, byWisp: true }, done: true, updatedAt: minutes(12),
}
const pr = (over: Partial<typeof PR_SPECIMEN>): PullRequestStatus => ({
  kind: "found", provider: "github",
  pullRequest: { ...PR_SPECIMEN, number: 318, title: "Paginate the library view", url: "https://github.com/acme/library/pull/318", ...over },
})
const OPEN_PR = pr({ checks: "pending", review: "required", mergeState: "blocked" })
const FAILING_PR = pr({ checks: "failed", review: "required", mergeState: "blocked" })
const MERGED_PR = pr({ lifecycle: "merged", checks: "passed", review: "approved", mergeState: "ready" })

const base = { ...TASKS[0]!, title: "Paginate the library view", harness: "claude", model: "opus-5.5" }
const CHILDREN: SummaryModel["children"] = [
  { id: "tkid01", title: "Check how old offset links behave", state: "running", subtask_kind: "explore", background: undefined },
  { id: "tkid02", title: "Measure the list query on 50k rows", state: "done", subtask_kind: "explore", background: undefined },
]
const TOKENS = (
  <TokensReport
    harness="claude"
    turns={[
      { id: 1, n: 1, usage: { inputTokens: 41_200, outputTokens: 3_900, cachedInputTokens: 38_000 } },
      { id: 2, n: 2, usage: { inputTokens: 84_000, outputTokens: 2_100, cachedInputTokens: 80_500 } },
    ]}
    total={{ inputTokens: 125_200, outputTokens: 6_000, cachedInputTokens: 118_500 }}
    reportingTurns={2}
  />
)

function model(task: ApiTask, over: Partial<SummaryModel> = {}): SummaryModel {
  return {
    task,
    pullRequest: { kind: "none", provider: "github" },
    runningSince: null,
    settledAt: minutes(4),
    questionWaiting: false,
    autopilot: {
      switches: { status: task.autopilot ?? null, locked: null, pending: false, error: null, onSet: noop, onAct: noop },
      reviewable: true,
    },
    children: [],
    tokens: TOKENS,
    onJumpToQuestion: noop,
    onOpenTask: noop,
    onOpenTool: noop,
    ...over,
  }
}

const STATES: { frame: string; label: string; model: SummaryModel }[] = [
  {
    frame: "running",
    label: "Running, a PR open, auto-review on it",
    model: model({ ...base, state: "running", autopilot: REVIEWING, context_tokens: 84_000 }, {
      pullRequest: OPEN_PR, runningSince: new Date(Date.now() - 67_000).toISOString(), children: CHILDREN,
    }),
  },
  {
    frame: "needs-you",
    label: "Waiting for you",
    model: model({ ...base, state: "needs-input", autopilot: WAITING, context_tokens: 61_500 }, { pullRequest: OPEN_PR, questionWaiting: true }),
  },
  {
    frame: "failed",
    label: "Failed, CI red",
    model: model({ ...base, state: "failed", latest_turn_has_result: true, latest_turn_exit_code: 1, autopilot: { ...WAITING, by: "auto-fix", reason: "Auto-fix will send: lint failed on 3f8e0c1" }, context_tokens: 132_000 } as ApiTask, {
      pullRequest: FAILING_PR,
    }),
  },
  {
    frame: "merged",
    label: "Done, merged by Wisp",
    model: model({ ...base, state: "done", autopilot: MERGED, context_tokens: 97_300 }, { pullRequest: MERGED_PR, settledAt: minutes(12) }),
  },
  {
    frame: "idle",
    label: "Idle: no PR, autopilot off",
    model: model({ ...base, title: "Tidy the README install section", state: "done", autopilot: OFF }, { settledAt: minutes(2) }),
  },
]

function Frame({ frame, label, children }: { frame: string; label: string; children: ReactNode }) {
  return (
    <div data-frame={frame}>
      <Eyebrow>{label}</Eyebrow>
      <div className="mt-2">{children}</div>
    </div>
  )
}

export function SummaryCardSpecimen() {
  return (
    <section className="mt-9" data-specimen="summary-card">
      <div className="mb-4 flex items-center gap-3">
        <Eyebrow>Summary card — one row per fact, each opens in place</Eyebrow>
        <Rule />
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,240px)] gap-x-8 gap-y-6">
        {STATES.map((state) => (
          <Frame key={state.frame} frame={state.frame} label={state.label}>
            <SummaryCard model={state.model} openRows={[]} onFold={noop} />
          </Frame>
        ))}
        <Frame frame="autopilot-open" label="Autopilot open: the switches">
          <SummaryCard model={STATES[0]!.model} openRows={["autopilot"]} onFold={noop} />
        </Frame>
        <Frame frame="rows-open" label="Pull request and Subtasks open">
          <SummaryCard model={STATES[0]!.model} openRows={["pull-request", "subtasks"]} onFold={noop} />
        </Frame>
        <Frame frame="context-open" label="Context open: /tokens">
          <SummaryCard model={STATES[3]!.model} openRows={["context"]} onFold={noop} />
        </Frame>
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-muted-foreground">
        The card sits in the centre pane&apos;s right gutter, in its own column, so it never covers the reading column
        or the composer. Box one is where the task stands (its state, its pull request, autopilot); box two is the
        session (subtasks, context). Each fact is read once: the PR from the status the sidebar shares, the children
        from the live task list, the tokens only while Context is open. A question waiting turns the lead row amber,
        and clicking it brings the question on screen. Nothing opens by itself.
      </p>
      <ChipSpecimen />
      <FoldPointSpecimen />
    </section>
  )
}

/** Forty reporting turns: taller than any viewport left under the bar, so the popup has to scroll. */
const LONG_TOKENS = (
  <TokensReport
    harness="claude"
    turns={Array.from({ length: 40 }, (_, i) => ({
      id: i + 1,
      n: i + 1,
      usage: { inputTokens: 40_000 + i * 1_100, outputTokens: 1_200 + (i % 7) * 310, cachedInputTokens: 38_000 + i * 1_000 },
    }))}
    total={{ inputTokens: 2_458_000, outputTokens: 81_400, cachedInputTokens: 2_300_000 }}
    reportingTurns={40}
  />
)

function ChipSpecimen() {
  const running = { ...STATES[0]!.model, tokens: LONG_TOKENS }
  return (
    // in the app the popover is capped by the viewport left under the bar; here
    // by the frame too, so it scrolls inside its own box and covers no other one
    <div data-frame="chip-open" className="mt-6 h-[460px]">
      <Eyebrow>Folded: the chip beside the title, open, with a long /tokens report under Context</Eyebrow>
      <div style={{ "--sidebar-width": "180px" } as CSSProperties} className="mt-2 flex h-9 items-center rounded-lg border border-border bg-surface pr-3">
        <TopBarLeft desktop={false}>
          <WispMark className="size-[17px]" />
        </TopBarLeft>
        <div className="flex h-full min-w-0 flex-1 items-center pl-4.5">
          <TopBarTask
            task={running.task}
            dragRegion={false}
            chip={<SummaryChip task={running.task} pullRequest={running.pullRequest} defaultOpen popupClassName="max-h-[380px]" popup={() => <SummaryCard model={running} floating openRows={["context"]} />} />}
          />
        </div>
      </div>
    </div>
  )
}

/** A centre pane of a given width, folded or not by the same hook the shell uses. */
function FoldFrame({ width }: { width: number }) {
  const [pane, setPane] = useState<HTMLElement | null>(null)
  const fits = usePaneFitsCard(pane)
  const running = STATES[0]!.model
  return (
    <Frame frame={`fold-${width}`} label={`Centre pane ${width}px — ${fits ? "the card" : "the chip"}`}>
      {/* the pane itself is `width` wide: the hairline around it is outside what the hook measures */}
      <div className="w-fit overflow-hidden rounded-lg border border-border">
        <div style={{ width }} className="flex h-9 items-center border-b border-border bg-surface px-3">
          <TopBarTask
            task={running.task}
            dragRegion={false}
            chip={fits ? null : <SummaryChip task={running.task} pullRequest={running.pullRequest} popup={() => <SummaryCard model={running} floating openRows={[]} />} />}
          />
        </div>
        <div ref={setPane} style={{ width }} className="flex h-[300px] bg-background">
          <div className="min-w-0 flex-1 px-4.5 pt-4">
            <div className="mx-auto flex max-w-(--reading-measure) flex-col gap-2.5">
              {[92, 100, 64, 100, 88, 40].map((w, i) => (
                <span key={i} className="h-2.5 rounded-sm bg-hover" style={{ width: `${w}%` }} />
              ))}
            </div>
          </div>
          {fits && (
            <div className="w-[258px] shrink-0 pt-3 pr-4.5">
              <SummaryCard model={running} openRows={[]} onFold={noop} />
            </div>
          )}
        </div>
      </div>
    </Frame>
  )
}

function FoldPointSpecimen() {
  return (
    <div className="mt-6 flex flex-col gap-6">
      <FoldFrame width={SUMMARY_CARD_MIN_PANE - 1} />
      <FoldFrame width={SUMMARY_CARD_MIN_PANE + 1} />
      <p className="text-[11.5px] leading-relaxed text-muted-foreground">
        The fold point is the centre pane&apos;s own width, read by a ResizeObserver on the pane, never the window: a
        tool opening narrows the pane without the window changing. Below {SUMMARY_CARD_MIN_PANE}px the card folds into
        the chip beside the title, and the chip opens the same card as a popover. A person can fold it on purpose too
        (the card&apos;s ⌃), and the chip remembers that until they put it back.
      </p>
    </div>
  )
}
