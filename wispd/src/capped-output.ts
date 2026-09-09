/** A bounded prefix plus a drain that can be closed without awaiting remote EOF. */
export class CappedOutput {
  readonly done: Promise<void>;
  ended = false;
  truncated = false;
  text = "";
  private bytes = 0;
  private closed = false;
  private readonly decoder = new TextDecoder();
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(stream: ReadableStream<Uint8Array>, private readonly maxBytes: number, private readonly onCap?: () => void) {
    this.reader = stream.getReader();
    this.done = this.drain();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.text += this.decoder.decode();
    // Cancellation closes our pipe. Its completion is not another deadline
    // dependency: a descendant (including one outside our group) may hold EOF.
    void this.reader.cancel().catch(() => {});
  }

  private async drain(): Promise<void> {
    try {
      while (!this.closed) {
        const { value, done } = await this.reader.read();
        if (this.closed || done) break;
        if (this.truncated) continue;
        const room = this.maxBytes - this.bytes;
        if (value.byteLength >= room) {
          this.text += this.decoder.decode(value.subarray(0, room));
          this.truncated = true;
          this.onCap?.();
        } else {
          this.bytes += value.byteLength;
          this.text += this.decoder.decode(value, { stream: true });
        }
        // Both streams keep draining beyond their cap. Only stdout asks the
        // supervisor to stop; chatty stderr must not fail a successful command.
      }
    } catch { /* Keep the prefix if terminating the command closes its pipe. */ }
    finally {
      if (!this.closed) this.text += this.decoder.decode();
      this.ended = true;
      this.closed = true;
      this.reader.releaseLock();
    }
  }
}
