import { useUpdateWispSettings } from "@/hooks/mutations"
import { useWispSettings } from "@/hooks/queries"
import { ApiError } from "@/lib/api"
import type { HiddenModels } from "@/lib/model-visibility"

/**
 * The daemon's model curation, and the one way to change it.
 *
 * `supported` is the capability gate, and it fails CLOSED in the only
 * direction that matters: a daemon with no `/api/settings` (404) or no
 * `hiddenModels` in its answer reads as "nothing is hidden", never as "hide
 * everything". So an older daemon shows the full picker it always showed,
 * with no eye on its rows and no door to a manager it cannot persist — the
 * same posture the Task names section already takes.
 */
export function useHiddenModels(): {
  hidden: HiddenModels
  supported: boolean
  setHidden: (next: HiddenModels) => void
  pending: boolean
  error: unknown
} {
  const settings = useWispSettings()
  const update = useUpdateWispSettings()
  const missing = settings.error instanceof ApiError && settings.error.status === 404
  return {
    hidden: settings.data?.hiddenModels ?? {},
    supported: !missing && settings.data?.hiddenModels !== undefined,
    setHidden: (hiddenModels) => update.mutate({ hiddenModels }),
    pending: update.isPending,
    error: settings.error ?? update.error,
  }
}
