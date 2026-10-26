import { useState, type ReactNode } from "react"

import { Menu, MenuItem } from "@/components/menu"
import { useTaskVerbs } from "@/hooks/useTaskVerbs"
import type { ApiTask } from "@/lib/types"

/**
 * The title menu: the task verbs that are not worth a permanent button. The
 * task's title in the top bar is the trigger (`top-bar-task.tsx`), with the
 * facts you rarely need above the verbs. The phone reaches the same verbs
 * from its task sheet (task-sheet.tsx), and the autopilot switches from the
 * summary card's Autopilot row on both.
 * Stop/steer lives in the composer. Fresh session is a slash command in the
 * composer (`/fresh`).
 */
export function TaskActions({
  task,
  title,
}: {
  task: ApiTask
  /** its trigger, the facts above the verbs (and their spoken form), and rows after them */
  title: { trigger: ReactNode; className: string; header: ReactNode; headerLabel?: string; after: ReactNode }
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const verbs = useTaskVerbs(task)
  // every item closes the menu before it acts
  const pick = (act: () => void) => () => {
    setMenuOpen(false)
    act()
  }

  return (
    <>
      <Menu
        label="Task"
        trigger={title.trigger}
        className={title.className}
        header={title.header}
        headerLabel={title.headerLabel}
        open={menuOpen}
        onOpenChange={setMenuOpen}
      >
        {/* The keyboard is the primary way in; the menu is how you FIND that
            there is a keyboard way in, so the row carries the chord. */}
        <MenuItem hint="⌘F" onClick={pick(verbs.find)}>
          Find in task
        </MenuItem>
        <MenuItem onClick={pick(verbs.rename)}>Rename</MenuItem>
        {verbs.newSubtask && <MenuItem onClick={pick(verbs.newSubtask)}>New subtask…</MenuItem>}
        <MenuItem onClick={verbs.archive ? pick(verbs.archive) : undefined} disabled={!verbs.archive}>
          Archive
        </MenuItem>
        {verbs.retention && <MenuItem onClick={pick(verbs.retention)}>Export or delete task data…</MenuItem>}
        {title.after}
      </Menu>
      {verbs.dialogs}
    </>
  )
}
