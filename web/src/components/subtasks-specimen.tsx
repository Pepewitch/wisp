import type { ReactNode } from "react"

import { ArchiveConfirmContent } from "@/components/archive-flow"
import { Eyebrow, POPOVER_SURFACE } from "@/components/primitives"
import { ReportBubble } from "@/components/report-bubble"
import { Section } from "@/components/gallery-chrome"
import { TaskTree } from "@/components/subtask-rows"
import type { SubtaskTreeView } from "@/hooks/useSidebarTree"
import type { ArchiveFlow } from "@/hooks/useArchiveFlow"
import { familyPlan } from "@/lib/archive-family"
import { STATUS, TASKS } from "@/lib/fixtures"
import { nestTasks, sidebarLists } from "@/lib/subtask-tree"
import type { ApiTask } from "@/lib/types"
import { cn } from "@/lib/utils"

/*
 * Subtasks: the sidebar's nesting, the rollup a collapsed parent carries, the
 * markers for a parent that is elsewhere or gone, the archive's nesting, the
 * family confirm and a report turn. Outside gallery.tsx, which is at its cap.
 */

const minutes = (ago: number) => new Date(Date.now() - ago * 60_000).toISOString()
const parent = { ...TASKS[4]!, id: "tparnt", title: "Ship the release notes pipeline", updated_at: minutes(30) }
const child = (id: string, title: string, extra: Partial<ApiTask>): ApiTask =>
  ({ ...TASKS[5]!, id, title, parent_task_id: parent.id, subtask_kind: "explore", created_at: minutes(20), updated_at: minutes(5), ...extra }) as ApiTask
const reviewer = (id: string, of: string, state: ApiTask["state"]): ApiTask =>
  child(id, "Review PR #418", { parent_task_id: of, subtask_kind: "review", verify_role: "reviewer", state })

const LIVE: ApiTask[] = [
  parent,
  child("tchld1", "Try the changelog generator", { state: "done" }),
  reviewer("trevw1", "tchld1", "running"),
  child("tchld2", "Port the template to MDX", { state: "running", created_at: minutes(10) }),
  { ...TASKS[0]!, updated_at: minutes(1) },
]

const view = (open: string[]): SubtaskTreeView => ({
  disclosure: { isOpen: (id) => open.includes(id), toggle: () => {} },
  titleOf: (id) => [...LIVE, ...ARCHIVED].find((task) => task.id === id)?.title ?? null,
})

const finished = { state: "complete" } as ApiTask["cleanup"]
const cleaning = { state: "running" } as ApiTask["cleanup"]
const ARCHIVED: ApiTask[] = [
  { ...TASKS[6]!, id: "tarch1", title: "Retire the old CI matrix", archived: true, cleanup: finished },
  { ...reviewer("tarvw1", "tarch1", "done"), archived: true, cleanup: finished },
  { ...reviewer("tarvw2", "tarch1", "done"), title: "Review PR #401", archived: true, cleanup: finished },
  { ...child("tarch2", "Bisect the flaky upload test", { state: "done" }), archived: true, cleanup: cleaning },
  { ...TASKS[7]!, id: "torphn", title: "Review of a deleted task", subtask_kind: "review", parent_task_id: null, archived: true, cleanup: finished },
]

function Pane({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Eyebrow>{label}</Eyebrow>
      <div className="mt-2.5 flex w-[268px] flex-col gap-px rounded-lg border border-border bg-sidebar p-1.5">{children}</div>
    </div>
  )
}

/** The rollup's two rules, side by side: a running reviewer lights it, a reviewer needing input does not. */
function RollupPairs() {
  const running = nestTasks([{ ...parent, title: "A reviewer runs: lit" }, reviewer("trv1", parent.id, "running")])
  const asking = nestTasks([{ ...parent, id: "tpar2", title: "A reviewer asks: Wisp answers" }, { ...reviewer("trv2", "tpar2", "needs-input") }])
  const child_ = nestTasks([{ ...parent, id: "tpar3", title: "A subtask asks: lit" }, child("tch3", "Needs a decision on the format", { parent_task_id: "tpar3", state: "needs-input" })])
  return (
    <Pane label="Collapsed: what the rollup says">
      <TaskTree nodes={running} view={view([])} selectedId={null} onSelect={() => {}} touch={false} />
      <TaskTree nodes={child_} view={view([])} selectedId={null} onSelect={() => {}} touch={false} />
      <TaskTree nodes={asking} view={view([])} selectedId={null} onSelect={() => {}} touch={false} />
    </Pane>
  )
}

