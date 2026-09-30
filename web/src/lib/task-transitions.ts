import type { ApiTask, TaskState } from "./types"

/**
 * A task that was running and no longer is. `task` is the row as it looked
 * when the change was observed, so the caller can name it and word its state
 * without another fetch.
 */
export interface TaskTransition {
  readonly task: ApiTask
  readonly from: TaskState
  readonly to: TaskState
  /** set when this is auto-merge / auto-fix news rather than a finished turn */
  readonly autopilot?: "merged" | "needs-you" | "paused"
}

/**
 * Only a turn that was running can finish. `creating → failed` is a setup
 * failure the person is usually still looking at, and a task that appears
 * already done was never something they were waiting on.
 */
const WATCHED_FROM: TaskState = "running"

export type TaskStateSnapshot = ReadonlyMap<string, TaskState>

export function snapshotTaskStates(
  tasks: readonly Pick<ApiTask, "id" | "state">[]
): Map<string, TaskState> {
  return new Map(tasks.map((task) => [task.id, task.state]))
}

/**
 * The tasks whose running turn is one background work woke on its own after
 * the agent's answer (a monitor event, a background command finishing).
 */
export function snapshotBackgroundRuns(
  tasks: readonly Pick<ApiTask, "id" | "state" | "latest_turn_background">[]
): Set<string> {
  return new Set(tasks.filter((task) => task.state === WATCHED_FROM && task.latest_turn_background).map((task) => task.id))
}

/**
 * Every task whose previous observation was `running` and whose current row
 * is anything else. Archived rows are skipped: archiving interrupts the turn,
 * and telling someone about a task they just put away is noise. So is a turn
 * background work woke, which nobody asked for, when it ends done: the one
 * seen running (`backgroundRuns`; any, without it) and the latest are both one.
 * One that ends needing the person, or failing, is still news.
 */
export function finishedTransitions(
  previous: TaskStateSnapshot,
  tasks: readonly ApiTask[],
  backgroundRuns?: ReadonlySet<string>
): TaskTransition[] {
  const transitions: TaskTransition[] = []
  for (const task of tasks) {
    const from = previous.get(task.id)
    if (from !== WATCHED_FROM || task.state === WATCHED_FROM || task.archived)
      continue
    if (task.state === "done" && task.latest_turn_background && (backgroundRuns?.has(task.id) ?? true)) continue
    transitions.push({ task, from, to: task.state })
  }
  return transitions
}

/** Autopilot news worth a banner: it merged the PR, or it needs a person. */
const AUTOPILOT_NEWS = new Set(["merged", "needs-you", "paused"])

/** Per task: the autopilot state, and the last PR it merged (the switches stay on after a merge). */
export function snapshotAutopilot(tasks: readonly Pick<ApiTask, "id" | "autopilot">[]): Map<string, string> {
  return new Map(tasks.flatMap((task) => (task.autopilot ? [[task.id, `${task.autopilot.state}|${task.autopilot.lastMerged?.pr ?? ""}`] as const] : [])))
}

/**
 * Tasks whose autopilot has just reached news: Wisp merged the PR, or it
 * needs a person (or paused). A first sighting only seeds, and a merge by
 * someone else is not Wisp's news. `announced` remembers the news last told
 * per task: a round trip through "waiting" (a long turn, a GitHub blip) back
 * to the same state and reason is not news again.
 */
export function autopilotTransitions(
  previous: ReadonlyMap<string, string>,
  tasks: readonly ApiTask[],
  announced: Map<string, string> = new Map(),
): TaskTransition[] {
  const transitions: TaskTransition[] = []
  for (const task of tasks) {
    const status = task.autopilot
    const state = status?.state
    const before = previous.get(task.id)
    // Wisp merged a PR and stayed on for the next one: news, once per PR
    const mergedNow = status?.lastMerged?.byWisp ? status.lastMerged.pr : null
    if (status && before !== undefined && mergedNow !== null && before.split("|")[1] !== String(mergedNow) && !task.archived) {
      announced.set(task.id, `${mergedNow}|merged|`)
      transitions.push({ task, from: task.state, to: task.state, autopilot: "merged" })
      continue
    }
    // real progress on the PR (checks running, a fresh push) ends the news it
    // was: the same blocker coming back after it is news again. A detour about
    // the task (a busy turn, a GitHub blip, Stop) is not progress.
    if (status && state && !AUTOPILOT_NEWS.has(state) && status.about === "pr") announced.delete(task.id)
    if (!state || before === undefined || before.split("|")[0] === state || task.archived || !AUTOPILOT_NEWS.has(state)) continue
    if (state === "merged" && !status!.mergedByWisp) continue
    const news = `${status!.pr}|${state}|${status!.reason}`
    if (announced.get(task.id) === news) continue
    announced.set(task.id, news)
    transitions.push({ task, from: task.state, to: task.state, autopilot: state as TaskTransition["autopilot"] })
  }
  return transitions
}

/**
 * Per-connection state memory that outlives any one React view. The active
 * tab and the inactive-tab monitors observe the same connection at different
 * times; keeping the snapshot here means a tab switch neither loses a change
 * nor re-announces one.
 */
export interface TaskTransitionTracker {
  /** Record the latest task list; the first observation only seeds. */
  observe(connectionId: string, tasks: readonly ApiTask[]): TaskTransition[]
  forget(connectionId: string): void
}

export function createTaskTransitionTracker(): TaskTransitionTracker {
  const snapshots = new Map<string, TaskStateSnapshot>()
  const backgroundRuns = new Map<string, ReadonlySet<string>>()
  const autopilot = new Map<string, ReadonlyMap<string, string>>()
  const announced = new Map<string, Map<string, string>>()
  return {
    observe(connectionId, tasks) {
      const previous = snapshots.get(connectionId)
      const previousBackground = backgroundRuns.get(connectionId)
      const previousAutopilot = autopilot.get(connectionId) ?? new Map<string, string>()
      const told = announced.get(connectionId) ?? new Map<string, string>()
      announced.set(connectionId, told)
      snapshots.set(connectionId, snapshotTaskStates(tasks))
      backgroundRuns.set(connectionId, snapshotBackgroundRuns(tasks))
      autopilot.set(connectionId, snapshotAutopilot(tasks))
      return previous
        ? [...finishedTransitions(previous, tasks, previousBackground), ...autopilotTransitions(previousAutopilot, tasks, told)]
        : []
    },
    forget(connectionId) {
      snapshots.delete(connectionId)
      backgroundRuns.delete(connectionId)
      autopilot.delete(connectionId)
      announced.delete(connectionId)
    },
  }
}

export const taskTransitions = createTaskTransitionTracker()
