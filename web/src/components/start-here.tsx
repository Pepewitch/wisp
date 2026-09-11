import { Plus, WispMark } from "@/components/icons"
import { Button } from "@/components/primitives"
import {
  allStepsDone,
  outstandingSentence,
  primaryStepKey,
  type FirstRunStep,
  type StepState,
} from "@/lib/first-run"
import { cn } from "@/lib/utils"

/**
 * The centre pane's empty state when this connection has no tasks — the one
 * surface a person who just installed Wisp is looking at.
 *
 * It is NOT a tutorial, a tour, or a route. It is a list of state rows built
 * from `lib/first-run.ts`, so it owns no state of its own: no "has onboarded"
 * flag, nothing per-connection to keep straight across Desktop's tabs, and
 * nothing in Settings to restart it (§5g). It shows because there are no
 * tasks, and it stops for the same reason.
 *
 * Three rules it exists to keep:
 *
 *  - ONE primary action (§1), and it is the first outstanding step you can act
 *    on from inside the app. Every other action is `outline`. `primaryStepKey`
 *    decides; this component never picks a second.
 *  - Hue lives on the 6px marker and nowhere else (§1). No badges, no chips,
 *    no progress bar, no step numbers — it is a status list you keep, not a
 *    sequence you finish.
 *  - The heading is a 14.5px title, NOT a second eyebrow: the centre pane has
 *    none, and one eyebrow per pane is the rule.
 *
 * When every step is done it collapses to one button and the two sentences
 * that are the whole conceptual teaching, delivered at the one moment they
 * become true rather than in a slide nobody read.
 */
const STEP_DOT: Record<StepState, string> = {
  done: "mt-[5px] size-1.5 bg-state-done",
  todo: "mt-[4.5px] size-[7px] border-[1.5px] border-state-creating",
  blocked: "mt-[5px] size-1.5 bg-state-failed",
}

const STEP_LABEL: Record<StepState, string> = {
  done: "done",
  todo: "outstanding",
  blocked: "blocked",
}

export function StartHere({
  steps,
  baseLabel,
  onNewTask,
  touch = false,
}: {
  steps: readonly FirstRunStep[]
  /** the branch a first task would fork from, when the daemon has resolved one */
  baseLabel: string | null
  onNewTask: (() => void) | undefined
  touch?: boolean
}) {
  const ready = allStepsDone(steps)
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto scroll-slim p-6">
      <div className={cn("w-full", touch ? "max-w-[330px]" : "max-w-[412px]")}>
        <WispMark className="mx-auto block size-[26px]" />
        <h2 className="mt-3.5 text-center text-[14.5px] font-semibold tracking-[-0.01em]">
          {ready ? "Ready" : "Start here"}
        </h2>
        <p className="mt-1.5 text-center text-[12px] leading-relaxed text-muted-foreground">
          {ready
            ? "Describe what you want done. Wisp takes it from there."
            : outstandingSentence(steps)}
        </p>
        {ready ? (
          <ReadyPanel
            steps={steps}
            baseLabel={baseLabel}
            onNewTask={onNewTask}
            touch={touch}
          />
        ) : (
          <StepList steps={steps} touch={touch} />
        )}
      </div>
    </div>
  )
}

