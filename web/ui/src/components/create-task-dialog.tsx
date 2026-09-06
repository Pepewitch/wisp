import { useEffect, useRef, useState } from "react"
import { Dialog } from "@base-ui/react/dialog"

import { Branch, Effort, Enter, Folder, Local, Sparkle, Star, StarFilled } from "@/components/icons"
import { Menu, MenuAction, MenuGroup, MenuItem, MenuNote, MenuRadioGroup, MenuRadioItem } from "@/components/menu"
import { MENU_ACTION } from "@/lib/menu-actions"
import { AttachButton, PendingAttachmentRows } from "@/components/pending-attachments"
import { Button, POPOVER_SURFACE } from "@/components/primitives"
import { SuffixPromptPicker } from "@/components/suffix-prompt-picker"
import { useCreateTask, useReprobeHarnesses } from "@/hooks/mutations"
import { failureReason } from "@/lib/api"
import { usePendingAttachments } from "@/lib/attachments"
import { effortOptions, rememberEffort } from "@/lib/effort"
import { handleComposerPaste } from "@/lib/paste-links"
import { useDaemonRuntime } from "@/lib/runtime"
import {
  defaultModelFor,
  initialChoice,
  isUsable,
  loadPreferredModel,
  modelOptionsFor,
  orderHarnesses,
  savePreferredModel,
  unusableReason,
  type ModelChoice,
} from "@/lib/model-choice"
import type { HarnessInfo, RepoInfo, TaskMode } from "@/lib/types"
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
 *  - Attachments ride inline in the create body. A harness with no headless
 *    image path (droid) pastes disabled with its named reason.
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
        <Dialog.Backdrop className="fixed inset-0 z-(--z-backdrop) bg-black/60" />
        <Dialog.Popup
          className={cn(
            "fixed top-[18vh] left-1/2 z-(--z-modal) @container w-[min(680px,calc(100vw-3rem))] -translate-x-1/2",
            POPOVER_SURFACE,
            "rounded-xl shadow-modal outline-none",
          )}
        >
          <Dialog.Title className="sr-only">New task</Dialog.Title>
          {/* keyed so every open starts from a clean form, not the last one */}
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

