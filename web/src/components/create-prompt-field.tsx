import type { Dispatch, RefObject, SetStateAction } from "react"

import { PendingAttachmentRows } from "@/components/pending-attachments"
import {
  insertPastedText,
  undoPastedFile,
  useComposerDrop,
  type PendingAttachments,
} from "@/lib/attachments"
import { handleComposerPaste } from "@/lib/paste-links"
import { cn } from "@/lib/utils"

/**
 * The create dialog's prompt textarea and its pending attachments.
 *
 * Its own file because paste is three behaviours in one handler now — files, a
 * long paste that becomes a text file (A1d), and Slack-style HTML links — and
 * the dialog it sits in is the longest component in this app.
 */
export function PromptField({
  box,
  prompt,
  setPrompt,
  attachments,
}: {
  box: RefObject<HTMLTextAreaElement | null>
  prompt: string
  setPrompt: Dispatch<SetStateAction<string>>
  attachments: PendingAttachments
}) {
  // The prompt field is the drop zone: it fills the modal, so the whole
  // "drop the file on the dialog" gesture lands here, in the same addFiles
  // path a paste and a pick use.
  const { dragging, dropHandlers } = useComposerDrop({
    onFiles: (files) => attachments.addFiles(files),
  })
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
      <textarea
        ref={box}
        rows={6}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onPaste={(e) =>
          handleComposerPaste(e, {
            onImagePaste: attachments.onPaste,
            onLongText: attachments.addPastedText,
            value: prompt,
            onChange: (next) => setPrompt(next),
          })
        }
        placeholder="What do you want to work on?"
        className={cn(
          "scroll-slim min-h-[132px] w-full resize-none bg-transparent",
          "text-[13.5px] leading-[1.6] text-foreground placeholder:text-faint focus:outline-none",
        )}
      />
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
