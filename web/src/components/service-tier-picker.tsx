import { Fast } from "@/components/icons"
import { Menu, MenuNote, MenuRadioGroup, MenuRadioItem } from "@/components/menu"
import {
  defaultServiceTierFor,
  serviceTierLabel,
  serviceTierOptions,
} from "@/lib/service-tier"
import type { HarnessInfo } from "@/lib/types"

export function ServiceTierPicker({
  harness,
  model,
  value,
  disabled = false,
  touch = false,
  onChange,
}: {
  harness: HarnessInfo | null
  model: string
  value: string | null
  disabled?: boolean
  touch?: boolean
  onChange: (value: string) => void
}) {
  const options = serviceTierOptions(harness, model, value)
  if (options.length <= 1) return null
  const selected = value ?? defaultServiceTierFor(harness) ?? "default"

  return (
    <Menu
      icon={<Fast />}
      touch={touch}
      label={serviceTierLabel(selected)}
      aria-label={`Response speed: ${serviceTierLabel(selected)}`}
      disabled={disabled}
    >
      <MenuNote>Fast returns responses sooner but uses more quota.</MenuNote>
      <MenuRadioGroup value={selected} onValueChange={onChange}>
        {options.map((option) => (
          <MenuRadioItem
            key={option.id}
            value={option.id}
            hint={option.id === "priority" ? "higher usage" : option.id === "default" ? "default" : undefined}
          >
            {option.name}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </Menu>
  )
}
