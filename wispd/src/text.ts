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

/**
 * Keep both ends of an over-long string and name what was removed. Preferred
 * over `trunc` when the tail carries meaning the head does not — a command's
 * exit banner or error is usually the last thing it printed.
 */
export function elideMiddle(s: string, n: number): string {
  if (s.length <= n) return s;
  const head = Math.ceil(n / 2);
  const tail = n - head;
  const removed = s.length - n;
  return `${s.slice(0, head)}\n… ${removed} characters elided …\n${s.slice(s.length - tail)}`;
}
