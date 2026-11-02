import { appendFileSync, closeSync, openSync, readSync, statSync } from "node:fs";
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
 *   is copied within one poll of the read completing.
 *
 * Notes (`Image output: …`) are appended to the log once the harness has
 * exited, never while it writes. Output goes where every capture's does:
 * the turn's `outputs`, under the step that showed it.
 */

/** How often a running Cursor turn's log is read for new lines. */
export const LOG_POLL_MS = 150;
const READ_CHUNK = 256 * 1024;

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
  // the turn's own log: it may already hold lines the harness wrote before this started
  let offset = def.events === "cursor-stream-json" && since === "resumed" ? sizeOf(outPath) : 0;
  let partial = "";
  const readNew = (): void => {
    let fd: number;
    try {
      fd = openSync(outPath, "r");
    } catch {
      return;
    }
    try {
      const buffer = Buffer.alloc(READ_CHUNK);
      for (;;) {
        const read = readSync(fd, buffer, 0, READ_CHUNK, offset);
        if (read <= 0) break;
        offset += read;
        const lines = (partial + buffer.subarray(0, read).toString("utf8")).split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) captureLine(line);
      }
    } finally {
      closeSync(fd);
    }
  };
  const captureLine = (line: string): void => {
    if (!line.startsWith("{")) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (isRecord(event)) capture(event);
  };
  const timer = def.events === "cursor-stream-json" ? setInterval(readNew, LOG_POLL_MS) : null;
  timer?.unref?.();
  return {
    async finish() {
      if (timer) clearInterval(timer);
      readNew();
      if (partial) captureLine(partial);
      partial = "";
      if (notes.length > 0) {
        try {
          appendFileSync(outPath, notes.map((note) => `${note}\n`).join(""));
        } catch {
          // The images are stored either way; only their notes are missing.
        }
      }
    },
  };
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
