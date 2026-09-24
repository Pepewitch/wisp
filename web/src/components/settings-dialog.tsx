import { useId, useRef, useState } from "react"
import { Dialog } from "@base-ui/react/dialog"

import { Moon, Sun } from "@/components/icons"
import { Menu, MenuRadioGroup, MenuRadioItem } from "@/components/menu"
import { ModelVisibilityDialog } from "@/components/model-visibility-dialog"
import { Button, Eyebrow, POPOVER_SURFACE, SwitchTrack } from "@/components/primitives"
import { useSaveReviewJudgeKey, useTestReviewJudge, useUpdateWispSettings } from "@/hooks/mutations"
import { useHarnesses, useWispSettings } from "@/hooks/queries"
import { useHiddenModels } from "@/hooks/useHiddenModels"
import { ApiError } from "@/lib/api"
import { modelTotals } from "@/lib/model-visibility"
import type { ReviewJudgeStatus, ReviewJudgeTest } from "@/lib/types"
import { THEME_PREFERENCES, themeStore, useTheme, useThemePreference } from "@/lib/theme"
import type { ThemePreference } from "@/lib/theme"
import { cn } from "@/lib/utils"
import { PwaInstall, PwaInstallSection } from "./pwa-install"

const THEME_LABEL: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
}

/**
 * Wisp's own settings — the gear in the top bar, and the gear in the drawer
 * footer on touch, where there is no top bar to carry one. On touch the drawer
 * is dismissed in the same commit that opens this, which is the pair a
 * project's gear already makes there.
 *
 * Preferences apply the moment they are picked, so the footer closes the
 * modal and nothing else. Appearance belongs to this app on this device;
 * behavior belongs to the connected daemon and is shared by its clients.
 *
 * Per-PROJECT settings are a different modal reached from a project's own gear
 * (`project-settings-dialog.tsx`): those are daemon state about one repo.
 */
export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-(--z-backdrop) bg-scrim" />
        <Dialog.Popup
          className={cn(
            "fixed top-[10vh] left-1/2 z-(--z-modal) w-[min(520px,calc(100vw-3rem))] -translate-x-1/2",
            POPOVER_SURFACE,
            "overflow-hidden rounded-xl shadow-modal outline-none",
          )}
        >
          <div className="settings-content flex max-h-[80dvh] flex-col">
            <div className="flex shrink-0 items-baseline gap-2.5 border-b border-border px-4 py-3">
              <Dialog.Title className="text-[14.5px] font-semibold tracking-[-0.01em]">Settings</Dialog.Title>
              <span className="min-w-0 flex-1 truncate text-[10.5px] text-faint">App and Wisp behavior</span>
            </div>

            <div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
              <SettingsSections />
            </div>

            <div className="flex shrink-0 items-center justify-end border-t border-border px-4 py-2.5">
              <Button size="lg" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** The same sections inside a static surface, for `#/gallery`. */
export function SettingsSpecimen() {
  return (
    <div className={cn(POPOVER_SURFACE, "w-full max-w-[520px] overflow-hidden rounded-xl")}>
      <div className="flex items-baseline gap-2.5 border-b border-border px-4 py-3">
        <h2 className="text-[14.5px] font-semibold tracking-[-0.01em]">Settings</h2>
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-faint">App and Wisp behavior</span>
      </div>
      <div className="px-4 py-3.5">
        <SettingsSections specimen />
        <PwaInstallSection state="ios" />
      </div>
    </div>
  )
}

function SettingsSections({ specimen = false }: { specimen?: boolean }) {
  return (
    <>
      <Section
        label="Appearance"
        hint="Dark is Wisp's own. System follows this device's appearance, and the platform's own scrollbars, caret and controls follow whichever theme is on screen."
      >
        <ThemeField />
      </Section>
      {specimen ? (
        <Section
          label="Models"
          hint="Which models each harness offers in the picker. Wisp-wide behavior for every client connected to this daemon."
        >
          <ModelsRow shown={14} total={187} onManage={() => {}} />
        </Section>
      ) : (
        <ModelsSection />
      )}
      {specimen ? (
        <Section
          label="Task names"
          hint="Wisp-wide behavior for every client connected to this daemon."
        >
          <TaskTitleToggle checked onCheckedChange={() => {}} />
        </Section>
      ) : (
        <TaskNameSection />
      )}
      {specimen ? (
        <Section label="Review judge" hint={REVIEW_JUDGE_HINT}>
          <ReviewJudgeKeyRow
            status={SPECIMEN_JUDGE}
            focus={null}
            busy={false}
            testing={false}
            confirming={false}
            onTest={() => {}}
            onReplace={() => {}}
            onRemove={() => {}}
            onKeep={() => {}}
            onConfirmRemove={() => {}}
          />
          <ReviewJudgeNotes status={SPECIMEN_JUDGE} result={{ ok: true, ms: 768, model: SPECIMEN_JUDGE.model }} />
        </Section>
      ) : (
        <ReviewJudgeSection />
      )}
      {!specimen && <PwaInstall />}
    </>
  )
}

