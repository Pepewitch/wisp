/**
 * Diagrams already drawn, by theme and source. A transcript remounts its
 * fences on every task switch and every page of history, and each one used to
 * parse and lay out its diagram again; the same source in the same theme
 * draws the same SVG. Small, because an SVG can be large, and least recently
 * used first out. Failures are not kept: a retry must really retry.
 */
const MAX_REMEMBERED_DIAGRAMS = 32
const DRAWN = new Map<string, string>()

function drawnKey(theme: string, code: string): string {
  return `${theme}\u0000${code}`
}

export function recallDiagram(theme: string, code: string): string | undefined {
  const key = drawnKey(theme, code)
  const svg = DRAWN.get(key)
  if (svg !== undefined) {
    DRAWN.delete(key)
    DRAWN.set(key, svg)
  }
  return svg
}

export function rememberDiagram(theme: string, code: string, svg: string): void {
  const key = drawnKey(theme, code)
  DRAWN.delete(key)
  DRAWN.set(key, svg)
  if (DRAWN.size > MAX_REMEMBERED_DIAGRAMS) DRAWN.delete(DRAWN.keys().next().value!)
}

/** Tests only: start from nothing drawn. */
export function forgetDiagrams(): void {
  DRAWN.clear()
}
