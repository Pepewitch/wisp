import { useEffect, useRef, useState } from "react"
import { Dialog } from "@base-ui/react/dialog"

import { Folder } from "@/components/icons"
import { ModePicker, TaskControls } from "@/components/create-task-controls"
import { Menu, MenuNote, MenuRadioGroup, MenuRadioItem } from "@/components/menu"
import { CreateTaskNotices } from "@/components/create-task-notices"
import { BasePicker } from "@/components/base-picker"
import { PromptField } from "@/components/create-prompt-field"
import { POPOVER_SURFACE } from "@/components/primitives"
import { useCreateTask, useReprobeHarnesses } from "@/hooks/mutations"
import { useCreateTaskComposer } from "@/hooks/useCreateTaskComposer"
import { failureReason } from "@/lib/api"
import { discardAttachmentPayloads } from "@/lib/attachments"
import { clearCreateTaskDraft, readCreateTaskProject, writeCreateTaskProject } from "@/lib/drafts"
import { rememberEffort } from "@/lib/effort"
import { useDaemonRuntime } from "@/lib/runtime"
import { decode, isUsable, loadPreferredModel, orderHarnesses, sameChoice, savePreferredModel, type ModelChoice } from "@/lib/model-choice"
import type { HarnessInfo, RepoInfo } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The composer. One prompt box with a quiet control bar under it — project,
 * agent and effort are decisions you make rarely, so they are dropdowns rather
 * than a stack of labelled fields above the thing you came to type.
 *
 * The API contract this encodes, all of it load-bearing:
 *
 *  - ONE dropdown picks harness AND model together, grouped by harness
 *    (V0.2-WEB.md flow 3). Options come from GET /api/harnesses — never a
 *    hardcoded model id, and never a text box: a model is always PICKED.
 *  - A harness this machine cannot name a model for is greyed out with the
 *    reason, and a re-probe action sits in the menu. Asking someone to type a
 *    model id is asking them to guess at the daemon's state.
 *  - Every create sends an EXPLICIT model (wisp policy) — guaranteed by the
 *    type: ModelChoice.model is a string, so an unnamed model cannot be built.
 *  - A model-row star remembers the opening choice for FUTURE dialogs only.
 *    It never silently changes the selection in the composer already open.
 *  - Effort is a PICK too, but only from levels that demonstrably exist here:
 *    the configured default plus anything used before (lib/effort.ts). No
 *    hardcoded ladder — the daemon's own tests assert codex taking `xhigh`, so
 *    a low/medium/high menu would hide the level the owner actually uses.
 *  - Attachments upload as raw bodies when the dialog submits; the create
 *    body carries only one-shot references. A harness with no image mechanism
 *    refuses a pasted IMAGE and takes every other kind (A1d).
 *  - Creation errors carry named reasons from the daemon and stay inline here.
 */
