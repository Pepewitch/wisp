import { useEffect, useRef, useState } from "react"
import { Dialog } from "@base-ui/react/dialog"

import { BasePicker } from "@/components/base-picker"
import { PromptField } from "@/components/create-prompt-field"
import { TaskControls } from "@/components/create-task-controls"
import { CreateTaskNotices } from "@/components/create-task-notices"
import { Flowchart } from "@/components/icons"
import { Menu, MenuRadioGroup, MenuRadioItem } from "@/components/menu"
import { POPOVER_SURFACE, SwitchTrack } from "@/components/primitives"
import { useHarnesses } from "@/hooks/queries"
import { useCreateTask, useReprobeHarnesses } from "@/hooks/mutations"
import { useCreateTaskComposer } from "@/hooks/useCreateTaskComposer"
import { failureReason } from "@/lib/api"
import { discardAttachmentPayloads } from "@/lib/attachments"
import { clearCreateTaskDraft } from "@/lib/drafts"
import { rememberEffort } from "@/lib/effort"
import { decode, isUsable, loadPreferredModel, orderHarnesses, sameChoice, savePreferredModel, type ModelChoice } from "@/lib/model-choice"
import { useDaemonRuntime } from "@/lib/runtime"
import { KIND_HINT, KIND_WORDS, subtaskBasePreview, subtaskDraftScope } from "@/lib/subtask-words"
import type { ApiTask, HarnessInfo, SubtaskKind } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"
import { cn } from "@/lib/utils"

/**
 * New subtask: the new-task composer, scoped to a parent. The parent fixes
 * the project; the kind decides the base (the parent's PR head for review,
 * its tip for continue, the project's base for explore), pinned when the
 * subtask starts, or a base chosen here. Reporting back is on unless turned
 * off. Only an explore subtask opens its own PR, so only it is offered
 * autopilot. Every refusal is the daemon's own sentence, shown inline:
 * caps, a review with no PR, merge rights.
 */
