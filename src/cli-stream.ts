import { wispCommand } from "./command";
import { loadConfig } from "./config";
import { readSseFrames } from "./sse";

async function apiStream(path: string): Promise<Response> {
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

/** Follow the daemon's human SSE projection, including post-capture live activity. */
export async function followHumanLog(taskId: string | undefined, turnQuery: string): Promise<void> {
  const res = await apiStream(`/api/tasks/${taskId}/log/stream?${turnQuery}format=human`);
  if (!res.body) throw new Error("log stream returned no body");
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
}
