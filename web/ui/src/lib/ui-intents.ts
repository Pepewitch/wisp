/**
 * Cross-component UI intents for the `/` palette (A2): the steer box issues,
 * the conversation answers. The same tiny-store pattern as lib/conn.ts — a
 * monotonic counter as the snapshot, consumers react in an effect. Never state
 * that matters: a missed intent is a shrug, not a bug.
 *
 * ONE intent, because the palette has one command that needs another component
 * to move. `/diff`'s intent was deleted with the command (lib/slash.ts): the
 * Changes pane is always visible, so there was nothing to switch to.
 */
const listeners = new Set<() => void>();

let streamFocusRequests = 0;

export const uiIntents = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  /** `/log` — the conversation re-pins to the live tail */
  streamFocusRequests(): number {
    return streamFocusRequests;
  },
  focusStream(): void {
    streamFocusRequests += 1;
    for (const fn of listeners) fn();
  },
};