export function NewSubtaskDialog({ parent, open, onOpenChange }: {
  parent: ApiTask
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const harnesses = useHarnesses(open)
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-(--z-backdrop) bg-scrim" />
        <Dialog.Popup
          className={cn(
            "fixed top-[18vh] left-1/2 z-(--z-modal) @container w-[min(680px,calc(100vw-3rem))] -translate-x-1/2",
            POPOVER_SURFACE,
            "rounded-xl shadow-modal outline-none",
          )}
        >
          <Dialog.Title className="sr-only">New subtask of {parent.title}</Dialog.Title>
          {/* the form picks its opening agent once, so it waits for the list */}
          {open && (harnesses.data || harnesses.error) ? (
            <SubtaskForm
              key={parent.id}
              parent={parent}
              harnesses={orderHarnesses(harnesses.data ?? [])}
              harnessesError={harnesses.error ? failureReason(harnesses.error) : null}
              onClose={() => onOpenChange(false)}
            />
          ) : (
            open && <p className="px-4 py-3 text-[12px] text-muted-foreground">Loading agents…</p>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Report back to the parent: on unless the person turns it off. */
function ReportSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      title="Its finished turns, and its PR's events, reach this task as a report"
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-muted-foreground hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <SwitchTrack checked={on} />
      Report back
    </button>
  )
}

function SubtaskForm({ parent, harnesses, harnessesError, onClose }: {
  parent: ApiTask
  harnesses: HarnessInfo[]
  harnessesError: string | null
  onClose: () => void
}) {
  const { connectionId, transport } = useDaemonRuntime()
  const scope = subtaskDraftScope(parent.id)
  const [preferredChoice, setPreferredChoice] = useState<ModelChoice | null>(() => loadPreferredModel(connectionId))
  const composer = useCreateTaskComposer(connectionId, scope, harnesses, preferredChoice)
  const { prompt, setPrompt, choice, setChoice, effort, setEffort, fast, setFast, base, setBase, autopilot, suffixPromptId, setSuffixPromptId, harness, attachments, modelAvailable, suffixAvailable, canSubmit, reseedForHarness } = composer
  const [kind, setKind] = useState<SubtaskKind>("explore")
  const [report, setReport] = useState(true)
  const [suffixModalOpen, setSuffixModalOpen] = useState(false)
  const createTask = useCreateTask()
  const reprobe = useReprobeHarnesses()
  const [uploading, setUploading] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const error = validationError ?? (createTask.error ? failureReason(createTask.error) : null)
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => box.current?.focus(), [])
  const restoreComposer = () => requestAnimationFrame(() => box.current?.focus())
  const ready = canSubmit && !createTask.isPending && !uploading
  // Synchronous, from the first ⌘↵: two within one render would both see
  // `ready`, and each would make a child (the new-task composer's guard).
  const submitting = useRef(false)

  const submit = () => {
    if (submitting.current || !ready || !choice) return
    submitting.current = true
    setValidationError(null)
    setUploading(true)
    const chosen = choice
    const discardUpload = (uploadId: string) => transport.request(`/api/attachments/${encodeURIComponent(uploadId)}`, { method: "DELETE" })
    void attachments.payloads(transport.upload, discardUpload).then(
      (payloads) => createTask.mutate(
        {
          prompt: prompt.trim(),
          harness: chosen.harness,
          model: chosen.model,
          parentTaskId: parent.id,
          subtaskKind: kind,
          report,
          ...(base.trim() ? { base: base.trim() } : {}),
          ...(harness?.hasEffort && effort.trim() ? { effort: effort.trim() } : {}),
          ...(harness?.hasFastMode && fast ? { fast: true } : {}),
          ...(suffixPromptId ? { suffixPromptId } : {}),
          ...(payloads ? { attachments: payloads } : {}),
          // only an explore subtask opens a PR; the daemon refuses the switches on the others
          ...(kind === "explore" ? autopilot.body : {}),
        },
        {
          onSuccess: (task) => {
            if (harness?.hasEffort && effort.trim()) rememberEffort(connectionId, chosen.harness, effort.trim())
            attachments.clear()
            clearCreateTaskDraft(connectionId, scope)
            uiIntentsFor(connectionId).focusTask(task.id)
            onClose()
          },
          onError: () => {
            if (payloads) void discardAttachmentPayloads(payloads, discardUpload)
          },
          // released either way: a refused create must be retryable
          onSettled: () => {
            submitting.current = false
            setUploading(false)
          },
        },
      ),
      (failure) => {
        submitting.current = false
        setUploading(false)
        setValidationError(failure instanceof Error ? failure.message : String(failure))
      },
    )
  }
  const submitRef = useRef(submit)
  useEffect(() => {
    submitRef.current = submit
  })
  useEffect(() => {
    if (suffixModalOpen) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault()
        submitRef.current()
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [suffixModalOpen])

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit() }}>
      <div className="flex min-h-11 flex-wrap items-center gap-1 border-b border-border px-2.5 py-1">
        <span className="flex min-w-0 shrink items-center gap-1.5 text-[13px]">
          <Flowchart aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-medium text-foreground">New subtask</span>
          <span className="truncate text-[11.5px] text-faint">of {parent.title}</span>
        </span>
        <span className="flex-1" />
        <Menu aria-label="Kind" label={<span className="text-[12px]">{kind}</span>}>
          <MenuRadioGroup value={kind} onValueChange={(value) => setKind(value as SubtaskKind)}>
            {(Object.keys(KIND_WORDS) as SubtaskKind[]).map((name) => (
              <MenuRadioItem key={name} value={name} hint={KIND_HINT[name]}>{name}</MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </Menu>
        <BasePicker base={base} onChange={setBase} onRestoreComposer={restoreComposer} />
        <ReportSwitch on={report} onChange={setReport} />
        {kind === "explore" && autopilot.picker}
      </div>
      <p className="border-b border-border px-3 py-1.5 text-[11.5px] text-muted-foreground" data-base-preview>
        {KIND_WORDS[kind]} Starts from {base.trim() ? <span className="font-mono">{base.trim()}</span> : subtaskBasePreview(kind, parent)}.
      </p>

      <PromptField box={box} prompt={prompt} setPrompt={setPrompt} attachments={attachments} />

      <CreateTaskNotices
        error={error}
        choice={choice}
        modelAvailable={modelAvailable}
        suffixAvailable={suffixAvailable}
        harnessesError={harnessesError}
        hasHarnesses={harnesses.length > 0}
        anyUsable={harnesses.some(isUsable)}
      />

      <TaskControls
        attachments={attachments}
        harnesses={harnesses}
        harness={harness}
        choice={choice}
        preferredChoice={preferredChoice}
        effort={effort}
        fast={fast}
        suffixPromptId={suffixPromptId}
        ready={ready}
        pending={createTask.isPending || uploading}
        reprobePending={reprobe.isPending}
        onPickChoice={(value) => {
          const next = decode(value)
          setChoice(next)
          reseedForHarness(next.harness)
        }}
        onTogglePreferredChoice={(next) => {
          const preferred = sameChoice(preferredChoice, next) ? null : next
          savePreferredModel(connectionId, preferred)
          setPreferredChoice(preferred)
        }}
        onPreferredChange={setPreferredChoice}
        onReprobe={() => reprobe.mutate()}
        onEffortChange={setEffort}
        onFastChange={setFast}
        onRestoreComposer={restoreComposer}
        onSuffixPromptChange={setSuffixPromptId}
        onSuffixPromptModalChange={setSuffixModalOpen}
      />
    </form>
  )
}