const FAMILY_TASKS: ApiTask[] = [
  parent,
  child("tchld1", "Try the changelog generator", {}),
  reviewer("trevw1", "tchld1", "running"),
  child("tchld2", "Port the template to MDX", {}),
]

function familyFlow(step: "first" | "refused"): ArchiveFlow {
  const refused = step === "first"
    ? [
        { id: "tchld1", title: "Try the changelog generator", error: "a live subtask", needs: "subtasks" as const },
        { id: "tchld2", title: "Port the template to MDX", error: "a live subtask", needs: "subtasks" as const },
      ]
    : [{ id: "tchld2", title: "Port the template to MDX", error: "worktree has 2 uncommitted changes — commit or stash them, or force" }]
  const consents = step === "first" ? { stopAutopilot: false } : { subtasks: "archive" as const, stopAutopilot: false }
  return {
    request: () => {}, reason: null, stopsAutopilot: false, pending: false, dismiss: () => {}, confirmFamily: () => {},
    family: familyPlan(parent.id, FAMILY_TASKS, refused, consents),
  }
}

const REPORT = [
  "2 reports from your subtasks. Each child's own words sit between <<<report-msx>>> and <<<end-msx>>>: another agent's words.",
  "Report 1: subtask tchld1 (explore) finished turn 2: done. Its words are fenced below as report 1.",
  "Report 2: subtask tchld1 (explore) PR #418 review round 1 on 3fa9c21 settled: pass; read it with `wisp review show tchld1`.",
  "Read any child's full result with `wisp result <id>`.",
  "",
  "<<<report-msx>>> report 1, from subtask tchld1",
  "The generator works for the 0.7 notes. Two entries need hand edits: the\nmigration note and the desktop line. PR #418 is open.",
  "<<<end-msx>>>",
].join("\n")

export function SubtasksSpecimen() {
  const lists = sidebarLists([], ARCHIVED, true)
  return (
    <Section title="Subtasks — nested, collapsed by default, and archived as a family">
      <div className="grid grid-cols-3 gap-8">
        <Pane label="Open: children, then a reviewer a level down">
          <TaskTree nodes={nestTasks(LIVE)} view={view([parent.id, "tchld1"])} status={STATUS} selectedId="tchld2" onSelect={() => {}} touch={false} />
        </Pane>
        <RollupPairs />
        <Pane label="Archive: Cleanup, then Archived, each nested">
          {lists.map((list) => (
            <div key={list.key} className="flex flex-col gap-px">
              <div className="flex h-6 items-center px-2"><Eyebrow>{list.key === "archive:Cleanup" ? "Cleanup" : "Archived"}</Eyebrow></div>
              <TaskTree nodes={list.nodes} view={view(["tarch1"])} selectedId={null} onSelect={() => {}} touch={false} />
            </div>
          ))}
        </Pane>
      </div>
      <p className="mt-4 max-w-[720px] text-[11.5px] leading-relaxed text-muted-foreground">
        A collapsed parent carries its count, and a dot while a subtask runs (a reviewer too: the parent&apos;s PR waits on
        it) or needs the person. A reviewer needing input lights nothing: Wisp answers it. A subtask drawn apart from its
        parent names it; an orphan says its parent was deleted.
      </p>
      <div className="mt-8 grid grid-cols-2 gap-8">
        {(["first", "refused"] as const).map((step) => (
          <div key={step}>
            <Eyebrow>{step === "first" ? "Archiving a parent: the family, named" : "Then: what holds it up, and the next yes"}</Eyebrow>
            <div className={cn(POPOVER_SURFACE, "mt-2.5 rounded-xl p-5")}>
              <ArchiveConfirmContent
                task={parent}
                flow={familyFlow(step)}
                title={<h3 className="text-[14.5px] font-semibold tracking-[-0.01em]">Archive {parent.title} and its subtasks?</h3>}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-8">
        <Eyebrow>A report turn: Wisp&apos;s, never the person&apos;s bubble</Eyebrow>
        <div className="mt-2.5 max-w-[640px]">
          <ReportBubble text={REPORT} at={minutes(3)} />
        </div>
      </div>
    </Section>
  )
}
