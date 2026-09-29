import { useBriefSettings } from "@/hooks/mutations"
import { useHarnesses, useHarnessFeatures, useTaskBrief } from "@/hooks/queries"
import { failureReason } from "@/lib/api"
import { briefMenuNote, briefWaiting } from "@/lib/brief"
import type { ApiTask } from "@/lib/types"

/**
 * The one task-brief switch, for every surface that draws it (the Brief tab
 * and the task menu). Whether briefs are on, and what switching them does, are
 * read from the same task row and the same brief query, so the two agree.
 *
 * Each caller owns its own write: `pending` and `error` belong to the control
 * that sent it, and do not show on the other.
 *
 * `available` is whether the daemon has briefs at all; `switchable` adds that
 * the task is live. An archived task can still be READ, never switched.
 */
export function useBriefSwitch(task: ApiTask | null) {
  const features = useHarnessFeatures()
  const available = features.data?.taskBriefs === true
  const switchable = available && task !== null && !task.archived
  const harnesses = useHarnesses(switchable)
  const settings = useBriefSettings()
  // The answer to this switch's own click stands in only until the task row
  // catches up; after that the row and the daemon's read model speak, so a
  // note cannot outlive the state it describes.
  const echo = task && settings.data && settings.variables?.id === task.id && settings.data.enabled !== (task.briefEnabled === true)
    ? settings.data
    : null
  const enabled = echo ? echo.enabled : task?.briefEnabled === true
  const query = useTaskBrief(task?.id ?? null, available && enabled)
  const supported = task ? harnesses.data?.find((h) => h.name === task.harness)?.hasBriefs === true : false
  const note = task
    ? briefMenuNote({
      enabled,
      // a harness that cannot publish is only worth mentioning to someone about to switch it on
      supported: supported || enabled,
      harness: task.harness,
      waiting: query.data ? briefWaiting(query.data) : echo?.activation === "next-turn" ? (echo.turnRunning ? "after-running" : "not-yet") : null,
    })
    : null
  return {
    available,
    switchable,
    enabled,
    query,
    note,
    pending: settings.isPending,
    // an off switch on a harness that cannot publish has nothing to turn on
    disabled: settings.isPending || (!enabled && !supported),
    error: settings.error ? failureReason(settings.error) : null,
    set: (checked: boolean) => {
      if (task) settings.mutate({ id: task.id, enabled: checked })
    },
  }
}
