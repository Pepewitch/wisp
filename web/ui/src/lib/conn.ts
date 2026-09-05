/**
 * The topbar's connection pill: "live" only while BOTH SSE streams (the global
 * /api/events bridge and the selected task's log stream) are healthy — the
 * classic UI's eventsErr || logErr rule. A tiny external store, because the
 * two streams live in different components and the pill lives above both.
 */
import { LOCAL_CONNECTION_ID } from "./transport";

type Stream = "events" | "log";

export interface ConnectionStore {
  subscribe(fn: () => void): () => void;
  isLive(): boolean;
  set(stream: Stream, live: boolean): void;
}

function createConnectionStore(): ConnectionStore {
  let state: Record<Stream, boolean> = { events: true, log: true };
  const listeners = new Set<() => void>();
  return {
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    /** useSyncExternalStore snapshot — a primitive, so identity churn is a non-issue */
    isLive(): boolean {
      return state.events && state.log;
    },
    set(stream: Stream, live: boolean): void {
      if (state[stream] === live) return;
      state = { ...state, [stream]: live };
      for (const fn of listeners) fn();
    },
  };
}

const stores = new Map<string, ConnectionStore>();

/** One health record per immutable daemon connection. */
export function connectionStore(connectionId: string): ConnectionStore {
  let store = stores.get(connectionId);
  if (!store) {
    store = createConnectionStore();
    stores.set(connectionId, store);
  }
  return store;
}

/** Compatibility for the current single-daemon web runtime. */
export const connStore = connectionStore(LOCAL_CONNECTION_ID);
