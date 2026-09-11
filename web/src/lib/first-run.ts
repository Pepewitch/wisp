import { isUsable, unusableReason } from "@/lib/model-choice"
import type { HarnessInfo } from "@/lib/types"

/**
 * The first-run readiness list, derived — never authored.
 *
 * Every row is a live read of something the app already fetches, so the panel
 * is the SAME surface on day 400 that it is on day 0: a step that goes back to
 * `todo` (a project removed, a daemon stopped) reports that, and there is no
 * "has onboarded" bit anywhere to disagree with it. A tutorial asserts; this
 * reports.
 *
 * The count of rows is not fixed either. The browser owns exactly one daemon
 * and that daemon served the page, so its "Wisp is running" row cannot fail
 * and is not rendered at all — a step that can only be green is a step that
 * teaches nothing.
 */
export type StepState = "done" | "todo" | "blocked"

export interface StepAction {
  readonly label: string
  readonly onClick: () => void
  readonly pending?: boolean
}

export interface FirstRunStep {
  readonly key: "daemon" | "harness" | "project"
  readonly title: string
  readonly state: StepState
  /** the row's own truth, in the register a person can act on */
  readonly detail: string
  /** the muted continuation of `detail` — what was looked for, and where */
  readonly note?: string
  readonly action?: StepAction
  /** one quiet line under the action, for what must happen OUTSIDE the app */
  readonly hint?: string
}

/**
 * `daemon` is null in the browser (see above). `harnesses` and `projectCount`
 * are `undefined` while their query is in flight — pending is its own state
 * and is never rendered as either answer.
 */
export interface FirstRunData {
  readonly daemon: {
    readonly ready: boolean
    /** the daemon's own recovery sentence, when it has one */
    readonly problem: string | null
    /** what to say once it IS ready — name, authority, version */
    readonly summary: string
  } | null
  readonly harnesses: readonly HarnessInfo[] | undefined
  readonly harnessesError: string | null
  readonly projectCount: number | undefined
}

export interface FirstRunActions {
  readonly onSetUpDaemon: () => void
  readonly onRecheckHarnesses: () => void
  readonly recheckPending: boolean
  readonly onAddProject: (() => void) | undefined
  readonly addProjectPending: boolean
}

/** A step that cannot be evaluated yet says so rather than guessing either way. */
const BLOCKED_BY_DAEMON = "Checked once Wisp is running."

function harnessStep(
  data: FirstRunData,
  actions: FirstRunActions,
  reachable: boolean
): FirstRunStep {
  const title = "An agent to run"
  if (!reachable)
    return { key: "harness", title, state: "todo", detail: BLOCKED_BY_DAEMON }
  if (data.harnessesError)
    return {
      key: "harness",
      title,
      state: "todo",
      detail: "Could not read the agent list.",
      note: data.harnessesError,
      action: {
        label: "Check again",
        onClick: actions.onRecheckHarnesses,
        pending: actions.recheckPending,
      },
    }
  if (data.harnesses === undefined)
    return { key: "harness", title, state: "todo", detail: "Checking…" }

  const usable = data.harnesses.filter(isUsable)
  const unusable = data.harnesses.filter((h) => !isUsable(h))
  if (usable.length > 0)
    return {
      key: "harness",
      title,
      state: "done",
      detail: usable.map((h) => h.name).join(", "),
      ...(unusable.length > 0
        ? {
            note: unusable
              .map((h) => `${h.name} ${unusableReason(h)}`)
              .join(" · "),
          }
        : {}),
    }
  return {
    key: "harness",
    title,
    state: "todo",
    detail: "No agent on this machine reported a model.",
    ...(data.harnesses.length > 0
      ? {
          note: `Looked for ${data.harnesses.map((h) => h.name).join(", ")}.`,
        }
      : {}),
    action: {
      label: "Check again",
      onClick: actions.onRecheckHarnesses,
      pending: actions.recheckPending,
    },
    // Installing a CLI happens in a terminal. Saying so is more honest than a
    // button that can only ever fail, and it is why this row WARNS rather than
    // gates: a project can be added while an agent is still being installed.
    hint: "Install one and authenticate it, then check again.",
  }
}

function projectStep(
  data: FirstRunData,
  actions: FirstRunActions,
  reachable: boolean
): FirstRunStep {
  const title = "A project"
  if (!reachable)
    return { key: "project", title, state: "todo", detail: BLOCKED_BY_DAEMON }
  if (data.projectCount === undefined)
    return { key: "project", title, state: "todo", detail: "Checking…" }
  if (data.projectCount > 0)
    return {
      key: "project",
      title,
      state: "done",
      detail:
        data.projectCount === 1 ? "1 project" : `${data.projectCount} projects`,
    }
  return {
    key: "project",
    title,
    state: "todo",
    detail: "A Git repository Wisp will branch from.",
    ...(actions.onAddProject
      ? {
          action: {
            label: "Add project…",
            onClick: actions.onAddProject,
            pending: actions.addProjectPending,
          },
        }
      : // A daemon this client cannot register a project on keeps the CLI
        // sentence the sidebar has always shown, rather than a dead button.
        { hint: "Run wisp project add <path> on the daemon host." }),
  }
}

export function buildFirstRunSteps(
  data: FirstRunData,
  actions: FirstRunActions
): readonly FirstRunStep[] {
  const steps: FirstRunStep[] = []
  // Nothing downstream can be evaluated against a daemon that is not answering,
  // so its state gates the other two rather than letting them render "0
  // projects" about a daemon that was never asked.
  const reachable = data.daemon === null || data.daemon.ready
  if (data.daemon)
    steps.push(
      data.daemon.ready
        ? {
            key: "daemon",
            title: "Wisp is running",
            state: "done",
            detail: data.daemon.summary,
          }
        : {
            key: "daemon",
            title: "Wisp is running",
            state: "blocked",
            detail:
              data.daemon.problem ??
              "Local Wisp is not running on this computer.",
            action: { label: "Set up local Wisp", onClick: actions.onSetUpDaemon },
          }
    )
  steps.push(harnessStep(data, actions, reachable))
  steps.push(projectStep(data, actions, reachable))
  return steps
}

/**
 * §1 allows ONE primary action per screen. It belongs to the first outstanding
 * step that can actually be acted on from here — an outstanding step below it
 * is real, but acting on it first would be acting out of order.
 */
export function primaryStepKey(
  steps: readonly FirstRunStep[]
): FirstRunStep["key"] | null {
  return steps.find((step) => step.state !== "done" && step.action)?.key ?? null
}

export function allStepsDone(steps: readonly FirstRunStep[]): boolean {
  return steps.every((step) => step.state === "done")
}

const COUNT_WORD = ["No", "One", "Two", "Three", "Four"] as const

/** "Two things, then your first task." — the row count is not hardcoded. */
export function outstandingSentence(steps: readonly FirstRunStep[]): string {
  const n = steps.length
  const word = COUNT_WORD[n] ?? String(n)
  return `${word} thing${n === 1 ? "" : "s"}, then your first task.`
}
