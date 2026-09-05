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
import { LOCAL_CONNECTION_ID } from "./transport";

export interface UiIntents {
  subscribe(fn: () => void): () => void;
  streamFocusRequests(): number;
  focusStream(): void;
}

function createUiIntents(): UiIntents {
  const listeners = new Set<() => void>();
  let streamFocusRequests = 0;
  return {
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
}

const stores = new Map<string, UiIntents>();

/** Cross-component intents never leak between daemon connection views. */
export function uiIntentsFor(connectionId: string): UiIntents {
  let intents = stores.get(connectionId);
  if (!intents) {
    intents = createUiIntents();
    stores.set(connectionId, intents);
  }
  return intents;
}

/** Compatibility for the current single-daemon web runtime. */
export const uiIntents = uiIntentsFor(LOCAL_CONNECTION_ID);