/** A radio value has to be one string; a tab cannot occur in a harness name. */
const encode = (c: ModelChoice): string => `${c.harness}\t${c.model}`
const decode = (v: string): ModelChoice => {
  const i = v.indexOf("\t")
  return { harness: v.slice(0, i), model: v.slice(i + 1) }
}
const sameChoice = (a: ModelChoice | null, b: ModelChoice): boolean =>
  a?.harness === b.harness && a.model === b.model

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
  const [repoPath, setRepoPath] = useState(initialRepoPath ?? repos[0]?.path ?? "")
  const [prompt, setPrompt] = useState("")
  const [preferredChoice, setPreferredChoice] = useState<ModelChoice | null>(() =>
    loadPreferredModel(connectionId),
  )
  const [choice, setChoice] = useState<ModelChoice | null>(() => initialChoice(harnesses, preferredChoice))
  const [effort, setEffort] = useState(() => {
    return harnesses.find((h) => h.name === choice?.harness)?.defaults.reasoningEffort ?? ""
  })
  const [mode, setMode] = useState<TaskMode>("worktree")
  const [suffixPromptId, setSuffixPromptId] = useState<string | null>(null)
  const [suffixPromptModalOpen, setSuffixPromptModalOpen] = useState(false)

  const createTask = useCreateTask()
  const reprobe = useReprobeHarnesses()
  // the three refusals below are the form's own, not the daemon's, so they are
  // the one piece of write state the mutation cannot hold
  const [validationError, setValidationError] = useState<string | null>(null)
  const error = validationError ?? (createTask.error ? failureReason(createTask.error) : null)

  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => box.current?.focus(), [])

  // Keep `submit` reachable from the key listener below without re-binding it
  // on every keystroke.
  const submitRef = useRef<() => void>(() => {})

  const harness = harnesses.find((h) => h.name === choice?.harness) ?? null
  const anyUsable = harnesses.some(isUsable)
  const attachments = usePendingAttachments({ harness: harness?.name ?? null, hasImage: harness?.hasImage, imageNote: harness?.imageNote })

  const project = repos.find((r) => r.path === repoPath)
  const model = choice?.model ?? ""
  const ready = repoPath !== "" && prompt.trim() !== "" && model !== "" && !createTask.isPending

  const pickChoice = (value: string) => {
    const next = decode(value)
    setChoice(next)
    // a harness switch reseeds effort from ITS OWN config default
    setEffort(harnesses.find((c) => c.name === next.harness)?.defaults.reasoningEffort ?? "")
  }

  const togglePreferredChoice = (next: ModelChoice) => {
    const preferred = sameChoice(preferredChoice, next) ? null : next
    savePreferredModel(connectionId, preferred)
    setPreferredChoice(preferred)
  }

  const submit = () => {
    if (!choice) return setValidationError("No harness on this machine can run a task")
    if (!repoPath) return setValidationError("Pick a project")
    if (!prompt.trim()) return setValidationError("A prompt is required")
    setValidationError(null)
    const payloads = attachments.payloads()
    createTask.mutate(
      {
        repoPath,
        prompt: prompt.trim(),
        harness: choice.harness,
        model: choice.model,
        mode,
        ...(harness?.hasEffort && effort.trim() ? { effort: effort.trim() } : {}),
        ...(suffixPromptId ? { suffixPromptId } : {}),
        ...(payloads ? { attachments: payloads } : {}),
      },
      {
        onSuccess: (task) => {
          // a level that actually ran is a level worth offering next time
          if (harness?.hasEffort && effort.trim()) {
            rememberEffort(connectionId, choice.harness, effort.trim())
          }
          attachments.clear()
          onCreated(task.id)
          onClose()
        },
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
      {/* project — the one decision that scopes everything below it */}
      <div className="flex h-11 items-center gap-1 border-b border-border px-2.5">
        <Menu
          icon={<Folder />}
          label={<span className="text-[13px] font-medium text-foreground">{project?.name ?? "Pick a project"}</span>}
          disabled={repos.length === 0}
        >
          {repos.length === 0 ? (
            <MenuNote>No projects configured. Add one from the sidebar first.</MenuNote>
          ) : (
            <MenuRadioGroup value={repoPath} onValueChange={setRepoPath}>
              {repos.map((r) => (
                <MenuRadioItem key={r.path} value={r.path} hint={r.exists ? undefined : "missing"}>
                  {r.name ?? r.path}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          )}
        </Menu>
        <span className="flex-1" />
        {project && <span className="truncate font-mono text-[10.5px] text-faint">{project.path}</span>}
      </div>

      {/* the prompt — the reason the modal exists, so it gets the room */}
      <div className="px-4 pt-3.5">
        <textarea
          ref={box}
          rows={6}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onPaste={(e) =>
            handleComposerPaste(e, {
              onImagePaste: attachments.onPaste,
              value: prompt,
              onChange: (next) => setPrompt(next),
            })
          }
          placeholder="What do you want to work on?"
          className={cn(
            "scroll-slim min-h-[132px] w-full resize-none bg-transparent",
            "text-[13.5px] leading-[1.6] text-foreground placeholder:text-faint focus:outline-none",
          )}
        />
        <PendingAttachmentRows pending={attachments} />
      </div>

      {error && <div className="px-4 pb-1 text-[11.5px] text-destructive">{error}</div>}
      {harnessesError && !error && (
        <div className="px-4 pb-1 text-[11.5px] text-faint">Harness list unavailable ({harnessesError})</div>
      )}
      {!harnessesError && !error && harnesses.length > 0 && !anyUsable && (
        <div className="px-4 pb-1 text-[11.5px] text-faint">
          No harness on this machine reported a model, so there is nothing to run a task with. Check the CLIs are on
          PATH, then re-probe from the harness menu.
        </div>
      )}

      <TaskControls
        attachments={attachments}
        harnesses={harnesses}
        harness={harness}
        choice={choice}
        preferredChoice={preferredChoice}
        effort={effort}
        suffixPromptId={suffixPromptId}
        mode={mode}
        ready={ready}
        pending={createTask.isPending}
        reprobePending={reprobe.isPending}
        onPickChoice={pickChoice}
        onTogglePreferredChoice={togglePreferredChoice}
        onReprobe={() => reprobe.mutate()}
        onEffortChange={setEffort}
        onRestoreComposer={() => requestAnimationFrame(() => box.current?.focus())}
        onSuffixPromptChange={setSuffixPromptId}
        onSuffixPromptModalChange={setSuffixPromptModalOpen}
        onModeChange={setMode}
      />
    </form>
  )
}

function TaskControls({
  attachments,
  harnesses,
  harness,
  choice,
  preferredChoice,
  effort,
  suffixPromptId,
  mode,
  ready,
  pending,
  reprobePending,
  onPickChoice,
  onTogglePreferredChoice,
  onReprobe,
  onEffortChange,
  onRestoreComposer,
  onSuffixPromptChange,
  onSuffixPromptModalChange,
  onModeChange,
}: {
  attachments: ReturnType<typeof usePendingAttachments>
  harnesses: HarnessInfo[]
  harness: HarnessInfo | null
  choice: ModelChoice | null
  preferredChoice: ModelChoice | null
  effort: string
  suffixPromptId: string | null
  mode: TaskMode
  ready: boolean
  pending: boolean
  reprobePending: boolean
  onPickChoice: (value: string) => void
  onTogglePreferredChoice: (choice: ModelChoice) => void
  onReprobe: () => void
  onEffortChange: (value: string) => void
  onRestoreComposer: () => void
  onSuffixPromptChange: (value: string | null) => void
  onSuffixPromptModalChange: (open: boolean) => void
  onModeChange: (mode: TaskMode) => void
}) {
  const [customEffort, setCustomEffort] = useState(false)
  return (
    <div className="flex gap-x-2 px-2.5 py-2.5 @min-[640px]:flex-wrap @min-[640px]:items-center @min-[640px]:gap-x-1 @min-[640px]:gap-y-1.5">
      <div className="flex min-w-0 grow flex-col items-start gap-1.5 @min-[640px]:basis-64 @min-[640px]:flex-row @min-[640px]:flex-wrap @min-[640px]:items-center @min-[640px]:gap-1">
        <AttachButton pending={attachments} />
        <HarnessPicker
          harnesses={harnesses}
          harness={harness}
          choice={choice}
          preferredChoice={preferredChoice}
          reprobePending={reprobePending}
          onPick={onPickChoice}
          onTogglePreferred={onTogglePreferredChoice}
          onReprobe={onReprobe}
        />
        {harness?.hasEffort && (
          <EffortPicker
            harness={harness}
            effort={effort}
            custom={customEffort}
            onEffortChange={onEffortChange}
            onCustomChange={setCustomEffort}
            onRestoreComposer={onRestoreComposer}
          />
        )}
        <SuffixPromptPicker
          value={suffixPromptId}
          onValueChange={onSuffixPromptChange}
          onModalOpenChange={onSuffixPromptModalChange}
          disabled={pending}
        />
      </div>
      <div className="ml-auto flex flex-col items-end justify-end gap-1.5 @min-[640px]:flex-row @min-[640px]:items-center @min-[640px]:gap-1">
        <ModePicker mode={mode} onChange={onModeChange} />
        <CreateButton ready={ready} pending={pending} />
      </div>
    </div>
  )
}

function HarnessPicker({
  harnesses,
  harness,
  choice,
  preferredChoice,
  reprobePending,
  onPick,
  onTogglePreferred,
  onReprobe,
}: {
  harnesses: HarnessInfo[]
  harness: HarnessInfo | null
  choice: ModelChoice | null
  preferredChoice: ModelChoice | null
  reprobePending: boolean
  onPick: (value: string) => void
  onTogglePreferred: (choice: ModelChoice) => void
  onReprobe: () => void
}) {
  return (
    <Menu
      icon={<Sparkle />}
      className="min-w-0 max-w-full shrink"
      label={
        harness && choice ? (
          <>
            {harness.name}
            <span className="font-mono text-muted-foreground"> · {choice.model}</span>
          </>
        ) : (
          <span className="text-muted-foreground">No usable harness</span>
        )
      }
      disabled={harnesses.length === 0}
    >
      {harnesses.length === 0 ? (
        <MenuNote>No harnesses reported by the daemon.</MenuNote>
      ) : (
        <MenuRadioGroup
          value={choice ? encode(choice) : ""}
          onValueChange={(value) => (value === MENU_ACTION.reprobe ? onReprobe() : onPick(value))}
        >
          {harnesses.map((candidate) => (
            <HarnessGroup
              key={candidate.name}
              harness={candidate}
              preferredChoice={preferredChoice}
              onTogglePreferred={onTogglePreferred}
            />
          ))}
          <MenuAction value={MENU_ACTION.reprobe}>
            {reprobePending ? "Re-probing…" : "Re-probe models"}
          </MenuAction>
        </MenuRadioGroup>
      )}
    </Menu>
  )
}

function HarnessGroup({
  harness,
  preferredChoice,
  onTogglePreferred,
}: {
  harness: HarnessInfo
  preferredChoice: ModelChoice | null
  onTogglePreferred: (choice: ModelChoice) => void
}) {
  return (
    <MenuGroup label={harness.name} hint={isUsable(harness) ? undefined : unusableReason(harness)}>
      {isUsable(harness) ? (
        modelOptionsFor(harness).map((model) => {
          const choice = { harness: harness.name, model }
          const preferred = sameChoice(preferredChoice, choice)
          const label = preferred
            ? `Clear preferred model ${harness.name} · ${model}`
            : `Prefer ${harness.name} · ${model} for new tasks`
          return (
            <div key={model} className="relative">
              <MenuRadioItem
                value={encode(choice)}
                hint={model === defaultModelFor(harness) ? "default" : undefined}
                className="pr-9"
              >
                {model}
              </MenuRadioItem>
              <button
                type="button"
                aria-label={label}
                aria-pressed={preferred}
                title={label}
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") event.stopPropagation()
                }}
                onClick={(event) => {
                  event.stopPropagation()
                  onTogglePreferred(choice)
                }}
                className={cn(
                  "absolute top-1/2 right-1 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-md",
                  "text-faint hover:bg-hover hover:text-foreground",
                  "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                  "[&>svg]:size-3.5",
                  preferred && "text-foreground",
                )}
              >
                {preferred ? <StarFilled /> : <Star />}
              </button>
            </div>
          )
        })
      ) : (
        <MenuItem disabled>Unavailable here</MenuItem>
      )}
    </MenuGroup>
  )
}

function EffortPicker({
  harness,
  effort,
  custom,
  onEffortChange,
  onCustomChange,
  onRestoreComposer,
}: {
  harness: HarnessInfo
  effort: string
  custom: boolean
  onEffortChange: (value: string) => void
  onCustomChange: (custom: boolean) => void
  onRestoreComposer: () => void
}) {
  const { connectionId } = useDaemonRuntime()
  if (custom) {
    return (
      <input
        autoFocus
        value={effort}
        onChange={(event) => onEffortChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== "Escape") return
          event.preventDefault()
          onCustomChange(false)
          onRestoreComposer()
        }}
        placeholder="Level"
        aria-label="Reasoning effort"
        className={cn(
          "h-[26px] w-28 rounded-md border border-accent-dim bg-surface px-2 text-[12px]",
          "text-foreground placeholder:text-faint focus:ring-2 focus-visible:ring-ring/15 focus:outline-none",
        )}
      />
    )
  }

  const options = effortOptions(connectionId, harness)
  return (
    <Menu icon={<Effort />} label={effort || <span className="text-muted-foreground">Effort</span>}>
      <MenuRadioGroup
        value={effort}
        onValueChange={(value) =>
          value === MENU_ACTION.custom ? onCustomChange(true) : onEffortChange(value)
        }
      >
        {options.length > 0 ? (
          options.map((level) => (
            <MenuRadioItem
              key={level}
              value={level}
              hint={level === harness.defaults.reasoningEffort ? "default" : undefined}
            >
              {level}
            </MenuRadioItem>
          ))
        ) : (
          <MenuNote>
            The {harness.name} adapter names no effort levels, and Wisp does not guess them — they are
            harness-specific. Set one below and it becomes a pick from then on.
          </MenuNote>
        )}
        {effort !== "" && <MenuRadioItem value="">Harness default</MenuRadioItem>}
        <MenuAction value={MENU_ACTION.custom}>Custom level…</MenuAction>
      </MenuRadioGroup>
    </Menu>
  )
}

