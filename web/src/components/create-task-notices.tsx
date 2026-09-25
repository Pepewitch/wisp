import type { ModelChoice } from "@/lib/model-choice"

/** Composer refusals stay near the prompt, with missing saved choices named plainly. */
export function CreateTaskNotices({
  error,
  choice,
  modelAvailable,
  suffixAvailable,
  harnessesError,
  hasHarnesses,
  anyUsable,
}: {
  error: string | null
  choice: ModelChoice | null
  modelAvailable: boolean
  suffixAvailable: boolean
  harnessesError: string | null
  hasHarnesses: boolean
  anyUsable: boolean
}) {
  return (
    <>
      {error && <div className="px-4 pb-1 text-[11.5px] text-destructive">{error}</div>}
      {!error && !modelAvailable && choice && hasHarnesses && (
        <div className="px-4 pb-1 text-[11.5px] text-faint">The selected model is no longer available. Pick another model.</div>
      )}
      {!error && !suffixAvailable && (
        <div className="px-4 pb-1 text-[11.5px] text-faint">The selected suffix prompt is no longer available. Pick another one.</div>
      )}
      {harnessesError && !error && (
        <div className="px-4 pb-1 text-[11.5px] text-faint">Harness list unavailable ({harnessesError})</div>
      )}
      {!harnessesError && !error && hasHarnesses && !anyUsable && (
        <div className="px-4 pb-1 text-[11.5px] text-faint">
          No harness on this machine reported a model, so there is nothing to run a task with. Check the CLIs are on
          PATH, then re-probe from the harness menu.
        </div>
      )}
    </>
  )
}
