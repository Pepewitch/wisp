/**
 * Tasks whose PR Wisp is merging at this moment. In memory on purpose: it
 * guards the few seconds of a `gh pr merge` against a new turn starting (and
 * pushing onto a branch that is about to be merged), and a crash ends the
 * merge attempt it was guarding anyway.
 */
const merging = new Set<string>()

export function isTaskMerging(taskId: string): boolean {
  return merging.has(taskId)
}

export async function whileMerging<T>(taskId: string, work: () => Promise<T>, release: () => void): Promise<T> {
  merging.add(taskId)
  try {
    return await work()
  } finally {
    merging.delete(taskId)
    // The queue only drains on submit, turn end, or boot; a message that
    // arrived during the merge would otherwise wait for something unrelated.
    release()
  }
}
