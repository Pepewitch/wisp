import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query"

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
 * Every PATCH carries the whole map, so an edit must build on the newest map
 * the user asked for, not on whatever the cache or the last render holds.
 * While a write is pending, the cache can be behind the user: an earlier
 * PATCH's answer, or a refetch woken by its `settings` event, lands while a
 * later one is still queued. So the newest pending map is both what this hook
 * reports and what the next edit starts from, and the writes run one at a time
 * in click order, so the daemon ends on the last one.
 *
 * `supported` is false on a daemon that cannot store them (no
 * `/api/settings`, or no `modelTaskDefaults` in its answer): the Models modal
 * then offers no menu, and the composer falls back to the built-in defaults.
 */
export function useModelTaskDefaults(): {
  defaults: ModelTaskDefaultsMap
  supported: boolean
  updateDefaults: (edit: (current: ModelTaskDefaultsMap) => ModelTaskDefaultsMap) => void
  error: unknown
} {
  const client = useQueryClient()
  const { transport, qk } = useDaemonRuntime()
  const settings = useWispSettings()
  const mutationKey = [...qk.settings, "modelTaskDefaults"]
  const update = useMutation({
    mutationKey,
    scope: { id: mutationKey.join("\u0000") },
    mutationFn: (modelTaskDefaults: ModelTaskDefaultsMap) =>
      transport.request<WispSettings>("/api/settings", { method: "PATCH", body: { modelTaskDefaults } }),
    onSuccess: (next) => client.setQueryData(qk.settings, next),
    onError: () => void client.invalidateQueries({ queryKey: qk.settings }),
  })
  const pending = useMutationState({
    filters: { mutationKey, status: "pending" },
    select: (mutation) => mutation.state.variables as ModelTaskDefaultsMap,
  })
  const latest = (): ModelTaskDefaultsMap =>
    (client.getMutationCache().findAll({ mutationKey, status: "pending" }).at(-1)?.state.variables as
      | ModelTaskDefaultsMap
      | undefined) ??
    client.getQueryData<WispSettings>(qk.settings)?.modelTaskDefaults ??
    {}
  const missing = settings.error instanceof ApiError && settings.error.status === 404
  return {
    defaults: pending.at(-1) ?? settings.data?.modelTaskDefaults ?? {},
    supported: !missing && settings.data?.modelTaskDefaults !== undefined,
    updateDefaults: (edit) => update.mutate(edit(latest())),
    error: settings.error ?? update.error,
  }
}
