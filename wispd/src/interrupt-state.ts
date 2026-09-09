/** Persisted interrupt_detail markers: keep pending/refused stops out of admission. */
export const STOPPING = "Stopping turn — waiting for its processes to exit";
export const STOP_FAILED = "Could not fully stop turn";
export const INTERRUPTED = "turn interrupted — session kept, send a correction";

export function isUnresolvedInterrupt(detail: string | null | undefined): boolean {
  return Boolean(detail?.startsWith(STOPPING) || detail?.startsWith(STOP_FAILED));
}
