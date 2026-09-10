/**
 * Content-free browser timings for remote task-switch diagnosis.
 *
 * Fixed mark names deliberately carry no connection, task, repository, or
 * terminal data. DevTools can inspect the latest measures; Wisp does not log
 * or transmit them.
 */
const SELECTED = "wisp:task-switch:selected"
const DETAIL = "wisp:task-switch:detail-loaded"
const PAINTED = "wisp:task-switch:conversation-painted"
const TO_DETAIL = "wisp:task-switch:selection-to-detail"
const TO_PAINT = "wisp:task-switch:selection-to-paint"

let generation = 0
let detailGeneration = -1
let paintGeneration = -1

function available(): boolean {
  return typeof performance !== "undefined" && typeof performance.mark === "function"
}

function hasSelectionMark(): boolean {
  return performance.getEntriesByName(SELECTED, "mark").length > 0
}

function replaceMark(name: string): void {
  performance.clearMarks(name)
  performance.mark(name)
}

function replaceMeasure(name: string, start: string, end: string): void {
  performance.clearMeasures(name)
  performance.measure(name, start, end)
}

export function markTaskSelected(): void {
  if (!available()) return
  generation++
  detailGeneration = -1
  paintGeneration = -1
  replaceMark(SELECTED)
}

export function markConversationDetailLoaded(): void {
  if (!available() || !hasSelectionMark() || detailGeneration === generation) return
  detailGeneration = generation
  replaceMark(DETAIL)
  replaceMeasure(TO_DETAIL, SELECTED, DETAIL)
}

/**
 * Schedule after React commits the conversation. requestAnimationFrame is the
 * closest content-free browser signal to the first paint of that commit.
 */
export function scheduleConversationPaint(): () => void {
  if (!available() || !hasSelectionMark() || typeof requestAnimationFrame !== "function") {
    return () => undefined
  }
  const scheduledGeneration = generation
  const frame = requestAnimationFrame(() => {
    if (
      scheduledGeneration !== generation ||
      paintGeneration === generation ||
      !hasSelectionMark()
    ) return
    paintGeneration = generation
    replaceMark(PAINTED)
    replaceMeasure(TO_PAINT, SELECTED, PAINTED)
  })
  return () => cancelAnimationFrame(frame)
}
