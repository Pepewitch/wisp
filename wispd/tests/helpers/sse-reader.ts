import { readSseFrames, type SseFrame } from "../../src/sse";

const TIMEOUT = Symbol("SSE test read timeout");

/**
 * Timeout-aware test wrapper around the production frame parser. A timed-out
 * read stays pending so it cannot consume the next frame invisibly.
 */
export function testSseReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const frames = readSseFrames(reader);
  let pending: Promise<IteratorResult<SseFrame>> | null = null;
  let daemonVersion: string | null = null;

  return {
    daemonVersion: () => daemonVersion,
    async nextFrame(timeoutMs = 5_000): Promise<SseFrame> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("timed out waiting for an SSE frame");
        pending ??= frames.next();
        const result = await Promise.race([
          pending,
          Bun.sleep(remaining).then(() => TIMEOUT),
        ]);
        if (result === TIMEOUT) continue;
        pending = null;
        if (result.done) throw new Error("SSE stream ended before the next frame");
        if (result.value.event === "hello") {
          const hello = JSON.parse(result.value.data) as { version?: unknown };
          if (typeof hello.version !== "string" || hello.version.length === 0) {
            throw new Error(`invalid log stream hello frame: ${result.value.data}`);
          }
          daemonVersion = hello.version;
          continue;
        }
        return result.value;
      }
    },
  };
}
