import { useRef, type Dispatch, type RefObject, type SetStateAction } from "react"

import { MentionListRows } from "@/components/mention-list"
import { PendingAttachmentRows } from "@/components/pending-attachments"
import { POPOVER_SURFACE } from "@/components/primitives"
import { SlashPaletteList } from "@/components/slash-palette"
import { useProjectSkills } from "@/hooks/queries"
import { hasCoarsePointer } from "@/hooks/useMediaQuery"
import { useCaretRestore } from "@/hooks/useCaretRestore"
import { useComposerMentions } from "@/hooks/useComposerMentions"
import { useComposerSlash } from "@/hooks/useComposerSlash"
import {
  insertPastedText,
  undoPastedFile,
  useComposerDrop,
  type PendingAttachments,
} from "@/lib/attachments"
import { failureReason } from "@/lib/api"
import { handleComposerPaste } from "@/lib/paste-links"
import { hasSlashRows, registryGroups, type SlashEntry } from "@/lib/slash"
import { cn } from "@/lib/utils"

/**
 * The create composer's prompt textarea, its completions and its pending
 * attachments.
 *
 * Its own file because paste is three behaviours in one handler now — files, a
 * long paste that becomes a text file (A1d), and Slack-style HTML links — and
 * the dialog it sits in is the longest component in this app.
 *
 * `@` and `/` work here exactly as they do in the steer box, through the same
 * two hooks: the first task you describe is the one most likely to name a file
 * or ask for a skill, so a composer without them sends you to the steer box to
 * retype what you already typed. Two differences, both from there being no
 * task yet:
 *
 *  - every `/` pick is PROMPT TEXT. The Wisp tier (`/status`, `/archive`), the
 *    harness's out-of-turn reads and the tool panel all act on a task that
 *    does not exist, so they are absent rather than offered and refused.
 *  - the registry is the PROJECT's, read for the harness picked in the bar
 *    below (GET /api/projects/skills). A harness that enumerates only from a
 *    live session says so in the group's own footer.
 *
 * Both lists float BELOW the textarea, over the notices and the control bar:
 * the modal's own top edge is a few pixels above the prompt, and a list that
 * opened upwards would be clipped by it.
 */
