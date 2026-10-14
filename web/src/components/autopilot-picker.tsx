import { BranchRequest } from "@/components/icons"
import { Menu, MenuCheckboxItem, MenuNote } from "@/components/menu"
import { autopilotChoiceLabel } from "@/lib/autopilot-words"

export interface AutopilotChoice {
  autoMerge: boolean
  autoFix: boolean
  /** absent where the daemon has no auto-review; reads as off */
  autoReview?: boolean
}

/**
 * Auto-merge, auto-fix and (where the daemon has it) auto-review, armed before
 * the first turn: a worktree task only, since all of them act on the task's
 * own branch. The same switches live in the task's "…" menu afterwards.
 */
export function AutopilotPicker({
  value,
  onChange,
  review = false,
}: {
  value: AutopilotChoice
  onChange: (value: AutopilotChoice) => void
  /** the daemon advertises `features.autoReview`: offer the third switch */
  review?: boolean
}) {
  return (
    <Menu icon={<BranchRequest />} label={autopilotChoiceLabel(review ? value : { ...value, autoReview: false })}>
      <MenuCheckboxItem checked={value.autoMerge} onCheckedChange={(autoMerge) => onChange({ ...value, autoMerge })}>
        Auto-merge
      </MenuCheckboxItem>
      <MenuCheckboxItem checked={value.autoFix} onCheckedChange={(autoFix) => onChange({ ...value, autoFix })}>
        Auto-fix
      </MenuCheckboxItem>
      {review && (
        <MenuCheckboxItem checked={value.autoReview === true} onCheckedChange={(autoReview) => onChange({ ...value, autoReview })}>
          Auto-review
        </MenuCheckboxItem>
      )}
      <MenuNote>
        Auto-merge merges the task&apos;s PR once its checks pass and its reviews allow it. Auto-fix sends red CI, a
        conflict, or review feedback back to the agent.
        {review && " Auto-review has a separate agent verify each PR head before it can merge."} All of them can be
        switched later from the task&apos;s menu.
      </MenuNote>
    </Menu>
  )
}