function StepList({
  steps,
  touch,
}: {
  steps: readonly FirstRunStep[]
  touch: boolean
}) {
  const primary = primaryStepKey(steps)
  return (
    <ol className="mt-4.5 overflow-hidden rounded-xl border border-border bg-surface">
      {steps.map((step) => (
        <li
          key={step.key}
          className="flex gap-2.5 border-t border-border px-3.5 py-3.5 first:border-t-0"
        >
          <span
            role="img"
            aria-label={STEP_LABEL[step.state]}
            className={cn("shrink-0 rounded-full", STEP_DOT[step.state])}
          />
          <div className="min-w-0 flex-1">
            <h3
              className={cn(
                "text-[12.5px]",
                // a satisfied row has said what it had to say; it steps back
                // rather than competing with the one you still have to act on
                step.state === "done"
                  ? "font-normal text-muted-foreground"
                  : "font-medium"
              )}
            >
              {step.title}
            </h3>
            <p
              className={cn(
                "mt-0.5 text-[11.5px] leading-relaxed",
                step.state === "blocked"
                  ? "text-destructive"
                  : "text-muted-foreground"
              )}
            >
              {step.detail}
              {step.note && (
                <span className="text-faint"> {step.note}</span>
              )}
            </p>
            {step.action && (
              <div className="mt-2.5">
                <Button
                  size={touch ? "touch" : "md"}
                  tone={step.key === primary ? "primary" : "outline"}
                  disabled={step.action.pending}
                  onClick={step.action.onClick}
                >
                  {step.action.pending ? "Working…" : step.action.label}
                </Button>
              </div>
            )}
            {step.hint && (
              <p className="mt-2 text-[11.5px] leading-relaxed text-faint">
                {step.hint}
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}

function ReadyPanel({
  steps,
  baseLabel,
  onNewTask,
  touch,
}: {
  steps: readonly FirstRunStep[]
  baseLabel: string | null
  onNewTask: (() => void) | undefined
  touch: boolean
}) {
  return (
    <div className="mt-4.5 text-center">
      <Button
        size={touch ? "touch" : "lg"}
        tone="primary"
        disabled={!onNewTask}
        onClick={onNewTask}
      >
        <Plus />
        New task
      </Button>
      {/* The entire tutorial. Two sentences, once, at the moment they are true. */}
      <p className="mx-auto mt-3 max-w-[340px] text-[11.5px] leading-relaxed text-muted-foreground">
        Wisp gives this task its own branch and worktree
        {baseLabel && (
          <>
            {" from "}
            <code className="rounded bg-accent-wash px-1.5 py-px text-[11px] text-accent-soft">
              {baseLabel}
            </code>
          </>
        )}
        . The agent works there, not in your checkout.
      </p>
      {/* The checks do not vanish once they pass — they stop being the subject. */}
      <ul className="mt-4 flex flex-wrap items-center justify-center gap-x-3.5 gap-y-1.5">
        {steps.map((step) => (
          <li
            key={step.key}
            className="flex items-center gap-1.5 text-[11.5px] text-faint"
          >
            <span
              aria-hidden
              className={cn("shrink-0 rounded-full", STEP_DOT.done, "mt-0")}
            />
            {step.detail}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The gallery's static rendering of the panel's two ends. */
export function StartHereSpecimen() {
  const blocked: readonly FirstRunStep[] = [
    {
      key: "daemon",
      title: "Wisp is running",
      state: "blocked",
      detail: "The local Wisp profile has not been initialized on this Mac.",
      action: { label: "Set up local Wisp", onClick: () => undefined },
    },
    {
      key: "harness",
      title: "An agent to run",
      state: "todo",
      detail: "Checked once Wisp is running.",
    },
    {
      key: "project",
      title: "A project",
      state: "todo",
      detail: "Checked once Wisp is running.",
    },
  ]
  const ready: readonly FirstRunStep[] = [
    {
      key: "daemon",
      title: "Wisp is running",
      state: "done",
      detail: "Local · http://127.0.0.1:8710",
    },
    {
      key: "harness",
      title: "An agent to run",
      state: "done",
      detail: "claude, codex",
      note: "droid not probed on this machine",
    },
    { key: "project", title: "A project", state: "done", detail: "1 project" },
  ]
  return (
    <>
    <div className="grid grid-cols-2 gap-6">
      <div className="flex min-h-[340px] rounded-lg border border-border bg-background">
        <StartHere steps={blocked} baseLabel={null} onNewTask={undefined} />
      </div>
      <div className="flex min-h-[340px] rounded-lg border border-border bg-background">
        <StartHere
          steps={ready}
          baseLabel="main"
          onNewTask={() => undefined}
        />
      </div>
    </div>
    <p className="mt-4 text-[11.5px] leading-relaxed text-muted-foreground">
      Rows are live reads of the local setup report, <code>/api/harnesses</code>{" "}
      and <code>/api/projects</code> — never a script, so the browser (whose
      daemon served the page) renders two rows rather than three. Exactly ONE
      action is filled: the first outstanding step you can act on without
      leaving the app. A step that cannot be evaluated yet says so rather than
      being faked green or hidden. Hue lives on the 6px marker and nowhere else
      — no badges, no progress bar, no step numbers, because this is a status
      list you keep rather than a sequence you finish. When every row passes it
      collapses to one button and the two sentences that are the whole
      conceptual teaching. It owns no state: it shows because a connection has
      no tasks, and it stops for the same reason.
    </p>
    </>
  )
}
