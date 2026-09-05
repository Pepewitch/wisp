/**
 * The daemon's in-memory event bus: one synchronous fan-out from the store's
 * choke points (transition / createTurn / finishTurn) to the SSE streams in
 * the HTTP layer (GET /api/events, GET /api/tasks/:id/log/stream). In-memory
 * on purpose — events are a realtime convenience, not a ledger (the db and
 * the outbox are); a restarted daemon simply starts silent.
 *
 * Import direction is strictly one-way: store.ts imports THIS module, never
 * the reverse — so no import cycle can form.
 */
export type WispEvent =
  | {
      type: "task";
      taskId: string;
      state: string;
      stateDetail: string | null;
      seq: number;
      /** Present for a metadata-only rename so clients can patch without refetching task data. */
      title?: string;
      updatedAt?: string;
    }
  | { type: "turn"; taskId: string; n: number; status: string }
  | { type: "message"; taskId: string; messageId: string }
  | { type: "project"; action: "add" | "remove"; path: string };

export type WispEventListener = (evt: WispEvent) => void;

const listeners = new Set<WispEventListener>();

/** Subscribe to every emitted event; returns the unsubscribe function. */
export function subscribe(fn: WispEventListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Synchronous fan-out. A throwing listener is LOUD (stderr) but never breaks
 * the emitter — a broken SSE stream must not be able to take a store
 * transition down with it.
 */
export function emit(evt: WispEvent): void {
  for (const fn of listeners) {
    try {
      fn(evt);
    } catch (e) {
      console.error(`[wisp] event subscriber threw: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    }
  }
}
