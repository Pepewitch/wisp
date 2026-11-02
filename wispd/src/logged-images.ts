import { appendFileSync, closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import type { AdapterDef } from "./adapters";
import { createOutputImageCapture } from "./adapters/output-images";
import { isRecord } from "./validate";

/**
 * Native image capture for the harnesses that write their output straight to
 * the turn's log (Cursor, OpenCode): no daemon pipe sits between them and the
 * file, which is what lets their turns outlive a daemon restart, so their
 * events are read from the log itself.
 *
 * - OpenCode puts the bytes a tool showed the model in the event (a `read`
 *   result's `data:` attachment), so reading them once the turn has ended
 *   still captures exactly what the step saw.
 * - Cursor reports only the path its `readToolCall` read. That file can change
 *   after the read, so the log is followed WHILE the turn runs and each path
 *   is copied within one poll of the read completing; a file written after
 *   the read finished is refused rather than shown as what the step saw.
 *
 * Reading is bounded: a poll reads at most POLL_BYTES, and a line longer
 * than MAX_LINE_BYTES (no image event is) is skipped, so a huge or
 * newline-free log never holds the event loop. Notes (`Image output: …`)
 * are appended once the harness has exited, never while it writes.
 */

/** How often a running Cursor turn's log is read for new lines. */
export const LOG_POLL_MS = 150;
/** The most a poll reads; the next poll goes on from there. */
const POLL_BYTES = 1024 * 1024;
const READ_CHUNK = 256 * 1024;
/** Longer lines are skipped: an OpenCode image attachment is at most ~11 MB of base64. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;

export interface LoggedImageCapture {
  /** The harness has exited: read the rest, append the notes. */
  finish(): Promise<void>;
}

export function startLoggedImageCapture(
  def: AdapterDef,
  turnId: number,
  outPath: string,
  /**
   * `resumed`: a turn this daemon did not start (re-adopted after a restart).
   * Cursor's earlier reads can no longer be copied as they were, so only the
   * ones from now on are; OpenCode's bytes are in its events, so all are.
   * `ended`: its harness is already gone, so only OpenCode's can be.
   */
  since: "spawn" | "resumed" | "ended" = "spawn",
): LoggedImageCapture | null {
  if (def.liveInput) return null;
  if (def.events === "cursor-stream-json" && since === "ended") return null;
  if (def.events !== "cursor-stream-json" && def.events !== "opencode-json") return null;
  const notes: string[] = [];
  const capture = createOutputImageCapture(def, turnId, (note) => notes.push(note));
  const log = new LogLines(outPath, def.events === "cursor-stream-json" && since === "resumed", (line) => {
    if (!line.startsWith("{")) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (isRecord(event)) capture(event);
  });
  const timer = def.events === "cursor-stream-json" ? setInterval(() => log.read(POLL_BYTES), LOG_POLL_MS) : null;
  timer?.unref?.();
  return {
    async finish() {
      if (timer) clearInterval(timer);
      // the rest as it stands now (a process left behind may still append), a bounded slice at a time
      const end = log.size();
      while (log.read(POLL_BYTES, end)) await Bun.sleep(0);
      log.end();
      if (notes.length === 0) return;
      try {
        // never glued onto a last line the harness left without its newline
        appendFileSync(outPath, `${log.endsMidLine() ? "\n" : ""}${notes.map((note) => `${note}\n`).join("")}`);
      } catch {
        // The images are stored either way; only their notes are missing.
      }
    },
  };
}

/** Complete lines of a growing file, read from where the last read stopped; a truncated or replaced file starts over. */
class LogLines {
  private offset = 0;
  private inode: number | null = null;
  private decoder = new TextDecoder();
  private partial = "";
  /** The current line went past MAX_LINE_BYTES: skip to its end. */
  private skipping = false;
  private lastByte: number | null = null;

  constructor(private readonly path: string, fromEnd: boolean, private readonly line: (text: string) => void) {
    if (!fromEnd) return;
    try {
      const info = statSync(path);
      this.offset = info.size;
      this.inode = info.ino;
    } catch {
      // not there yet: from its start
    }
  }

  /** The file's size now, or the offset when it cannot be read. */
  size(): number {
    try {
      return statSync(this.path).size;
    } catch {
      return this.offset;
    }
  }

  /** Read up to `budget` new bytes, never past `end`. True when it stopped at the budget, with more to read. */
  read(budget: number, end = Infinity): boolean {
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return false;
    }
    try {
      const info = fstatSync(fd);
      if ((this.inode !== null && info.ino !== this.inode) || info.size < this.offset) this.restart();
      this.inode = info.ino;
      const buffer = Buffer.alloc(READ_CHUNK);
      let left = Math.min(budget, end - this.offset);
      while (left > 0) {
        const read = readSync(fd, buffer, 0, Math.min(READ_CHUNK, left), this.offset);
        if (read <= 0) return false;
        this.offset += read;
        left -= read;
        this.lastByte = buffer[read - 1]!;
        this.take(this.decoder.decode(buffer.subarray(0, read), { stream: true }));
      }
      return this.offset < end;
    } finally {
      closeSync(fd);
    }
  }

  /** The harness is done: its last line, even without a newline. */
  end(): void {
    this.take(this.decoder.decode());
    if (this.partial && !this.skipping) this.line(this.partial);
    this.partial = "";
  }

  endsMidLine(): boolean {
    return this.lastByte !== null && this.lastByte !== 0x0a;
  }

  private take(text: string): void {
    if (!text.includes("\n")) {
      // the middle of one long line: no re-splitting what is already held
      if (!this.skipping) this.partial += text;
      if (this.partial.length > MAX_LINE_BYTES) {
        this.partial = "";
        this.skipping = true;
      }
      return;
    }
    const lines = (this.partial + text).split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) {
      if (this.skipping) this.skipping = false;
      else this.line(line);
    }
    if (this.partial.length > MAX_LINE_BYTES) {
      this.partial = "";
      this.skipping = true;
    }
  }

  private restart(): void {
    this.offset = 0;
    this.decoder = new TextDecoder();
    this.partial = "";
    this.skipping = false;
    this.lastByte = null;
  }
}
