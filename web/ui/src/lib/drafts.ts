const drafts = new Map<string, string>()

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
}
