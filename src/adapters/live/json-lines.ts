export const MAX_PROTOCOL_FRAME_CHARS = 1_048_576;

/** Incremental newline framing with a hard cap on complete and partial frames. */
export class JsonLineBuffer {
  private pending = "";

  push(chunk: string): string[] {
    this.pending += chunk;
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    this.assertBounded([...lines, this.pending]);
    return lines;
  }

  finish(chunk = ""): string[] {
    const lines = this.push(chunk);
    if (this.pending) lines.push(this.pending);
    this.pending = "";
    return lines;
  }

  private assertBounded(lines: string[]): void {
    if (lines.some((line) => line.length > MAX_PROTOCOL_FRAME_CHARS)) {
      throw new Error(`live protocol frame exceeded ${MAX_PROTOCOL_FRAME_CHARS} characters`);
    }
  }
}
