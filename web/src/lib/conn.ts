/** Stream health shared by the active view and inactive connection monitors. */
import { LOCAL_CONNECTION_ID } from "./transport";

type Stream = "events" | "log";
export type ConnectionStreamStatus = "live" | "opening" | "failed";
export interface ConnectionStreamSnapshot {
  readonly status: ConnectionStreamStatus;
  readonly generation: number;
}

export interface ConnectionStore {
  subscribe(fn: () => void): () => void;
  isLive(): boolean;
  status(): ConnectionStreamStatus;
  snapshot(): ConnectionStreamSnapshot;
  opening(stream: Stream): void;
  set(stream: Stream, live: boolean): void;
}

function createConnectionStore(): ConnectionStore {
  let state: Record<Stream, ConnectionStreamStatus> = { events: "live", log: "live" };
  let snapshot: ConnectionStreamSnapshot = { status: "live", generation: 0 };
  const listeners = new Set<() => void>();
  const update = (stream: Stream, value: ConnectionStreamStatus): void => {
    if (state[stream] === value) return;
    state = { ...state, [stream]: value };
    snapshot = {
      status: state.events === "failed" || state.log === "failed"
        ? "failed"
        : state.events === "opening" || state.log === "opening"
          ? "opening"
          : "live",
      generation: snapshot.generation + 1,
    };
    for (const fn of listeners) fn();
  };
  return {
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    /** useSyncExternalStore snapshot — a primitive, so identity churn is a non-issue */
    isLive(): boolean {
      return snapshot.status === "live";
    },
    status(): ConnectionStreamStatus {
      return snapshot.status;
    },
    snapshot(): ConnectionStreamSnapshot {
      return snapshot;
    },
    opening(stream: Stream): void {
      // A routine view handoff must not hide an actual stream failure.
      if (state[stream] !== "failed") update(stream, "opening");
    },
    set(stream: Stream, live: boolean): void {
      update(stream, live ? "live" : "failed");
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
