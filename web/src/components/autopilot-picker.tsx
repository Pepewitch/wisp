import { BranchRequest } from "@/components/icons"
import { Menu, MenuCheckboxItem, MenuNote } from "@/components/menu"

export interface AutopilotChoice {
  autoMerge: boolean
  autoFix: boolean
}

/**
 * Auto-merge and auto-fix, armed before the first turn: a worktree task only,
 * since both act on the task's own branch. The same two switches live in the
 * task's "…" menu afterwards.
 */
export function AutopilotPicker({ value, onChange }: { value: AutopilotChoice; onChange: (value: AutopilotChoice) => void }) {
  const label = value.autoMerge && value.autoFix ? "Auto-merge + fix" : value.autoMerge ? "Auto-merge" : value.autoFix ? "Auto-fix" : "Manual PR"
  return (
    <Menu icon={<BranchRequest />} label={label}>
      <MenuCheckboxItem checked={value.autoMerge} onCheckedChange={(autoMerge) => onChange({ ...value, autoMerge })}>
        Auto-merge
      </MenuCheckboxItem>
      <MenuCheckboxItem checked={value.autoFix} onCheckedChange={(autoFix) => onChange({ ...value, autoFix })}>
        Auto-fix
      </MenuCheckboxItem>
      <MenuNote>
        Auto-merge merges the task&apos;s PR once its checks pass and its reviews allow it. Auto-fix sends red CI, a
        conflict, or review feedback back to the agent. Both can be switched later from the task&apos;s menu.
      </MenuNote>
    </Menu>
  )
}
