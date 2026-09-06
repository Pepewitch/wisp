const drafts = new Map<string, string>()
const pendingAttachments = new Map<string, number>()

function key(connectionId: string, taskId: string | null): string {
  return `${connectionId}\u0000${taskId ?? ""}`
}

/** Drafts survive a connection view unmount but never leave webview memory. */
export function readDraft(connectionId: string, taskId: string | null): string {
  return drafts.get(key(connectionId, taskId)) ?? ""
}

export function writeDraft(
  connectionId: string,
  taskId: string | null,
  value: string
): void {
  const draftKey = key(connectionId, taskId)
  if (value) drafts.set(draftKey, value)
  else drafts.delete(draftKey)
}

export function clearConnectionDrafts(connectionId: string): void {
  const prefix = `${connectionId}\u0000`
  for (const draftKey of drafts.keys()) {
    if (draftKey.startsWith(prefix)) drafts.delete(draftKey)
  }
  pendingAttachments.delete(connectionId)
}

/** Only a count is shared; attachment bytes stay inside the mounted composer. */
export function writePendingAttachmentCount(
  connectionId: string,
  taskId: string | null,
  count: number
): void {
  const attachmentKey = key(connectionId, taskId)
  if (count > 0) pendingAttachments.set(attachmentKey, count)
  else pendingAttachments.delete(attachmentKey)
}

export function connectionLocalData(connectionId: string): {
  drafts: number
  pendingAttachments: number
} {
  const prefix = `${connectionId}\u0000`
  let draftCount = 0
  for (const [draftKey, value] of drafts) {
    if (value && draftKey.startsWith(prefix)) draftCount += 1
  }
  return {
    drafts: draftCount,
    pendingAttachments: [...pendingAttachments].reduce(
      (count, [attachmentKey, value]) =>
        attachmentKey.startsWith(prefix) ? count + value : count,
      0
    ),
  }
}
