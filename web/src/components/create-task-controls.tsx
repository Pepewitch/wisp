import { useState } from "react"

import { Effort, Enter, Local, Sparkle, Worktree } from "@/components/icons"
import { Button } from "@/components/primitives"
import { Menu, MenuAction, MenuNote, MenuRadioGroup, MenuRadioItem } from "@/components/menu"
import { ModelMenuFooter, ModelMenuGroups } from "@/components/model-menu"
import { PreferButton, StarButton } from "@/components/preferred-model-button"
import { ModelVisibilityDialog } from "@/components/model-visibility-dialog"
import { useHiddenModels } from "@/hooks/useHiddenModels"
import { hiddenTotal } from "@/lib/model-visibility"
import { MENU_ACTION } from "@/lib/menu-actions"
import { FastModeToggle } from "@/components/fast-mode-toggle"
import { AttachButton } from "@/components/pending-attachments"
import { SuffixPromptPicker } from "@/components/suffix-prompt-picker"
import { usePendingAttachments } from "@/lib/attachments"
import { effortOptions } from "@/lib/effort"
import { useDaemonRuntime } from "@/lib/runtime"
import { encode, type ModelChoice } from "@/lib/model-choice"
import type { HarnessInfo, TaskMode } from "@/lib/types"
import { cn } from "@/lib/utils"

/*
 * The new-task form's controls: the agent, its effort, and where it runs.
 * Beside create-task-dialog.tsx, which keeps the form, so a second form (a
 * subtask's) can use the same pickers.
 */

export function TaskControls({
  attachments,
  harnesses,
  harness,
  choice,
  preferredChoice,
  effort,
  preferredEffort,
  fast,
  suffixPromptId,
  ready,
  pending,
  reprobePending,
  onPickChoice,
  onTogglePreferredChoice,
  onPreferredChange,
  onReprobe,
  onEffortChange,
  onTogglePreferredEffort,
  onFastChange,
  onRestoreComposer,
  onSuffixPromptChange,
  onSuffixPromptModalChange,
}: {
  attachments: ReturnType<typeof usePendingAttachments>
  harnesses: HarnessInfo[]
  harness: HarnessInfo | null
  choice: ModelChoice | null
  preferredChoice: ModelChoice | null
  effort: string
  /** The star of the current harness · model, if it has one. */
  preferredEffort: string | null
  fast: boolean
  suffixPromptId: string | null
  ready: boolean
  pending: boolean
  reprobePending: boolean
  onPickChoice: (value: string) => void
  onTogglePreferredChoice: (choice: ModelChoice) => void
  onPreferredChange: (next: ModelChoice | null) => void
  onReprobe: () => void
  onEffortChange: (value: string) => void
  onTogglePreferredEffort: (level: string) => void
  onFastChange: (value: boolean) => void
  onRestoreComposer: () => void
  onSuffixPromptChange: (value: string | null) => void
  onSuffixPromptModalChange: (open: boolean) => void
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
          onPreferredChange={onPreferredChange}
          onReprobe={onReprobe}
        />
        {harness?.hasFastMode && <FastModeToggle value={fast} onChange={onFastChange} />}
        {harness?.hasEffort && (
          <EffortPicker
            harness={harness}
            model={choice?.model ?? null}
            effort={effort}
            preferredEffort={preferredEffort}
            custom={customEffort}
            onEffortChange={onEffortChange}
            onTogglePreferred={onTogglePreferredEffort}
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
      <div className="ml-auto flex items-end justify-end @min-[640px]:items-center">
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
  onPreferredChange,
  onReprobe,
}: {
  harnesses: HarnessInfo[]
  harness: HarnessInfo | null
  choice: ModelChoice | null
  preferredChoice: ModelChoice | null
  reprobePending: boolean
  onPick: (value: string) => void
  onTogglePreferred: (choice: ModelChoice) => void
  onPreferredChange: (next: ModelChoice | null) => void
  onReprobe: () => void
}) {
  const { hidden, supported, setHidden } = useHiddenModels()
  const [menuOpen, setMenuOpen] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [managing, setManaging] = useState(false)
  return (
    <>
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
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open)
          // the reveal lasts one opening: the next one is meant to be short again
          if (!open) setRevealed(false)
        }}
      >
        {harnesses.length === 0 ? (
          <MenuNote>No harnesses reported by the daemon.</MenuNote>
        ) : (
          <MenuRadioGroup
            value={choice ? encode(choice) : ""}
            onValueChange={(value) => {
              if (value === MENU_ACTION.reprobe) return onReprobe()
              if (value === MENU_ACTION.revealModels) return setRevealed((on) => !on)
              if (value === MENU_ACTION.manageModels) {
                setMenuOpen(false)
                return setManaging(true)
              }
              onPick(value)
            }}
          >
            <ModelMenuGroups
              harnesses={harnesses}
              hidden={hidden}
              revealed={revealed}
              selected={choice}
              encode={(name, model) => encode({ harness: name, model })}
              onHiddenChange={supported ? setHidden : undefined}
              rowAction={(candidate, model) => (
                <PreferButton
                  harness={candidate}
                  model={model}
                  preferredChoice={preferredChoice}
                  onTogglePreferred={onTogglePreferred}
                />
              )}
            />
            <ModelMenuFooter
              hiddenCount={hiddenTotal(harnesses, hidden)}
              revealed={revealed}
              manageable={supported}
            />
            <MenuAction value={MENU_ACTION.reprobe} divider={!supported}>
              {reprobePending ? "Re-probing…" : "Re-probe models"}
            </MenuAction>
          </MenuRadioGroup>
        )}
      </Menu>
      <ModelVisibilityDialog
        open={managing}
        onOpenChange={setManaging}
        onPreferredChange={onPreferredChange}
      />
    </>
  )
}

function EffortPicker({
  harness,
  model,
  effort,
  preferredEffort,
  custom,
  onEffortChange,
  onTogglePreferred,
  onCustomChange,
  onRestoreComposer,
}: {
  harness: HarnessInfo
  model: string | null
  effort: string
  preferredEffort: string | null
  custom: boolean
  onEffortChange: (value: string) => void
  onTogglePreferred: (level: string) => void
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
            <EffortRow
              key={level}
              harness={harness}
              model={model}
              level={level}
              preferred={level === preferredEffort}
              onTogglePreferred={onTogglePreferred}
            />
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

/** One level, with the star that seeds future dialogs on this harness · model. */
function EffortRow({
  harness,
  model,
  level,
  preferred,
  onTogglePreferred,
}: {
  harness: HarnessInfo
  model: string | null
  level: string
  preferred: boolean
  onTogglePreferred: (level: string) => void
}) {
  const item = (
    <MenuRadioItem
      value={level}
      hint={level === harness.defaults.reasoningEffort ? "default" : undefined}
      className={cn(model && "pr-8")}
    >
      {level}
    </MenuRadioItem>
  )
  if (!model) return item
  const pair = `${harness.name} · ${model}`
  return (
    <div className="relative">
      {item}
      <span className="absolute top-1/2 right-1 z-(--z-pane) flex -translate-y-1/2 items-center">
        <StarButton
          preferred={preferred}
          label={preferred ? `Clear preferred effort ${level} for ${pair}` : `Prefer effort ${level} for ${pair}`}
          onToggle={() => onTogglePreferred(level)}
        />
      </span>
    </div>
  )
}

export function ModePicker({ mode, onChange }: { mode: TaskMode; onChange: (mode: TaskMode) => void }) {
  return (
    <Menu icon={mode === "local" ? <Local /> : <Worktree />} label={mode === "local" ? "This repo" : "Worktree"}>
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
