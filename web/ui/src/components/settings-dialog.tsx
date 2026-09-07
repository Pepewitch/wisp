import { Dialog } from "@base-ui/react/dialog"

import { Moon, Sun } from "@/components/icons"
import { Menu, MenuRadioGroup, MenuRadioItem } from "@/components/menu"
import { Button, Eyebrow, POPOVER_SURFACE } from "@/components/primitives"
import { THEME_PREFERENCES, themeStore, useTheme, useThemePreference } from "@/lib/theme"
import type { ThemePreference } from "@/lib/theme"
import { cn } from "@/lib/utils"

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
 * Everything here is a CLIENT-LOCAL preference: it belongs to this app on this
 * device, never to the daemon and never to a connection, which is why the
 * header says so instead of leaving a person to guess whether a remote just
 * changed. Nothing is saved and nothing is cancelled — a preference applies
 * the moment it is picked, so the footer closes the modal and nothing else.
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
          <div className="flex max-h-[80vh] flex-col">
            <div className="flex shrink-0 items-baseline gap-2.5 border-b border-border px-4 py-3">
              <Dialog.Title className="text-[14.5px] font-semibold tracking-[-0.01em]">Settings</Dialog.Title>
              <span className="min-w-0 flex-1 truncate text-[10.5px] text-faint">This app, on this device</span>
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
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-faint">This app, on this device</span>
      </div>
      <div className="px-4 py-3.5">
        <SettingsSections />
      </div>
    </div>
  )
}

function SettingsSections() {
  return (
    <Section
      label="Appearance"
      hint="Dark is Wisp's own. System follows this device's appearance, and the platform's own scrollbars, caret and controls follow whichever theme is on screen."
    >
      <ThemeField />
    </Section>
  )
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
