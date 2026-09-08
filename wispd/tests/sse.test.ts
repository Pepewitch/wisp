import { describe, expect, test } from "bun:test";
import { readSseFrames } from "../src/sse";

describe("SSE frame reader", () => {
  test("decodes split frames, multiline data and heartbeats", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      "event: back",
      "log\r\ndata: first\r\ndata: second\r\n\r\n: h",
      "b\n\nevent: turn-end\ndata: {\"turn\":1}\n\n",
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });

    const frames = [];
    for await (const frame of readSseFrames(stream)) frames.push(frame);
    expect(frames).toEqual([
      { event: "backlog", data: "first\nsecond" },
      { event: "turn-end", data: '{"turn":1}' },
    ]);
  });
});