function ModePicker({ mode, onChange }: { mode: TaskMode; onChange: (mode: TaskMode) => void }) {
  return (
    <Menu icon={mode === "local" ? <Local /> : <Branch />} label={mode === "local" ? "This repo" : "Worktree"}>
      <MenuRadioGroup value={mode} onValueChange={(value) => onChange(value as TaskMode)}>
        <MenuRadioItem value="worktree" hint="default">
          Worktree
        </MenuRadioItem>
        <MenuRadioItem value="local">This repo</MenuRadioItem>
      </MenuRadioGroup>
      <MenuNote>
        {mode === "local"
          ? "Runs in the project directory on its current branch. Setup and archive scripts are skipped, and archiving never removes anything — it is your working copy."
          : "An isolated worktree on its own branch, removed when you archive the task. One project can run any number of these at once."}
      </MenuNote>
    </Menu>
  )
}

function CreateButton({ ready, pending }: { ready: boolean; pending: boolean }) {
  return (
    <Button
      type="submit"
      tone={ready ? "primary" : "quiet"}
      disabled={!ready}
      className={cn(!ready && "bg-border-strong opacity-100")}
    >
      {pending ? "Creating…" : "Create"}
      <Enter data-icon="inline-end" className={ready ? "opacity-70" : "opacity-40"} />
    </Button>
  )
}
