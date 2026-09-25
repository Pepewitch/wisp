import { useState } from "react"
import { Dialog } from "@base-ui/react/dialog"

import { Moon, Sun } from "@/components/icons"
import { Menu, MenuRadioGroup, MenuRadioItem } from "@/components/menu"
import { ModelVisibilityDialog } from "@/components/model-visibility-dialog"
import { Button, Eyebrow, POPOVER_SURFACE, SwitchTrack } from "@/components/primitives"
import {
  useSaveFactoryKey,
  useSaveReviewJudgeKey,
  useTestFactoryKey,
  useTestReviewJudge,
  useUpdateWispSettings,
} from "@/hooks/mutations"
import { useHarnesses, useWispSettings } from "@/hooks/queries"
import { useHiddenModels } from "@/hooks/useHiddenModels"
import { ApiError } from "@/lib/api"
import { modelTotals } from "@/lib/model-visibility"
import type { FactoryKeyTest, ReviewJudgeStatus, ReviewJudgeTest, SecretKeyStatus } from "@/lib/types"
import { THEME_PREFERENCES, themeStore, useTheme, useThemePreference } from "@/lib/theme"
import type { ThemePreference } from "@/lib/theme"
import { cn } from "@/lib/utils"
import { PwaInstall, PwaInstallSection } from "./pwa-install"
import { SecretKeyControls, SecretKeyRow, type SecretKeySpec } from "./secret-key-field"

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
          <SecretKeyRow
            status={SPECIMEN_JUDGE}
            environmentNote={JEV_KEY.environmentNote}
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
      {specimen ? (
        <Section label="Usage limits" hint={USAGE_LIMITS_HINT}>
          <SecretKeyRow
            status={SPECIMEN_FACTORY_KEY}
            environmentNote={FACTORY_KEY.environmentNote}
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
          <FactoryKeyNotes result={{ ok: true, ms: 212, account: "verified" }} />
        </Section>
      ) : (
        <UsageLimitsSection />
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

const JEV_KEY: SecretKeySpec = {
  label: "Jev API key",
  malformed: "A Jev key is 8 to 512 characters with no spaces.",
  environmentNote: "From the daemon's environment (TYPESAFE_API_KEY or JEV_API_KEY). A key saved here takes its place.",
  fallbackError: "Could not update the review judge.",
  useSave: useSaveReviewJudgeKey,
}

/**
 * The optional review judge (docs/PR-AUTOPILOT.md, "The review judge"). The
 * key's rules are secret-key-field.tsx's. A daemon older than the judge
 * reports no `reviewJudge`, so the section hides.
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
  return (
    <SecretKeyControls
      spec={JEV_KEY}
      status={status}
      probe={probe}
      notes={(result, error) => <ReviewJudgeNotes status={status} result={result} error={error} />}
    />
  )
}

const USAGE_LIMITS_HINT =
  "Optional. claude and codex report their plan limits through their own logins; droid's come from Factory's billing API, which needs a Factory API key. The key goes only to api.factory.ai, and Wisp checks it belongs to the account droid is logged in to. Each daemon keeps its own key."

const FACTORY_KEY: SecretKeySpec = {
  label: "Factory API key",
  malformed: "A Factory key is 8 to 512 characters with no spaces.",
  environmentNote: "From the daemon's environment (FACTORY_API_KEY or DROID_API_KEY). A key saved here takes its place.",
  fallbackError: "Could not update the Factory key.",
  useSave: useSaveFactoryKey,
}

const SPECIMEN_FACTORY_KEY: SecretKeyStatus = { configured: true, source: "environment", hint: "…c41d" }

/** The Factory key for droid's limits in the top bar's usage popover. Hidden on a daemon that cannot read them. */
function UsageLimitsSection() {
  const settings = useWispSettings()
  const status = settings.data?.usageLimits?.factoryKey
  if (!status) return null
  return (
    <Section label="Usage limits" hint={USAGE_LIMITS_HINT}>
      <FactoryKeyControls status={status} />
    </Section>
  )
}

function FactoryKeyControls({ status }: { status: SecretKeyStatus }) {
  const probe = useTestFactoryKey()
  return (
    <SecretKeyControls
      spec={FACTORY_KEY}
      status={status}
      probe={probe}
      notes={(result, error) => <FactoryKeyNotes result={result} error={error} />}
    />
  )
}

/** The last Test's outcome. The status line stays mounted, so a screen reader hears the result when it arrives. */
function FactoryKeyNotes({ result, error }: { result?: FactoryKeyTest; error?: string }) {
  return (
    <>
      <p role="status" className="mt-1.5 text-[11.5px] text-muted-foreground empty:mt-0">
        {result?.ok
          ? result.account === "verified"
            ? `The key works: droid's limits answered in ${result.ms} ms, for the account droid is logged in to.`
            : `The key works: droid's limits answered in ${result.ms} ms. Wisp could not read droid's login to check the account.`
          : ""}
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
