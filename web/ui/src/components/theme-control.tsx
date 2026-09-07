import { Moon, Sun } from "@/components/icons"
import { Menu, MenuRadioGroup, MenuRadioItem } from "@/components/menu"
import { THEME_PREFERENCES, themeStore, useTheme, useThemePreference } from "@/lib/theme"
import type { ThemePreference } from "@/lib/theme"

const LABEL: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
}

/**
 * The app's one theme switch: System, Light, Dark, in the sidebar footer
 * beside Show archived.
 *
 * It lives there rather than in the top bar because it is the same control in
 * both shells — the drawer carries this footer on touch — and because a
 * preference you set once a year does not belong next to the connection you
 * change all day.
 *
 * The trigger's glyph reports what is ON SCREEN, not what was chosen, so
 * `System` shows a moon on a dark Mac and a sun on a light one; the chosen
 * row's own resolved value rides in the menu as its hint.
 */
export function ThemeControl() {
  const preference = useThemePreference()
  const theme = useTheme()
  return (
    <Menu
      label="Theme"
      iconOnly
      icon={theme === "dark" ? <Moon /> : <Sun />}
      side="top"
      align="end"
    >
      <MenuRadioGroup value={preference} onValueChange={(value) => themeStore.set(value as ThemePreference)}>
        {THEME_PREFERENCES.map((option) => (
          <MenuRadioItem
            key={option}
            value={option}
            hint={option === "system" && preference === "system" ? theme : undefined}
          >
            {LABEL[option]}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </Menu>
  )
}