export function CreateTaskDialog({
  open,
  onOpenChange,
  initialRepoPath,
  repos,
  harnesses,
  harnessesError,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialRepoPath: string | null
  repos: RepoInfo[] | undefined
  harnesses: HarnessInfo[] | undefined
  harnessesError: string | null
  onCreated: (id: string) => void
}) {
  const orderedHarnesses = orderHarnesses(harnesses ?? [])
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
          <Dialog.Title className="sr-only">New task</Dialog.Title>
          {/* Each project restores only its own unsent composer. */}
          {open && (
            <Form
              key={initialRepoPath ?? "any"}
              initialRepoPath={initialRepoPath}
              repos={repos ?? []}
              harnesses={orderedHarnesses}
              harnessesError={harnessesError}
              onCreated={onCreated}
              onClose={() => onOpenChange(false)}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Form({
  initialRepoPath,
  repos,
  harnesses,
  harnessesError,
  onCreated,
  onClose,
}: {
  initialRepoPath: string | null
  repos: RepoInfo[]
  harnesses: HarnessInfo[]
  harnessesError: string | null
  onCreated: (id: string) => void
  onClose: () => void
}) {
  const { connectionId } = useDaemonRuntime()
  const [repoPath, setRepoPath] = useState(() => {
    const last = readCreateTaskProject(connectionId)
    return initialRepoPath ?? (repos.some((repo) => repo.path === last) ? last! : repos[0]?.path ?? "")
  })
  useEffect(() => {
    if (repoPath) writeCreateTaskProject(connectionId, repoPath)
  }, [connectionId, repoPath])
  return (
    <ProjectForm
      key={repoPath}
      repoPath={repoPath}
      onRepoPathChange={setRepoPath}
      repos={repos}
      harnesses={harnesses}
      harnessesError={harnessesError}
      onCreated={onCreated}
      onClose={onClose}
    />
  )
}

function ProjectForm({
  repoPath,
  onRepoPathChange,
  repos,
  harnesses,
  harnessesError,
  onCreated,
  onClose,
}: {
  repoPath: string
  onRepoPathChange: (path: string) => void
  repos: RepoInfo[]
  harnesses: HarnessInfo[]
  harnessesError: string | null
  onCreated: (id: string) => void
  onClose: () => void
}) {
  const { connectionId, transport } = useDaemonRuntime()
  const [preferredChoice, setPreferredChoice] = useState<ModelChoice | null>(() => loadPreferredModel(connectionId))
  const {
    prompt, setPrompt, choice, setChoice, effort, setEffort, fast, setFast,
    mode, setMode, base, setBase, autopilot, suffixPromptId, setSuffixPromptId,
    harness, attachments, modelAvailable, suffixAvailable, canSubmit, reseedForHarness,
  } = useCreateTaskComposer(connectionId, repoPath, harnesses, preferredChoice)
  const [suffixPromptModalOpen, setSuffixPromptModalOpen] = useState(false)

  const createTask = useCreateTask()
  const reprobe = useReprobeHarnesses()
  // the three refusals below are the form's own, not the daemon's, so they are
  // the one piece of write state the mutation cannot hold
  const [validationError, setValidationError] = useState<string | null>(null)
  const error = validationError ?? (createTask.error ? failureReason(createTask.error) : null)

  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => box.current?.focus(), [])
  // One "put the cursor back in the prompt", shared by every inline picker
  // that closes; the frame defers past base-ui's own focus restore.
  const restoreComposer = () => requestAnimationFrame(() => box.current?.focus())

  // Keep `submit` reachable from the key listener below without re-binding it
  // on every keystroke.
  const submitRef = useRef<() => void>(() => {})
  /**
   * A create is in flight, from the FIRST click rather than from the mutation.
   *
   * Uploading starts before `createTask.isPending` goes true, so between the
   * click and the mutation the button would otherwise stay live and a second
   * ⌘↵ could make a second task. The ref is what actually closes the window:
   * state updates are batched, and two clicks can land inside one batch.
   */
  const submitting = useRef(false)
  const [uploading, setUploading] = useState(false)

  const anyUsable = harnesses.some(isUsable)

  const project = repos.find((r) => r.path === repoPath)
  const ready = canSubmit && !createTask.isPending && !uploading

  const pickChoice = (value: string) => {
    const next = decode(value)
    setChoice(next)
    reseedForHarness(next.harness)
  }

  const togglePreferredChoice = (next: ModelChoice) => {
    const preferred = sameChoice(preferredChoice, next) ? null : next
    savePreferredModel(connectionId, preferred)
    setPreferredChoice(preferred)
  }

  const submit = () => {
    if (submitting.current) return
    if (!choice) return setValidationError("No harness on this machine can run a task")
    if (!repoPath) return setValidationError("Pick a project")
    if (!prompt.trim()) return setValidationError("A prompt is required")
    if (!modelAvailable) return setValidationError("Pick an available model")
    if (!suffixAvailable) return setValidationError("Pick an available suffix prompt")
    setValidationError(null)
    const chosen = choice
    submitting.current = true
    setUploading(true)
    // Uploaded only at submit (A1d): the dialog holds the File, never a second
    // base64 copy of a 50 MB video.
    const discardUpload = (uploadId: string) =>
      transport.request(`/api/attachments/${encodeURIComponent(uploadId)}`, { method: "DELETE" })
    void attachments.payloads(transport.upload, discardUpload).then(
      (payloads) =>
        createTask.mutate(
          {
            repoPath,
            prompt: prompt.trim(),
            harness: chosen.harness,
            model: chosen.model,
            mode,
            ...(mode === "worktree" && base.trim() ? { base: base.trim() } : {}),
            ...(harness?.hasEffort && effort.trim() ? { effort: effort.trim() } : {}),
            ...(harness?.hasFastMode && fast ? { fast: true } : {}),
            ...(suffixPromptId ? { suffixPromptId } : {}),
            ...(payloads ? { attachments: payloads } : {}),
            ...autopilot.body,
          },
          {
            onSuccess: (task) => {
              // a level that actually ran is a level worth offering next time
              if (harness?.hasEffort && effort.trim()) {
                rememberEffort(connectionId, chosen.harness, effort.trim())
              }
              attachments.clear()
              clearCreateTaskDraft(connectionId, repoPath)
              onCreated(task.id)
              onClose()
            },
            onError: () => {
              if (payloads) void discardAttachmentPayloads(payloads, discardUpload)
            },
            // a refused create must be retryable, so the guard is released on
            // both outcomes rather than only on the happy one
            onSettled: () => {
              submitting.current = false
              setUploading(false)
            },
          },
        ),
      (error) => {
        submitting.current = false
        setUploading(false)
        setValidationError(error instanceof Error ? error.message : String(error))
      },
    )
  }

  // Refreshed after every render (no dep array): writing a ref DURING render
  // is a purity violation, and the whole point of this ref is that the key
  // listener below reads the latest closure without re-binding per keystroke.
  useEffect(() => {
    submitRef.current = () => {
      if (ready) submit()
    }
  })

  /**
   * ⌘↵ belongs to the DIALOG, not to whichever element has focus.
   *
   * Focus legitimately sits outside the <form> at times — base-ui parks it on
   * the popup, which is the form's PARENT, so a handler on the form never sees
   * the event and the shortcut silently dies. This listener lives exactly as
   * long as the open composer, and the dialog is modal, so it competes with
   * nothing. (The steer box's palette bug was the mirror image of this: a
   * document handler that outlived its owner.)
   */
  useEffect(() => {
    if (suffixPromptModalOpen) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault()
        submitRef.current()
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [suffixPromptModalOpen])

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {/*
        Project on the left, where the task runs on the right: the two
        decisions that scope everything below them, on the row above the
        prompt. The path rides inside the project trigger as its parenthetical
        so it costs no width of its own and truncates before any control does.
      */}
      <div className="flex h-11 items-center gap-1 border-b border-border px-2.5">
        <Menu
          className="min-w-0 shrink"
          icon={<Folder />}
          aria-label="Project"
          label={
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="shrink-0 text-[13px] font-medium text-foreground">
                {project?.name ?? "Pick a project"}
              </span>
              {project && <span className="truncate font-mono text-[10.5px] text-faint">({project.path})</span>}
            </span>
          }
          disabled={repos.length === 0}
        >
          {repos.length === 0 ? (
            <MenuNote>No projects configured. Add one from the sidebar first.</MenuNote>
          ) : (
            <MenuRadioGroup value={repoPath} onValueChange={onRepoPathChange}>
              {repos.map((r) => (
                <MenuRadioItem key={r.path} value={r.path} hint={r.exists ? undefined : "missing"}>
                  {r.name ?? r.path}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          )}
        </Menu>
        <span className="flex-1" />
        <ModePicker mode={mode} onChange={setMode} />
        {mode === "worktree" && <BasePicker base={base} onChange={setBase} onRestoreComposer={restoreComposer} />}
        {autopilot.picker}
      </div>

      {/* the prompt — the reason the modal exists, so it gets the room */}
      <PromptField box={box} prompt={prompt} setPrompt={setPrompt} attachments={attachments} />

      <CreateTaskNotices
        error={error}
        choice={choice}
        modelAvailable={modelAvailable}
        suffixAvailable={suffixAvailable}
        harnessesError={harnessesError}
        hasHarnesses={harnesses.length > 0}
        anyUsable={anyUsable}
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
        onPickChoice={pickChoice}
        onTogglePreferredChoice={togglePreferredChoice}
        onPreferredChange={setPreferredChoice}
        onReprobe={() => reprobe.mutate()}
        onEffortChange={setEffort}
        onFastChange={setFast}
        onRestoreComposer={restoreComposer}
        onSuffixPromptChange={setSuffixPromptId}
        onSuffixPromptModalChange={setSuffixPromptModalOpen}
      />
    </form>
  )
}
