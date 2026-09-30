/**
 * One pass's due PRs, read a few at a time: rows of the same repository share
 * one GraphQL request (github.ts `snapshots`) instead of one each. A batch is
 * read when its first row's look starts, so its neighbours' looks, which run
 * beside it, get their PR as it is now. A PR GitHub answered with an error
 * (not found, say) fails its own look, and the rest of the batch still
 * counts; one missing, unparsed or no longer fresh, a look reads alone.
 */
import { unlessPaused } from "../github-budget"
import { getTask } from "../store"
import type { Task } from "../types"
import type { WorkflowRow } from "../workflows/store"
import { SNAPSHOT_BATCH, type AutopilotGitHub, type PrSnapshot } from "./github"
import { checkpointOf } from "./store"

/** A shared snapshot older than this is read again: a look must see the PR as it is. */
const SHARED_TTL_MS = 20_000

interface Batch {
  task: Task
  numbers: number[]
  read?: Promise<{ at: number; snapshots: Map<number, PrSnapshot | Error> }>
}

export class SnapshotBatches {
  private readonly batches = new Map<string, { batch: Batch; number: number }>()

  constructor(rows: WorkflowRow[], private readonly deps: {
    github: AutopilotGitHub
    repository: (task: Task, signal: AbortSignal) => Promise<string | null>
    now: () => number
  }) {
    if (!deps.github.snapshots) return
    const byRepo = new Map<string, { rowId: string; number: number; task: Task }[]>()
    for (const row of rows) {
      const checkpoint = checkpointOf(row)
      const task = getTask(row.task_id)
      // the rows whose look reads their bound PR first (a paused row only checks it is still open, on its own slow cadence)
      if (row.state !== "active" || !checkpoint.pr || checkpoint.stopHold || !task || task.archived) continue
      const list = byRepo.get(task.repo_path) ?? []
      if (!list.some((entry) => entry.number === checkpoint.pr)) list.push({ rowId: row.id, number: checkpoint.pr, task })
      byRepo.set(task.repo_path, list)
    }
    for (const list of byRepo.values()) {
      if (list.length < 2) continue
      for (let start = 0; start < list.length; start += SNAPSHOT_BATCH) {
        const members = list.slice(start, start + SNAPSHOT_BATCH)
        const batch: Batch = { task: members[0]!.task, numbers: members.map((member) => member.number) }
        for (const member of members) this.batches.set(member.rowId, { batch, number: member.number })
      }
    }
  }

  /**
   * The row's PR from its batch, or null: the look then reads it alone. A PR
   * GitHub answered with an error throws it, as a read of its own would. A
   * GitHub pause still stops the look.
   */
  async take(rowId: string, number: number, signal: AbortSignal): Promise<PrSnapshot | null> {
    const entry = this.batches.get(rowId)
    if (!entry || entry.number !== number) return null
    this.batches.delete(rowId)
    entry.batch.read ??= this.read(entry.batch, signal)
    const { at, snapshots } = await entry.batch.read
    if (this.deps.now() - at >= SHARED_TTL_MS) return null
    const snapshot = snapshots.get(number)
    if (snapshot instanceof Error) throw snapshot
    return snapshot ?? null
  }

  private async read(batch: Batch, signal: AbortSignal): Promise<{ at: number; snapshots: Map<number, PrSnapshot | Error> }> {
    const at = this.deps.now()
    const repository = await this.deps.repository(batch.task, signal)
    if (!repository) return { at, snapshots: new Map() }
    const snapshots = await this.deps.github.snapshots!(repository, batch.numbers, batch.task.repo_path, signal)
      .catch(unlessPaused(new Map<number, PrSnapshot | Error>()))
    return { at, snapshots }
  }
}
