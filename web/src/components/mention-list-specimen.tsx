import { MentionListRows } from "@/components/mention-list"
import { Eyebrow, POPOVER_SURFACE } from "@/components/primitives"
import { REPOS } from "@/lib/fixtures"
import { entryRows, mentionProjects, mentionTokenAt, parseMention, projectRows, type MentionQuery } from "@/lib/mentions"
import { cn } from "@/lib/utils"

const PROJECTS = mentionProjects(REPOS)
const FOLDER = parseMention(mentionTokenAt("@wisp/web/src/", 14)!, PROJECTS) as Extract<MentionQuery, { kind: "entries" }>
const ENTRIES = [
  { name: "components", kind: "dir" as const },
  { name: "hooks", kind: "dir" as const },
  { name: "lib", kind: "dir" as const },
  { name: "index.css", kind: "file" as const },
  { name: "main.tsx", kind: "file" as const },
]

/**
 * The gallery's `@` list entry, on the real rows. Its own file because
 * gallery.tsx sits at the file-size budget.
 */
export function MentionListSpecimens() {
  return (
    <div className="grid grid-cols-2 gap-10">
      <div>
        <Eyebrow>Typing · @ starts a word</Eyebrow>
        <div className={cn("mt-2.5 w-full rounded-lg p-1", POPOVER_SURFACE)}>
          <MentionListRows rows={projectRows(PROJECTS, "")} selected={0} status={null} onPick={() => {}} onOpen={() => {}} />
        </div>
        <Eyebrow className="mt-5 block">…and @wisp/web/src/ lists that folder</Eyebrow>
        <div className={cn("mt-2.5 w-full rounded-lg p-1", POPOVER_SURFACE)}>
          <MentionListRows rows={entryRows(FOLDER, PROJECTS[0]!.path, ENTRIES)} selected={1} status={null} onPick={() => {}} onOpen={() => {}} />
        </div>
      </div>
      <p className="text-[11.5px] leading-relaxed text-muted-foreground">
        One rule for every row: <span className="font-mono">↵</span> or a click inserts its absolute path as plain
        text (a project's own checkout, never a task worktree), quoted when it has a space, so an agent in one
        project can be pointed at another without searching the disk for it.{" "}
        <span className="font-mono">⇥</span>, <span className="font-mono">→</span> or the chevron opens a project or
        folder and lists its children; typing <span className="font-mono">@name/</span> opens the project named
        exactly that. What git ignores is not offered. An <span className="font-mono">@</span> inside a word, or one no
        project answers, opens nothing.
      </p>
    </div>
  )
}
