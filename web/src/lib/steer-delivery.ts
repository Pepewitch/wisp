import type { ApiTask, SendWhen } from "@/lib/types"

/** The agent the composer will send to (the picker's choice). */
interface AgentTarget {
  harness: string
  model: string | null
  effort: string | null
  fast: boolean
}

/**
 * What pressing send does while a turn runs, as the composer says it:
 *
 *  - `steer`: the running turn takes the message at its next safe boundary.
 *  - `wait`: the turn has already answered and is exiting; the message starts
 *    the next turn right after.
 *  - `interrupt`: the turn cannot take it (no live input, a different agent,
 *    or a turn a restarted daemon re-adopted), so send stops it first.
 *  - `queue`: the person asked it to wait for the next turn.
 *  - `legacy`: a daemon older than the queue toggle, which steers when it can
 *    and otherwise queues, and never says which in advance.
 */
export type SteerAction = "steer" | "wait" | "interrupt" | "queue" | "legacy"

export function steerAction({
  task,
  blocked,
  supported,
  queued,
  choice,
}: {
  task: ApiTask | null
  blocked: boolean
  supported: boolean
  queued: boolean
  choice: AgentTarget | null
}): SteerAction | null {
  if (!task || !blocked) return null
  const input = task.turn_input
  if (!supported || input === undefined) return "legacy"
  if (queued) return "queue"
  // stuck between a turn row and its task state: nothing to aim a steer at
  if (input === null) return "legacy"
  const target = choice ?? {
    harness: task.harness,
    model: task.model,
    effort: task.effort ?? null,
    fast: task.fast === true,
  }
  const sameAgent =
    input.context_n === (task.context_n ?? 1) &&
    input.harness === target.harness &&
    input.model === target.model &&
    input.effort === target.effort &&
    input.fast === target.fast
  if (!sameAgent) return "interrupt"
  return input.mode
}

/** The `when` a send carries: omitted for an older daemon, which would refuse it. */
export function sendWhen(supported: boolean, action: SteerAction | null): SendWhen | undefined {
  if (!supported) return undefined
  return action === "queue" ? "next-turn" : "now"
}

/** The note above the composer while a turn runs; `warn` when a send would stop it. */
export function steerActionNote(action: SteerAction): { text: string; warn: boolean } {
  switch (action) {
    case "steer":
      return { text: "running · send steers this turn", warn: false }
    case "wait":
      return { text: "finishing · send starts the next turn", warn: false }
    case "interrupt":
      return { text: "running · send stops this turn, then sends", warn: true }
    case "queue":
      return { text: "running · send waits for the next turn", warn: false }
    case "legacy":
      return { text: "running · send won't interrupt", warn: false }
  }
}

/** The send button's name for a running turn; the glyph stays the arrow. */
export function steerSendLabel(action: SteerAction): { label: string; title: string } {
  switch (action) {
    case "steer":
      return { label: "Send to the running turn", title: "Send into the running turn at its next safe boundary" }
    case "wait":
      return { label: "Send for the next turn", title: "The turn is finishing; this starts the next one" }
    case "interrupt":
      return { label: "Stop and send", title: "Stop the running turn, then send this as the next one" }
    case "queue":
      return { label: "Queue message", title: "Queue this to start after the running turn ends" }
    case "legacy":
      return { label: "Send safely", title: "Send at a safe boundary, or queue for the next turn" }
  }
}
