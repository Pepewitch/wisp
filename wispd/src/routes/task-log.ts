import { readSlice, readTailOf } from "../fsutil";
import { turnForTask } from "../store";
import { acquireTranscriptRead, TRANSCRIPT_EVICTED_NOTICE } from "../transcript-access";
import type { Task } from "../types";
import { err, integerQueryParam, json } from "./http";

const LOG_TAIL_BYTES = 16_384;

export async function taskLogResponse(task: Task, url: URL): Promise<Response> {
  const turnNumber = integerQueryParam(url, "turn", 1);
  if (turnNumber instanceof Response) return turnNumber;
  const n = turnNumber ?? task.turn_count;
  const parsedOffset = integerQueryParam(url, "offset", 0);
  if (parsedOffset instanceof Response) return parsedOffset;
  const offset = parsedOffset ?? -1;
  const turn = turnForTask(task.id, n);
  if (!turn) return err(`no turn ${n}`, 404);
  if (turn.capture_state === "evicted") return json({
    turn: n, status: turn.status, harness: turn.harness, size: 0, out: "", err: "",
    capture_state: "evicted", notice: TRANSCRIPT_EVICTED_NOTICE,
  });
  const release = acquireTranscriptRead(turn.id);
  try {
    const slice =
      offset >= 0
        ? await readSlice(turn.log_file, offset, 262_144)
        : { text: await readTailOf(turn.log_file, LOG_TAIL_BYTES), size: 0 };
    return json({
      turn: n, status: turn.status, harness: turn.harness, size: slice.size, out: slice.text,
      err: await readTailOf(turn.log_file.replace(/\.out\.log$/, ".err.log"), LOG_TAIL_BYTES),
    });
  } finally { release(); }
}
