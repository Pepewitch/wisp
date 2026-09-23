import type { ApiTask } from "@/lib/types"

/**
 * The task the header shows. The detail row wins once loaded — it carries the
 * turns — but state the detail endpoint does not serve comes from the task
 * list row, which the realtime `workflow` event and the mutations keep
 * current. Auto-merge is that state: read from the detail alone, its switch
 * would always look off.
 */
export function headerTask<T extends ApiTask>(detail: T | undefined, row: ApiTask | null): T | ApiTask | null {
  if (!detail) return row
  return row && row.id === detail.id ? { ...detail, autopilot: row.autopilot } : detail
}
