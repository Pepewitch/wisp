import { print, printError } from "./cli-print";
import { wispCommand } from "./command";
import { loadConfig } from "./config";
import { controlFree } from "./control-free";
import { readSseFrames } from "./sse";

export async function apiStream(path: string): Promise<Response> {
  const cfg = loadConfig();
  const command = wispCommand();
  const url = `http://${cfg.host}:${cfg.port}${path}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${cfg.token}` } });
  } catch {
    printError(`cannot reach wispd at ${url} — is it running? start it with: ${command} serve`);
    process.exit(1);
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    printError(`error: ${data.error ?? res.statusText}`);
    process.exit(1);
  }
  return res;
}

/**
 * Export the diagnostic archive verbatim so timestamps, sources, and sequence
 * numbers survive. Verbatim is for a file or a pipe: on a terminal the
 * harness's own bytes inside it are shown without control sequences.
 */
export async function exportDiagnosticLog(taskId: string | undefined, turnQuery: string, following: boolean): Promise<void> {
  if (following) {
    printError("--diagnostic exports a retained snapshot and cannot be combined with --follow");
    process.exit(1);
  }
  const res = await apiStream(`/api/tasks/${taskId}/log/diagnostic?${turnQuery}`);
  const state = res.headers.get("x-wisp-diagnostic-state");
  const detail = res.headers.get("x-wisp-diagnostic-detail");
  if (state === "partial") {
    const decoded = detail ? decodeURIComponent(detail) : "only part of this turn was retained";
    printError(`warning: diagnostic history is partial — ${decoded}`);
  }
  if (!res.body) throw new Error("diagnostic export returned no body");
  const terminal = process.stdout.isTTY ? terminalText() : null;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        const tail = terminal?.(undefined);
        if (tail) await write(tail);
        return;
      }
      await write(terminal ? terminal(value) : value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function write(chunk: string | Uint8Array): Promise<void> {
  if (!process.stdout.write(chunk)) {
    await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
  }
}

/**
 * Chunks of a byte stream as terminal-safe text; `undefined` flushes the end.
 * A character split across chunks waits in the decoder for its last byte, and
 * a trailing `\r` waits for the next chunk, so a CRLF split in two is still
 * one line break.
 */
export function terminalText(): (bytes: Uint8Array | undefined) => string {
  const decoder = new TextDecoder();
  let held = "";
  return (bytes) => {
    let text = held + (bytes ? decoder.decode(bytes, { stream: true }) : decoder.decode());
    held = "";
    if (bytes && text.endsWith("\r")) {
      held = "\r";
      text = text.slice(0, -1);
    }
    return controlFree(text);
  };
}

/** Follow the daemon's human SSE projection, including post-capture live activity. */
export async function followHumanLog(taskId: string | undefined, turnQuery: string): Promise<void> {
  const res = await apiStream(`/api/tasks/${taskId}/log/stream?${turnQuery}format=human`);
  if (!res.body) throw new Error("log stream returned no body");
  try {
    for await (const frame of readSseFrames(res.body)) {
      if (frame.event === "backlog" || frame.event === "append") {
        const data = JSON.parse(frame.data) as { text?: string };
        if (data.text) print(data.text);
      } else if (frame.event === "turn-end") {
        const data = JSON.parse(frame.data) as { turn: number; status: string };
        print(`— turn ${data.turn} ${data.status} —`);
        return;
      }
    }
  } finally { await res.body.cancel(); }
}
