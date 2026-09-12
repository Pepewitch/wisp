import { CopyButton } from "@/components/copy-button"
import { BUBBLE_ACTION } from "@/components/person-bubble"
import { useAttachCommand } from "@/hooks/queries"
import type { ApiTask } from "@/lib/types"

/**
 * The resume hint, on the right edge directly above the steer composer. Once a
 * turn has ended, the task's stored session can be continued outside Wisp, and
 * this names it — assembled by the daemon from the adapter's own `attach`
 * template (claude `--resume`, codex's `resume` subcommand, droid's, cursor's
 * and opencode's equivalents), never reconstructed client-side, so a custom
 * harness with no attach command renders nothing rather than a guess.
 *
 * It shows only when a session exists AND no turn is running: mid-turn the
 * command is not what you want to paste yet, and the running note owns the
 * row above the composer.
 *
 * The display is one short fact — `session: <id>` — because the full command
 * (`cd <worktree> && …`, the same one `/attach` puts in its note, since a
 * harness resolves its sessions per directory) is what the copy button
 * carries, not what the line spells out. Hovering still names the whole
 * working line via `title`, and the id truncates from the LEFT (`dir="rtl"`
 * on an all-LTR string) so a long session id keeps its tail — the part that
 * identifies it — on a phone.
 */
export function ResumeHint({ task }: { task: ApiTask }) {
  const session = task.session_id
  const turnEnded =
    task.state !== "creating" && task.state !== "running" && task.state !== "stuck"
  const attach = useAttachCommand(!task.archived && turnEnded ? task.id : null, session)
  if (!attach.data?.argv) return null
  const line = attach.data.cwd
    ? `cd ${attach.data.cwd} && ${attach.data.argv.join(" ")}`
    : attach.data.argv.join(" ")
  return (
    <div data-testid="resume-hint" className="mb-1.5 flex items-center justify-end gap-1.5">
      <span
        dir="rtl"
        title={line}
        className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground"
      >
        session: {session}
      </span>
      <CopyButton
        text={line}
        label="Copy the resume command"
        title="Copy the resume command"
        className={BUBBLE_ACTION}
      />
    </div>
  )
}
