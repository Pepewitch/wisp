/**
 * String-shortening helpers, shared by the runner and the CLI so the
 * truncation logic isn't written twice (a prior audit).
 */

/** Truncate to `n` chars, appending an ellipsis when cut. */
export function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** One-line preview: collapse newlines, then truncate. */
export function summarize(s: string, n = 200): string {
  return trunc(s.trim().replaceAll("\n", " "), n);
}