/**
 * The door to the model manager, and the one number that says whether it is
 * worth opening. Hidden on a daemon that cannot store a curation, for the
 * same reason Task names is — see below.
 */
function ModelsSection() {
  const [managing, setManaging] = useState(false)
  const { hidden, supported } = useHiddenModels()
  const harnesses = useHarnesses(true)
  if (!supported) return null
  const totals = modelTotals(harnesses.data ?? [], hidden)

  return (
    <Section
      label="Models"
      hint="Which models each harness offers in the picker. Wisp-wide behavior for every client connected to this daemon."
    >
      <ModelsRow shown={totals.shown} total={totals.total} onManage={() => setManaging(true)} />
      <ModelVisibilityDialog open={managing} onOpenChange={setManaging} />
    </Section>
  )
}

function ModelsRow({
  shown,
  total,
  onManage,
}: {
  shown: number
  total: number
  onManage: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12.5px] text-fg-secondary">Shown in the picker</span>
      <span className="ml-auto font-mono text-[11.5px] text-faint">
        {shown} of {total}
      </span>
      <Button onClick={onManage}>Manage…</Button>
    </div>
  )
}

/**
 * Daemon-side preferences. An older daemon has no /api/settings and answers
 * 404: hide the section entirely rather than alarm the user about a
 * capability their daemon never had — the same way the composer gates task
 * search on what the connected daemon can serve.
 */
function TaskNameSection() {
  const settings = useWispSettings()
  const update = useUpdateWispSettings()
  if (settings.error instanceof ApiError && settings.error.status === 404) return null
  const checked = settings.data?.autoRenameTasksFromPullRequests ?? true
  const error = settings.error ?? update.error

  return (
    <Section
      label="Task names"
      hint="Wisp-wide behavior for every client connected to this daemon."
    >
      <TaskTitleToggle
        checked={checked}
        disabled={!settings.data || update.isPending}
        onCheckedChange={(autoRenameTasksFromPullRequests) =>
          update.mutate({ autoRenameTasksFromPullRequests })
        }
      />
      {error && (
        <p role="alert" className="mt-2 text-[11.5px] text-destructive">
          {error instanceof Error ? error.message : "Could not update this setting."}
        </p>
      )}
    </Section>
  )
}

function TaskTitleToggle({
  checked,
  disabled = false,
  onCheckedChange,
}: {
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label="Use pull request titles"
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className="flex w-full items-center justify-between gap-3 rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60"
    >
      <span>
        <span className="block text-[12.5px] text-fg-secondary">Use pull request titles</span>
        <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
          Rename a task to the title of the pull request Wisp shows for it. A name you type yourself always wins.
        </span>
      </span>
      <SwitchTrack checked={checked} />
    </button>
  )
}

const REVIEW_JUDGE_HINT =
  "Optional. With a Jev API key from TypeSafe, auto-merge and auto-fix ask a small classifier whether a bot's review summary asks for changes, and whether an approval lists findings. The review's text goes to TypeSafe, quoted code included; the diff and the repository never do. Each daemon keeps its own key."

const SPECIMEN_JUDGE: ReviewJudgeStatus = {
  configured: true,
  source: "settings",
  hint: "…3f9a",
  model: "jev-1.13.0",
  usage: { month: "2026-09", calls: 42, errors: 0, inputTokens: 51_000, costUsd: 0.0021 },
}

/** The daemon's own rule (routes/settings.ts), checked first so a typo gets a sentence, not a field name. */
const JEV_KEY_SHAPE = /^[\x21-\x7e]{8,512}$/

type JudgeFocus = "field" | "replace" | "remove" | "confirm"

/**
 * The optional review judge (docs/PR-AUTOPILOT.md, "The review judge").
 *
 * A secret, not a preference, so this is the modal's one Save (frontend.md
 * §5g): the section says when a typed key is still unsaved. The key is
 * write-only and kept out of the client:
 * - the field is uncontrolled, so the key is never React state or a DOM
 *   attribute, and it remounts whenever the key changes, here or from
 *   another client, which drops any draft;
 * - the mutation that carries it is never cached (`gcTime: 0`);
 * - the daemon answers only with whether a key is set, where it came from,
 *   and its last four characters.
 *
 * A daemon older than the judge reports no `reviewJudge`, so the section hides.
 */
