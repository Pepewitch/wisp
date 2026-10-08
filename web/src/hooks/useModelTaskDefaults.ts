import { useQueryClient } from "@tanstack/react-query"

import { useUpdateWispSettings } from "@/hooks/mutations"
import { useWispSettings } from "@/hooks/queries"
import { ApiError } from "@/lib/api"
import { useDaemonRuntime } from "@/lib/runtime"
import type { WispSettings } from "@/lib/types"
import {
  BUILTIN_MODEL_TASK_DEFAULTS,
  modelTaskDefaultsFor,
  type ModelTaskDefaults,
  type ModelTaskDefaultsMap,
} from "../../../shared/model-task-defaults"

/** Where a new task on this harness and model starts its switches; built-in defaults until one is picked. */
export function useChoiceTaskDefaults(choice: { harness: string; model: string } | null): ModelTaskDefaults {
  const { defaults } = useModelTaskDefaults()
  return choice ? modelTaskDefaultsFor(defaults, choice.harness, choice.model) : BUILTIN_MODEL_TASK_DEFAULTS
}

/**
 * Where each model starts a new task's brief, auto-fix and auto-merge
 * switches, and the one way to change it.
 *
 * `supported` is false on a daemon that cannot store them (no
 * `/api/settings`, or no `modelTaskDefaults` in its answer): the Models modal
 * then offers no switches, and the composer falls back to the built-in
 * defaults.
 */
export function useModelTaskDefaults(): {
  defaults: ModelTaskDefaultsMap
  supported: boolean
  setDefaults: (next: ModelTaskDefaultsMap) => void
  error: unknown
} {
  const client = useQueryClient()
  const { qk } = useDaemonRuntime()
  const settings = useWispSettings()
  const update = useUpdateWispSettings()
  const missing = settings.error instanceof ApiError && settings.error.status === 404
  return {
    defaults: settings.data?.modelTaskDefaults ?? {},
    supported: !missing && settings.data?.modelTaskDefaults !== undefined,
    setDefaults: (modelTaskDefaults) => {
      // Each PATCH carries the whole map, so the next click must build on this
      // one rather than on a cache the daemon has not answered yet.
      client.setQueryData<WispSettings>(qk.settings, (old) => (old ? { ...old, modelTaskDefaults } : old))
      update.mutate(
        { modelTaskDefaults },
        { onError: () => void client.invalidateQueries({ queryKey: qk.settings }) },
      )
    },
    error: settings.error ?? update.error,
  }
}
