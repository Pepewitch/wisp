import { Dialog } from "@base-ui/react/dialog"

import { Button, POPOVER_SURFACE } from "@/components/primitives"
import type { ArchiveFlow } from "@/hooks/useArchiveFlow"
import type { FamilyMember, FamilyStep } from "@/lib/archive-family"
import type { ApiTask } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The archive refusal, as a dialog. Rendered by all three places that archive
 * (the overflow menu, the sidebar row's hover control, `/archive`), so the
 * refusal reads identically wherever the verb was reached from. Its state comes
 * from `useArchiveFlow` (hooks/useArchiveFlow.ts). A parent's family refusal
 * is the same dialog naming every child and what happens to it.
 *
 * Portalled and unmounted while `reason` is null, so a row that is not
 * refusing anything contributes nothing to the document.
 */
const stops = (task: ApiTask): string => {
  const verbs = [
    task.autopilot?.autoMerge && "merging",
    task.autopilot?.autoFix && "fixing",
    task.autopilot?.autoReview && "reviewing",
  ].filter((verb): verb is string => typeof verb === "string")
  if (verbs.length === 0) return "merging"
  return verbs.length === 1 ? verbs[0]! : `${verbs.slice(0, -1).join(", ")} and ${verbs.at(-1)}`
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** The family confirm's button, for the one yes it asks next. */
function familyVerb(next: FamilyStep, members: FamilyMember[]): string {
  const refused = members.filter((member) => member.refused).length
  if (next === "force") return `Force ${plural(refused, "subtask")}`
  if (next === "stopAutopilot") return "Stop their autopilot"
  return `Archive with ${plural(members.length, "subtask")}`
}

/** What the yes covers, and what it leaves for another. */
const FAMILY_NOTE: Record<FamilyStep, string> = {
  archive: "Each subtask is checked as it is first: one with unsaved work, a running turn or autopilot on is named here before anything is archived.",
  force: "Forcing commits a subtask's uncommitted work onto its branch (it is never discarded), stops a running turn, and removes its worktree. Its autopilot is still asked about on its own.",
  stopAutopilot: "Wisp switches off autopilot on the subtasks named; their PRs stay open on GitHub. Nothing else is waived.",
}

/** Every child, and what happens to it: the decision is about all of them. */
function FamilyList({ members }: { members: FamilyMember[] }) {
  return (
    <ul className="mt-2 max-h-[30vh] overflow-y-auto rounded-md border border-border" data-archive-family>
      {members.map((member) => (
        <li key={member.id} className="flex flex-col gap-0.5 border-b border-border px-2.5 py-1.5 last:border-b-0" data-refused={member.refused || undefined}>
          <span className="truncate text-[12px] text-foreground">{member.title}</span>
          <span className={cn("text-[11px] leading-snug", member.refused ? "text-state-stuck" : "text-muted-foreground")}>{member.outcome}</span>
        </li>
      ))}
    </ul>
  )
}

/** The flow's one dialog: the daemon's refusal of this task, or of its family. */
export function ArchiveConfirmDialog({ task, flow }: { task: ApiTask; flow: ArchiveFlow }) {
  const { reason, family, pending, stopsAutopilot } = flow
  const title = `${task.title.slice(0, 40)}${task.title.length > 40 ? "…" : ""}`
  const refused = family?.members.filter((member) => member.refused).length ?? 0
  return (
    <Dialog.Root open={reason !== null || family !== null} onOpenChange={(open) => !open && flow.dismiss()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-(--z-backdrop) bg-scrim" />
        <Dialog.Popup
          className={cn(
            "fixed top-[24vh] left-1/2 z-(--z-modal) w-[min(460px,calc(100vw-3rem))] -translate-x-1/2",
            POPOVER_SURFACE,
            "rounded-xl p-5 shadow-modal outline-none",
          )}
        >
          <Dialog.Title className="text-[14.5px] font-semibold tracking-[-0.01em]">
            Archive {title}{family ? " and its subtasks" : ""}?
          </Dialog.Title>
          {family ? (
            <>
              <p className="mt-2 text-[12px] leading-relaxed text-fg-secondary">
                {refused > 0
                  ? `${plural(refused, "subtask")} cannot be archived as ${refused === 1 ? "it is" : "they are"}, so nothing was archived.`
                  : `It has ${plural(family.members.length, "subtask")}; archiving it archives them too.`}
              </p>
              <FamilyList members={family.members} />
              <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">{FAMILY_NOTE[family.next]}</p>
            </>
          ) : (
            <>
              {/* the daemon's own sentence, verbatim: it names what is unsaved
                  and what the remedies are, which is the whole decision */}
              <p className="mt-2 text-[12px] leading-relaxed text-fg-secondary">{reason}</p>
              <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
                {stopsAutopilot
                  ? `Wisp stops ${stops(task)} it; the PR stays open on GitHub. Anything unsaved in the worktree is still checked before it is removed.`
                  : task.mode === "local"
                    ? "This task runs in the project directory, so archiving only files it — nothing is removed."
                    : "Forcing commits any uncommitted work onto the branch (it is never discarded) and then removes the worktree. The branch is kept, so the commit is where you will find that work."}
              </p>
            </>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" size="lg" onClick={flow.dismiss}>
              Cancel
            </Button>
            <Button
              type="button"
              size="lg"
              tone="primary"
              disabled={pending}
              onClick={() => (family ? flow.confirmFamily() : flow.request(true))}
            >
              {pending ? "Archiving…" : family ? familyVerb(family.next, family.members) : "Archive anyway"}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