function ReviewJudgeSection() {
  const settings = useWispSettings()
  const status = settings.data?.reviewJudge
  if (!status) return null
  return (
    <Section label="Review judge" hint={REVIEW_JUDGE_HINT}>
      <ReviewJudgeControls status={status} />
    </Section>
  )
}

function ReviewJudgeControls({ status }: { status: ReviewJudgeStatus }) {
  const probe = useTestReviewJudge()
  const remove = useSaveReviewJudgeKey()
  // Each of these names the key it was about, so a key changed from anywhere
  // ends a replacement, a pending confirmation, and a test result.
  const [replacing, setReplacing] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [tested, setTested] = useState<string | null>(null)
  const asking = !status.configured || replacing === status.hint

  // Focus follows the control that replaces the one it was on; switching
  // between the field and the key's row unmounts the button just pressed.
  const [focus, setFocus] = useState<JudgeFocus | null>(null)
  const [wasAsking, setWasAsking] = useState(asking)
  if (wasAsking !== asking) {
    setWasAsking(asking)
    setFocus(asking ? "field" : "replace")
  }

  const current = tested !== null && tested === status.hint
  const result = !asking && current ? probe.data : undefined
  const error = asking ? null : remove.error ?? (current ? probe.error : null)

  return (
    <>
      {asking ? (
        <ReviewJudgeKeyForm
          key={status.hint ?? "none"}
          autoFocus={focus === "field"}
          canCancel={status.configured}
          onCancel={() => setReplacing(null)}
        />
      ) : (
        <ReviewJudgeKeyRow
          status={status}
          focus={focus}
          busy={remove.isPending}
          testing={probe.isPending}
          confirming={confirming !== null && confirming === status.hint}
          onTest={() => {
            remove.reset()
            setTested(status.hint)
            probe.mutate()
          }}
          onReplace={() => {
            setConfirming(null)
            setReplacing(status.hint)
          }}
          onRemove={() => {
            setFocus("confirm")
            setConfirming(status.hint)
          }}
          onKeep={() => {
            setFocus("remove")
            setConfirming(null)
          }}
          onConfirmRemove={() => {
            setTested(null)
            remove.mutate(null)
          }}
        />
      )}
      <ReviewJudgeNotes status={status} result={result} error={error ? errorText(error) : undefined} />
    </>
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Could not update the review judge."
}

/** Its own component so that unmounting it drops the typed key and the mutation that carried it. */
function ReviewJudgeKeyForm({
  autoFocus,
  canCancel,
  onCancel,
}: {
  autoFocus: boolean
  canCancel: boolean
  onCancel: () => void
}) {
  const save = useSaveReviewJudgeKey()
  const field = useRef<HTMLInputElement>(null)
  const [typed, setTyped] = useState(false)
  const [malformed, setMalformed] = useState(false)
  const errorId = useId()

  const submit = () => {
    const key = field.current?.value.trim() ?? ""
    if (key === "" || save.isPending) return
    if (!JEV_KEY_SHAPE.test(key)) {
      setMalformed(true)
      return
    }
    save.mutate(key)
  }
  const error = malformed
    ? "A Jev key is 8 to 512 characters with no spaces."
    : save.error
      ? errorText(save.error)
      : null

  return (
    <>
      {/* no <form>: a password field in a form that vanishes after a fetch reads to a
          browser as a login, and it would offer to save the key or fill in a saved one */}
      <div className="flex items-center gap-2">
        <input
          ref={field}
          type="password"
          aria-label="Jev API key"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-form-type="other"
          spellCheck={false}
          placeholder="Jev API key"
          autoFocus={autoFocus}
          readOnly={save.isPending}
          aria-invalid={error !== null}
          aria-describedby={error !== null ? errorId : undefined}
          onChange={(event) => {
            setTyped(event.target.value.trim() !== "")
            setMalformed(false)
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            event.preventDefault()
            submit()
          }}
          className={cn(
            "h-[26px] min-w-0 flex-1 rounded-md border border-input bg-surface px-2.5",
            "font-mono text-[11.5px] text-foreground placeholder:font-sans placeholder:text-faint",
            "focus:border-accent-dim focus:ring-2 focus:ring-ring/15 focus:outline-none",
          )}
        />
        <Button onClick={submit} disabled={save.isPending || !typed}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        {canCancel && (
          <Button onClick={onCancel} disabled={save.isPending}>
            Cancel
          </Button>
        )}
      </div>
      {error !== null ? (
        <p id={errorId} role="alert" className="mt-1.5 text-[11.5px] text-destructive">
          {error}
        </p>
      ) : (
        typed && (
          <p className="mt-1.5 text-[11px] text-faint">Not saved yet. Save it, or press Enter; Done leaves it unsaved.</p>
        )
      )}
    </>
  )
}

function ReviewJudgeKeyRow({
  status,
  focus,
  busy,
  testing,
  confirming,
  onTest,
  onReplace,
  onRemove,
  onKeep,
  onConfirmRemove,
}: {
  status: ReviewJudgeStatus
  focus: JudgeFocus | null
  busy: boolean
  testing: boolean
  confirming: boolean
  onTest: () => void
  onReplace: () => void
  onRemove: () => void
  onKeep: () => void
  onConfirmRemove: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {/* a floor under the text, so on a phone the buttons wrap below it rather than squeeze it */}
      <span className="min-w-40 flex-1">
        <span className="block text-[12.5px] text-fg-secondary">
          Key <span className="font-mono text-[11.5px] text-muted-foreground">{status.hint}</span>
        </span>
        <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
          {status.source === "environment"
            ? "From the daemon's environment (TYPESAFE_API_KEY or JEV_API_KEY). A key saved here takes its place."
            : "Saved on this daemon."}
        </span>
      </span>
      {/* keyed, so each set of buttons mounts fresh and autoFocus lands */}
      {confirming ? (
        <span key="confirm" className="flex items-center gap-1.5">
          <span className="text-[11.5px] text-muted-foreground">Remove the key?</span>
          <Button tone="destructive" onClick={onConfirmRemove} disabled={busy} autoFocus={focus === "confirm"}>
            {busy ? "Removing…" : "Remove"}
          </Button>
          <Button onClick={onKeep} disabled={busy}>
            Keep
          </Button>
        </span>
      ) : (
        <span key="actions" className="flex items-center gap-1.5">
          <Button onClick={onTest} disabled={busy || testing}>
            {testing ? "Testing…" : "Test"}
          </Button>
          <Button onClick={onReplace} disabled={busy} autoFocus={focus === "replace"}>
            Replace…
          </Button>
          {status.source === "settings" && (
            <Button onClick={onRemove} disabled={busy} autoFocus={focus === "remove"}>
              Remove
            </Button>
          )}
        </span>
      )}
    </div>
  )
}

/**
 * The month's usage, and the outcome of the last Test. The status line stays
 * mounted, so a screen reader hears the result when its text arrives.
 */
function ReviewJudgeNotes({
  status,
  result,
  error,
}: {
  status: ReviewJudgeStatus
  result?: ReviewJudgeTest
  error?: string
}) {
  const { calls, errors, costUsd } = status.usage
  return (
    <>
      {(status.configured || calls > 0) && (
        <p className="mt-2 text-[11px] text-faint">
          {calls} {calls === 1 ? "call" : "calls"} this month · {usageCost(costUsd)}
          {errors > 0 && ` · ${errors} failed`} · {status.model}
        </p>
      )}
      <p role="status" className="mt-1.5 text-[11.5px] text-muted-foreground empty:mt-0">
        {result?.ok ? `The key works: answered in ${result.ms} ms.` : ""}
      </p>
      {result && !result.ok && (
        <p role="alert" className="mt-1.5 text-[11.5px] text-destructive">
          The test failed: {result.error}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1.5 text-[11.5px] text-destructive">
          {error}
        </p>
      )}
    </>
  )
}

/** A call costs about $0.00005, so a month rounds to nothing for a while. */
function usageCost(costUsd: number): string {
  if (costUsd === 0) return "$0"
  if (costUsd < 0.01) return "under $0.01"
  return `$${costUsd.toFixed(2)}`
}

/**
 * The one dropdown, because picking one of three is what a menu is for. Its
 * glyph reports what is ON SCREEN rather than what was chosen, so `System`
 * shows a moon on a dark device and a sun on a light one; the row's own hint
 * says the same thing in a word.
 */
function ThemeField() {
  const preference = useThemePreference()
  const theme = useTheme()
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12.5px] text-fg-secondary">Theme</span>
      <Menu
        aria-label="Theme"
        label={THEME_LABEL[preference]}
        icon={theme === "dark" ? <Moon /> : <Sun />}
        align="end"
      >
        <MenuRadioGroup value={preference} onValueChange={(value) => themeStore.set(value as ThemePreference)}>
          {THEME_PREFERENCES.map((option) => (
            <MenuRadioItem
              key={option}
              value={option}
              hint={option === "system" && preference === "system" ? theme : undefined}
            >
              {THEME_LABEL[option]}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </Menu>
    </div>
  )
}

function Section({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="mt-4 border-t border-border pt-3.5 first-of-type:mt-0 first-of-type:border-t-0 first-of-type:pt-0">
      <Eyebrow>{label}</Eyebrow>
      <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">{hint}</p>
      <div className="mt-2.5">{children}</div>
    </section>
  )
}
