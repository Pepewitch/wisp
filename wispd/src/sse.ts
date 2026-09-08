export interface SseFrame {
  event: string | null;
  data: string;
}

/** Incrementally decode SSE frames across arbitrary network chunk boundaries. */
export async function* readSseFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      pending = pending.replaceAll("\r\n", "\n");
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const raw = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        if (!raw || raw.startsWith(":")) continue;
        let event: string | null = null;
        const data: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trimStart();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        yield { event, data: data.join("\n") };
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}
