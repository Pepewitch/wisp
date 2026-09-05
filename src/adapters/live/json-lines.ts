/**
 * Newline framing for live harness protocols.
 *
 * The cap exists so a harness that never emits a newline cannot grow the
 * pending buffer without bound. It is deliberately far above any legitimate
 * frame: a harness inlines a command's whole output in one notification, so a
 * single grep over a directory of minified bundles is megabytes of protocol on
 * one line. Overflow is recoverable — the frame is dropped and framing resyncs
 * at the next newline — because killing a long turn over one unreadable
 * notification loses all of its work.
 */
export const MAX_PROTOCOL_FRAME_CHARS = 16 * 1_048_576;

export interface JsonLineBufferOptions {
  /** Called once per dropped frame, with the character count that was discarded. */
  onDrop?: (chars: number) => void;
  maxFrameChars?: number;
}

/** Incremental newline framing that drops, rather than throws on, oversized frames. */
export class JsonLineBuffer {
  private pending = "";
  /** True while skipping the remainder of a frame that already overflowed. */
  private skipping = false;
  private skipped = 0;
  private readonly max: number;
  private readonly onDrop: (chars: number) => void;

  constructor(options: JsonLineBufferOptions = {}) {
    this.max = options.maxFrameChars ?? MAX_PROTOCOL_FRAME_CHARS;
    this.onDrop = options.onDrop ?? (() => {});
  }

  push(chunk: string): string[] {
    const lines: string[] = [];
    let rest = chunk;
    while (rest.length > 0) {
      const newline = rest.indexOf("\n");
      if (newline < 0) {
        if (this.skipping) this.skipped += rest.length;
        else {
          this.pending += rest;
          // Overflow is decided on the partial: the buffer never holds more
          // than one cap plus the chunk that crossed it.
          if (this.pending.length > this.max) this.beginSkip();
        }
        break;
      }
      const head = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      if (this.skipping) {
        this.skipped += head.length;
        this.endSkip();
        continue;
      }
      const line = this.pending + head;
      this.pending = "";
      if (line.length > this.max) this.onDrop(line.length);
      else lines.push(line);
    }
    return lines;
  }

  finish(chunk = ""): string[] {
    const lines = this.push(chunk);
    if (this.skipping) {
      this.endSkip();
      return lines;
    }
    if (this.pending) lines.push(this.pending);
    this.pending = "";
    return lines;
  }

  private beginSkip(): void {
    this.skipping = true;
    this.skipped = this.pending.length;
    this.pending = "";
  }

  private endSkip(): void {
    this.skipping = false;
    this.onDrop(this.skipped);
    this.skipped = 0;
  }
}
