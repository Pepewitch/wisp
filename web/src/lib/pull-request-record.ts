import type {
  PullRequestOverviewEntry,
  PullRequestStatus,
} from "@/lib/types"

/**
 * ONE record of what every task's pull request has become.
 *
 * The same fact reaches the screen twice — the sidebar row's icon and the task
 * header's status line — and it used to arrive down two independent pipes.
 * `GET /api/tasks/:id/pull-request` refreshes the selected task every 30s;
 * `GET /api/pull-requests` refreshes the whole sidebar every 60s. Two timers,
 * two React Query caches, no relationship between them: merge a PR and the
 * header turned purple on its next tick while the row stayed gray on the old
 * overview payload for up to another minute, telling you two different things
 * about one PR at the same time.
 *
 * The daemon already reconciles the two caches BEHIND those endpoints — each
 * path writes its answers where the other one will read them — so this is the
 * browser doing what the daemon does: fold the two responses into one record,
 * and let both surfaces read the record. Neither can then be newer than the
 * other; they change in the same commit, in the same frame.
 *
 * Because the daemon shares its answers, the LATER of the two responses is
 * always the better one, whichever endpoint it came from. Both timestamps are
 * the browser's own `dataUpdatedAt`, so this holds for a remote daemon whose
 * clock disagrees with ours — and it is why the per-task poll does not get to
 * push a 29-second-old answer over an overview that just landed.
 */
export function reconcilePullRequests(
  overview: Record<string, PullRequestOverviewEntry> | undefined,
  selectedId: string | null,
  selected: PullRequestStatus | undefined,
  /** When each response arrived, by the one clock that will render them. */
  at: { selected: number; overview: number },
): Record<string, PullRequestOverviewEntry> {
  const tasks = overview ?? {}
  if (selectedId === null || selected === undefined) return tasks
  const known = tasks[selectedId]
  // The overview landed after the per-task poll did, so it already carries
  // that answer or a newer one. Reading it is the reconciliation.
  if (known !== undefined && at.overview > at.selected) return tasks
  const entry = foldSelected(known, selected, at.selected)
  return entry === known ? tasks : { ...tasks, [selectedId]: entry }
}

/**
 * The daemon's own rule for a failed lookup, applied here: an `unavailable` is
 * not an answer about the PR, it is the absence of one, so it must never
 * overwrite what we last knew. It marks that answer stale instead — which is
 * also how the header stops silently dropping a PR it could still describe the
 * moment one `gh` call fails.
 */
function foldSelected(
  known: PullRequestOverviewEntry | undefined,
  selected: PullRequestStatus,
  checkedAt: number,
): PullRequestOverviewEntry {
  if (selected.kind !== "unavailable") {
    // Stamped from the browser rather than kept from the overview because the
    // only thing that reads it renders it with `since()` — against this clock.
    return { status: selected, checkedAt: new Date(checkedAt).toISOString(), stale: false }
  }
  if (known !== undefined && known.status.kind !== "unavailable") {
    return known.stale ? known : { ...known, stale: true }
  }
  return (
    known ?? {
      status: selected,
      checkedAt: new Date(checkedAt).toISOString(),
      stale: false,
    }
  )
}
