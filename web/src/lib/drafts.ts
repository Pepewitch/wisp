const drafts = new Map<string, string>()
const pendingAttachments = new Map<string, number>()
const createTaskDrafts = new Map<string, CreateTaskDraft>()
const createTaskProjects = new Map<string, string>()

/** The create composer is scoped by project as well as daemon, never by task. */
export function createTaskScope(repoPath: string): string {
  return `create:${repoPath}`
}

export interface CreateTaskDraft {
  prompt: string
  choice: { harness: string; model: string } | null
  effort: string
  fast: boolean
  mode: "worktree" | "local"
  base: string
  suffixPromptId: string | null
  autopilot: { autoMerge: boolean; autoFix: boolean }
}

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
  createTaskProjects.delete(connectionId)
  for (const draftKey of drafts.keys()) {
    if (draftKey.startsWith(prefix)) drafts.delete(draftKey)
  }
  for (const draftKey of createTaskDrafts.keys()) {
    if (draftKey.startsWith(prefix)) createTaskDrafts.delete(draftKey)
  }
  for (const attachmentKey of pendingAttachments.keys()) {
    if (attachmentKey.startsWith(prefix))
      pendingAttachments.delete(attachmentKey)
  }
}

export function readCreateTaskProject(connectionId: string): string | undefined {
  return createTaskProjects.get(connectionId)
}

export function writeCreateTaskProject(connectionId: string, repoPath: string): void {
  createTaskProjects.set(connectionId, repoPath)
}

export function readCreateTaskDraft(connectionId: string, repoPath: string): CreateTaskDraft | undefined {
  return createTaskDrafts.get(key(connectionId, createTaskScope(repoPath)))
}

export function writeCreateTaskDraft(connectionId: string, repoPath: string, draft: CreateTaskDraft): void {
  createTaskDrafts.set(key(connectionId, createTaskScope(repoPath)), draft)
}

export function clearCreateTaskDraft(connectionId: string, repoPath: string): void {
  const draftKey = key(connectionId, createTaskScope(repoPath))
  createTaskDrafts.delete(draftKey)
  pendingAttachments.delete(draftKey)
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
  for (const [draftKey, value] of createTaskDrafts) {
    if (value.prompt && draftKey.startsWith(prefix)) draftCount += 1
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
