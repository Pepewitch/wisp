/**
 * The daemon's copy of what each shell's screen LOOKS like.
 *
 * A shell outlives the socket watching it, so a reattaching tab has to be told
 * what it missed. Sending the raw bytes back — which is what this replaced —
 * cannot be made correct: those bytes contain cursor movements ("up one line,
 * erase down") that are only true at the width they were produced at. Replay
 * them into a pane of a different width and every one of them lands on the
 * wrong row. On a prompt that draws a full-width rule, each mismatched redraw
 * leaves the previous rule behind, which is the stack of dashed lines a task
 * switch used to paint.
 *
 * So the daemon parses the stream instead of hoarding it, using the SAME
 * terminal engine the browser renders with. The model is resized together with
 * the pty, and an attaching client is handed a serialized snapshot of the
 * current screen rather than a history of how it got there. Two consequences
 * worth stating: the client writes a picture, so it can never desynchronize
 * from the daemon; and memory is bounded by screen size instead of by a byte
 * cap, however long the session runs.
 *
 * `@xterm/addon-serialize` round-trips the things that actually matter for a
 * live shell — the alternate screen (so reattaching mid-vim works), bracketed
 * paste and application cursor modes, the cursor position, and a bounded
 * scrollback. Those are covered in tests/terminal-screen.test.ts.
 */
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";

import type { PtySize } from "./pty";

/**
 * Scrollback lines kept per shell. This is what a reattaching tab can scroll
 * back through, and the daemon may hold MAX_SHELLS of them at once, so it is
 * a memory budget as much as a feature: ~4 bytes per cell means a 200-column
 * shell costs on the order of a megabyte here.
 */
export const SCROLLBACK_LINES = 1000;

export class TerminalScreen {
  private readonly term: Terminal;
  private readonly serializer: SerializeAddon;
  /** resolves when everything written so far has been parsed */
  private pending: Promise<void> = Promise.resolve();

  constructor(size: PtySize) {
    this.term = new Terminal({
      cols: size.cols,
      rows: size.rows,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
  }

  /**
   * Feed the shell's output in. xterm parses asynchronously, so the callback
   * is chained rather than awaited by the caller: output must never wait on
   * the model to reach the browser.
   */
  write(data: string): void {
    // The write is issued immediately — output must never wait on the model to
    // reach the browser — but `pending` is CHAINED rather than replaced, so it
    // resolves only once every earlier write has been parsed too. Assigning
    // the newest promise instead would leave a snapshot correct only while
    // xterm happens to run its callbacks in order.
    const parsed = new Promise<void>((resolve) => this.term.write(data, resolve));
    this.pending = this.pending.then(() => parsed);
  }

  resize(size: PtySize): void {
    if (size.cols === this.term.cols && size.rows === this.term.rows) return;
    this.term.resize(size.cols, size.rows);
  }

  get size(): PtySize {
    return { cols: this.term.cols, rows: this.term.rows };
  }

  /**
   * What a fresh xterm must write to show this shell as it stands. Awaits the
   * parser first, so a snapshot taken right after a burst of output is not
   * missing its tail.
   */
  async snapshot(): Promise<string> {
    await this.pending;
    return this.serializer.serialize({ scrollback: SCROLLBACK_LINES });
  }

  dispose(): void {
    this.serializer.dispose();
    this.term.dispose();
  }
}
