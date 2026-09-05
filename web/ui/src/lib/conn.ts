/**
 * The topbar's connection pill: "live" only while BOTH SSE streams (the global
 * /api/events bridge and the selected task's log stream) are healthy — the
 * classic UI's eventsErr || logErr rule. A tiny external store, because the
 * two streams live in different components and the pill lives above both.
 */
type Stream = "events" | "log";

let state: Record<Stream, boolean> = { events: true, log: true };
const listeners = new Set<() => void>();

export const connStore = {
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
