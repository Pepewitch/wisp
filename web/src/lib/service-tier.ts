import type { HarnessInfo, ServiceTierInfo } from "@/lib/types"

const STANDARD: ServiceTierInfo = {
  id: "default",
  name: "Standard",
  description: "Normal response speed and usage.",
}

export function defaultServiceTierFor(harness: HarnessInfo | null | undefined): string | null {
  return harness?.hasServiceTier ? harness.defaultServiceTier ?? STANDARD.id : null
}

/** Standard is implicit in Codex's catalog; only paid alternatives are listed. */
export function serviceTierOptions(
  harness: HarnessInfo | null | undefined,
  model: string,
  selected?: string | null,
): ServiceTierInfo[] {
  if (!harness?.hasServiceTier) return []
  const advertised = harness.models?.serviceTiers?.[model] ?? []
  if (advertised.length === 0 && !selected) return []
  const options = [STANDARD, ...advertised.filter((option) => option.id !== STANDARD.id)]
  if (selected && !options.some((option) => option.id === selected)) {
    options.push({
      id: selected,
      name: selected === "priority" ? "Fast" : selected,
      description: "Selected on this task, but not advertised by the current model catalog.",
    })
  }
  return options
}

export function serviceTierLabel(tier: string | null | undefined): string {
  if (!tier || tier === "default") return "Standard"
  return tier === "priority" ? "Fast" : tier
}

export function serviceTierForModel(
  harness: HarnessInfo | null | undefined,
  model: string,
  current?: string | null,
): string | null {
  const fallback = defaultServiceTierFor(harness)
  if (!fallback) return null
  const options = serviceTierOptions(harness, model)
  return current && options.some((option) => option.id === current) ? current : fallback
}
