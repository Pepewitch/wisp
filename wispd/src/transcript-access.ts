/** Short-lived readers keep retention from removing a transcript mid-response. */
const readers = new Map<number, number>();
export function acquireTranscriptRead(turnId: number): () => void {
  readers.set(turnId, (readers.get(turnId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (readers.get(turnId) ?? 1) - 1;
    if (count) readers.set(turnId, count); else readers.delete(turnId);
  };
}
export function transcriptReadActive(turnId: number): boolean { return readers.has(turnId); }

export const TRANSCRIPT_EVICTED_NOTICE = "Transcript evicted by archived-task log retention. Indexed agent prose and the final result remain available.";
