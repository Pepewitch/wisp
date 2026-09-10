import { wispCommand } from "./command";
import { loadConfig } from "./config";
import { readSseFrames } from "./sse";

export async function apiStream(path: string): Promise<Response> {
  const cfg = loadConfig();
  const command = wispCommand();
  const url = `http://${cfg.host}:${cfg.port}${path}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${cfg.token}` } });
  } catch {
    console.error(`cannot reach wispd at ${url} — is it running? start it with: ${command} serve`);
    process.exit(1);
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    console.error(`error: ${data.error ?? res.statusText}`);
    process.exit(1);
  }
  return res;
}

/** Export the diagnostic archive verbatim so timestamps, sources, and sequence numbers survive. */
export async function exportDiagnosticLog(taskId: string | undefined, turnQuery: string, following: boolean): Promise<void> {
  if (following) {
    console.error("--diagnostic exports a retained snapshot and cannot be combined with --follow");
    process.exit(1);
  }
  const res = await apiStream(`/api/tasks/${taskId}/log/diagnostic?${turnQuery}`);
  const state = res.headers.get("x-wisp-diagnostic-state");
  const detail = res.headers.get("x-wisp-diagnostic-detail");
  if (state === "partial") {
    const decoded = detail ? decodeURIComponent(detail) : "only part of this turn was retained";
    console.error(`warning: diagnostic history is partial — ${decoded}`);
  }
  if (!res.body) throw new Error("diagnostic export returned no body");
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      if (!process.stdout.write(value)) {
        await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Follow the daemon's human SSE projection, including post-capture live activity. */
export async function followHumanLog(taskId: string | undefined, turnQuery: string): Promise<void> {
  const res = await apiStream(`/api/tasks/${taskId}/log/stream?${turnQuery}format=human`);
  if (!res.body) throw new Error("log stream returned no body");
  try {
    for await (const frame of readSseFrames(res.body)) {
      if (frame.event === "backlog" || frame.event === "append") {
        const data = JSON.parse(frame.data) as { text?: string };
        if (data.text) console.log(data.text);
      } else if (frame.event === "turn-end") {
        const data = JSON.parse(frame.data) as { turn: number; status: string };
        console.log(`— turn ${data.turn} ${data.status} —`);
        return;
      }
    }
  } finally { await res.body.cancel(); }
}
