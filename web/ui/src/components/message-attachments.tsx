import { AttachmentGallery } from "@/components/turn-attachments"
import { messageAttachmentUrl } from "@/lib/attachments"
import type { TurnAttachment } from "@/lib/types"

export function MessageAttachments({
  taskId,
  messageId,
  attachments,
  archived,
  cancelled,
}: {
  taskId: string
  messageId: string
  attachments: TurnAttachment[]
  archived: boolean
  cancelled?: boolean
}) {
  return (
    <AttachmentGallery
      attachments={attachments}
      archived={archived}
      removedReason={cancelled ? "removed when this message was cancelled" : undefined}
      urlFor={(name) => messageAttachmentUrl(taskId, messageId, name)}
    />
  )
}
