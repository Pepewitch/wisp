/**
 * The reader draining each harness pipe. A process the harness started can
 * inherit its stdout or stderr and hold that pipe open long after the harness
 * itself exited, and a locked stream can only be ended through its reader.
 */
const readers = new WeakMap<object, ReadableStreamDefaultReader<Uint8Array>>();

/** Lock a harness pipe for draining, keeping the reader where `settlePipes` can end it. */
export function pipeReader(stream: ReadableStream<Uint8Array>): ReadableStreamDefaultReader<Uint8Array> {
  const reader = stream.getReader();
  readers.set(stream, reader);
  return reader;
}

/**
 * Wait for a harness's pipe pumps once the harness has exited. Everything it
 * wrote is already in the pipe, so the pumps normally reach EOF at once; a
 * process it left behind that still holds a pipe keeps EOF away for as long
 * as that process lives. After `graceMs` the reads are cancelled, which ends
 * each pump as if at EOF, so the turn settles on what the harness wrote.
 *
 * Resolves true when a pipe was still held open and had to be cut.
 */
export async function settlePipes(
  streams: readonly unknown[],
  pumps: readonly Promise<unknown>[],
  graceMs: number,
): Promise<boolean> {
  const settled = Promise.allSettled(pumps).then(() => true);
  if (await within(settled, graceMs)) return false;
  for (const stream of streams) {
    const reader = stream && typeof stream === "object" ? readers.get(stream) : undefined;
    // A pump that already finished released its reader; cancelling it then rejects.
    void reader?.cancel().catch(() => {});
  }
  await within(settled, graceMs);
  return true;
}

async function within(work: Promise<boolean>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}
