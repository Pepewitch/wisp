import { Star, StarFilled } from "@/components/icons"
import type { ModelChoice } from "@/lib/model-choice"
import type { HarnessInfo } from "@/lib/types"
import { cn } from "@/lib/utils"

const sameChoice = (a: ModelChoice | null, b: ModelChoice): boolean =>
  a?.harness === b.harness && a.model === b.model

/** The star that seeds the NEXT create dialog with this harness · model. */
export function PreferButton({
  harness,
  model,
  preferredChoice,
  onTogglePreferred,
}: {
  harness: HarnessInfo
  model: string
  preferredChoice: ModelChoice | null
  onTogglePreferred: (choice: ModelChoice) => void
}) {
  const choice = { harness: harness.name, model }
  const preferred = sameChoice(preferredChoice, choice)
  const label = preferred
    ? `Clear preferred model ${harness.name} · ${model}`
    : `Prefer ${harness.name} · ${model} for new tasks`
  return (
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
        "flex size-6 items-center justify-center rounded-md",
        "text-faint hover:bg-hover hover:text-foreground",
        "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        "[&>svg]:size-3.5",
        preferred && "text-foreground",
      )}
    >
      {preferred ? <StarFilled /> : <Star />}
    </button>
  )
}