export function PromptField({
  box,
  prompt,
  setPrompt,
  attachments,
  repoPath = null,
  harness = null,
  canReadSkills = false,
}: {
  box: RefObject<HTMLTextAreaElement | null>
  prompt: string
  setPrompt: Dispatch<SetStateAction<string>>
  attachments: PendingAttachments
  /** the project whose skills and files the completions read; null offers neither */
  repoPath?: string | null
  /** the harness picked in the bar below — whose registry the `/` palette shows */
  harness?: string | null
  /** `features.projectSkills`: an older daemon has no project registry to ask for */
  canReadSkills?: boolean
}) {
  // The prompt field is the drop zone: it fills the modal, so the whole
  // "drop the file on the dialog" gesture lands here, in the same addFiles
  // path a paste and a pick use.
  const { dragging, dropHandlers } = useComposerDrop({
    onFiles: (files) => attachments.addFiles(files),
  })
  // the modal is the same one a thumb opens: its rows answer the pointer too
  const touch = hasCoarsePointer()
  /** where the caret goes after a pick rewrote the draft */
  const caret = useRef<number | null>(null)
  const command = useRef<HTMLDivElement>(null)
  const mentions = useComposerMentions({
    boxRef: box,
    caretRef: caret,
    value: prompt,
    setValue: setPrompt,
  })
  const slash = useComposerSlash({
    value: prompt,
    setValue: setPrompt,
    caretRef: caret,
    commandRef: command,
    mentions,
  })
  useCaretRestore(box, caret)

  // asked for when the palette opens, not when the dialog does: enumeration is
  // free in tokens and expensive in wall clock (SP2)
  const asking = canReadSkills && repoPath !== null && harness !== null
  const skills = useProjectSkills(repoPath, harness, asking && slash.token !== null)
  const groups = registryGroups(
    skills.data,
    !asking
      ? null
      : skills.isError
        ? failureReason(skills.error)
        : skills.data === undefined
          ? "Reading this project's registry…"
          : null,
  )
  // nothing to show is no floating box: an empty palette over the controls
  // would be a promise this harness cannot keep
  const paletteOpen = slash.token !== null && hasSlashRows(groups)

  const pick = (entry: SlashEntry) => {
    // Every row here is reviewable prompt text — `/name` where the harness
    // runs it headless, a plain-text ask on codex (SP2) — so a pick prefills
    // and never submits.
    slash.consume(entry.prefill ?? `/${entry.name}`)
  }

  return (
    <div
      data-testid="create-prompt-field"
      onDragEnter={dropHandlers.onDragEnter}
      onDragOver={dropHandlers.onDragOver}
      onDragLeave={dropHandlers.onDragLeave}
      onDrop={dropHandlers.onDrop}
      className={cn(
        "px-4 pt-3.5",
        // the focus treatment, answering the drag instead of the caret
        dragging && "ring-2 ring-ring/15",
      )}
    >
      {/* the list's own positioned wrapper: it answers the textarea's width
          and its bottom edge, not the modal's */}
      <div className="relative">
        <textarea
          ref={box}
          rows={6}
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value)
            slash.track(e.target.value, e.target.selectionStart)
          }}
          onKeyUp={(e) => slash.track(e.currentTarget.value, e.currentTarget.selectionStart)}
          onClick={(e) => slash.track(e.currentTarget.value, e.currentTarget.selectionStart)}
          onPaste={(e) =>
            handleComposerPaste(e, {
              onImagePaste: attachments.onPaste,
              onLongText: attachments.addPastedText,
              value: prompt,
              onChange: (next, pos) => {
                caret.current = pos
                setPrompt(next)
                slash.track(next, pos)
              },
            })
          }
          {...mentions.aria}
          onKeyDown={(e) => {
            const open = mentions.list !== null || paletteOpen
            // Escape belongs to the open list, not to the dialog: dismissing a
            // completion must not also throw away the draft behind it.
            if (open && e.key === "Escape") e.stopPropagation()
            if (mentions.onKeyDown(e)) return
            if (paletteOpen && slash.onKeyDown(e)) return
            // a slash token with nothing to offer keeps Escape for the dialog
            // and Enter for the newline it always was
            if (slash.token && e.key === "Escape") slash.dismiss()
          }}
          placeholder="What do you want to work on?"
          className={cn(
            "scroll-slim min-h-[132px] w-full resize-none bg-transparent",
            "text-[13.5px] leading-[1.6] text-foreground placeholder:text-faint focus:outline-none",
          )}
        />
        {paletteOpen && (
          <div
            data-testid="slash-palette"
            className={cn("absolute inset-x-0 top-full z-(--z-menu) mt-1.5", POPOVER_SURFACE, "rounded-lg p-1")}
          >
            <SlashPaletteList
              groups={groups}
              query={slash.token?.query ?? ""}
              onPick={pick}
              commandRef={command}
              touch={touch}
            />
          </div>
        )}
        {mentions.list && (
          <div
            data-testid="mention-list"
            className={cn("absolute inset-x-0 top-full z-(--z-menu) mt-1.5", POPOVER_SURFACE, "rounded-lg p-1")}
          >
            <MentionListRows
              rows={mentions.list.rows}
              selected={mentions.list.selected}
              status={mentions.list.status}
              touch={touch}
              onPick={mentions.insert}
              onOpen={mentions.open}
              onHover={mentions.hover}
            />
          </div>
        )}
      </div>
      <PendingAttachmentRows
        pending={attachments}
        onInsertInline={(pasted) => {
          setPrompt((current) => insertPastedText(current, pasted))
          undoPastedFile(attachments, pasted.name)
        }}
      />
    </div>
  )
}
