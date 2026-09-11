/**
 * String-shortening and -formatting helpers, shared by the runner and the CLI
 * so the truncation logic isn't written twice (a prior audit).
 */

/**
 * "320 B" / "12 KB" / "1.2 MB" — the attach note's size wording.
 *
 * It lives here rather than in attachments.ts because the delivery preamble
 * needs it too, and adapters/ importing from attachments.ts would close a
 * cycle (attachments.ts already imports the adapter registry).
 */
export function formatBytes(n: number): string {
  const trimmed = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${trimmed(kb)} KB`;
  return `${trimmed(kb / 1024)} MB`;
}

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
