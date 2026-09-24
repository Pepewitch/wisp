import { Section } from "@/components/gallery-chrome"
import { ROW_PR_SPECIMENS } from "@/components/gallery-fixtures"
import { POPOVER_SURFACE } from "@/components/primitives"
import { TaskCard, TaskRow } from "@/components/task-row"
import { STATUS, TASKS } from "@/lib/fixtures"
import { cn } from "@/lib/utils"

/*
 * Lives outside `gallery.tsx` for the reason the pull-request specimens do:
 * that file is the route, not a warehouse, and it sits at its size cap.
 */
/** A task with auto-merge or auto-fix on carries a rail, so a switch left on is never out of sight. */
export function AutopilotRailSpecimen() {
  const on = (over: Partial<NonNullable<(typeof TASKS)[number]["autopilot"]>>): NonNullable<(typeof TASKS)[number]["autopilot"]> => ({
    autoMerge: true, autoFix: true, pr: 42, state: "waiting", reason: "Waiting for checks (2 running)", about: "pr", by: "auto-merge",
    mergedByWisp: false, lastMerged: null, pendingFix: null, fixRounds: 0, done: false, updatedAt: null, ...over,
  })
  const rows = [
    { ...TASKS[4]!, autopilot: null },
    { ...TASKS[0]!, autopilot: on({ pr: null, reason: "Waiting for the task to finish", about: "task" }) },
    { ...TASKS[5]!, autopilot: on({}) },
    { ...TASKS[6]!, autopilot: on({ pr: null, reason: "#42 merged by Wisp · Waiting for the task's next PR", about: "task", lastMerged: { pr: 42, byWisp: true }, done: true }) },
    { ...TASKS[7]!, autopilot: on({ state: "needs-you", reason: "1 review thread still open", by: "auto-fix" }) },
  ]
  return (
    <Section title="Auto-merge and auto-fix — a rail you cannot miss">
      <div className="grid grid-cols-2 gap-10">
        <div className="w-[268px] self-start rounded-lg border border-border bg-sidebar p-1.5">
          {rows.map((task, index) => (
            <TaskRow key={task.id} task={task} status={STATUS[task.id]} pullRequest={index === 2 || index === 4 ? ROW_PR_SPECIMENS[0] : undefined} selected={index === 2} onSelect={() => {}} />
          ))}
        </div>
        <div>
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
            A 2px rail on the row&apos;s edge while either switch is on, so one left on is never out of sight: the workflow
            blue while it works, violet once it is done for now (its PR merged, or a quiet green PR under auto-fix), and
            red when it needs a person. No second glyph — the hover card says which switch is on and why.
          </p>
          <div className={cn(POPOVER_SURFACE, "mt-3 w-[302px] rounded-xl p-3.5")}>
            <TaskCard task={rows[4]!} status={STATUS[rows[4]!.id]} pullRequest={ROW_PR_SPECIMENS[0]} />
          </div>
        </div>
      </div>
    </Section>
  )
}

