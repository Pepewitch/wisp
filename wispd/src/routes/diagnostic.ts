import type { WispConfig } from "../config";
import { acquireDiagnosticExport } from "../recording/diagnostic";
import { getTurn, turnForTask } from "../store";
import type { Task } from "../types";
import { turnDiagnosticState } from "../types";
import { err, integerQueryParam } from "./http";

function unavailable(turnNumber: number, state: string, detail: string | null): Response {
  const suffix = detail ? `: ${detail}` : "";
  if (state === "evicted") return err(`diagnostic history for turn ${turnNumber} was evicted${suffix}`, 410);
  if (state === "disabled") return err(`diagnostic history for turn ${turnNumber} was disabled${suffix}`, 409);
  return err(`diagnostic history for turn ${turnNumber} is unavailable${suffix}`, 404);
}

/** Stream a leased concatenation of one turn's ordered JSONL segments. */
export function diagnosticLog(task: Task, url: URL, cfg: WispConfig): Response {
  const turnNumber = integerQueryParam(url, "turn", 1);
  if (turnNumber instanceof Response) return turnNumber;
  const n = turnNumber ?? task.turn_count;
  let turn = turnForTask(task.id, n);
  if (!turn) return err(`no turn ${n}`, 404);
  let state = turnDiagnosticState(turn);
  if (state !== "complete" && state !== "partial") return unavailable(n, state, turn.diagnostic_detail);

  let lease: ReturnType<typeof acquireDiagnosticExport>;
  try {
    lease = acquireDiagnosticExport(cfg, turn.id);
  } catch (error) {
    return err(`diagnostic archive is unavailable: ${error instanceof Error ? error.message : String(error)}`, 500);
  }

  // Manager startup can enforce TTL/quota and update this row. Re-read before
  // promising bytes whose archive may just have been evicted.
  turn = getTurn(turn.id)!;
  state = turnDiagnosticState(turn);
  if (state !== "complete" && state !== "partial") {
    lease.release();
    return unavailable(n, state, turn.diagnostic_detail);
  }
  if (lease.paths.length === 0 && (turn.diagnostic_bytes ?? 0) > 0) {
    lease.release();
    return err(`diagnostic history for turn ${n} is missing from storage`, 410);
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    lease.release();
  };
  let pathIndex = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          if (!reader) {
            const path = lease.paths[pathIndex++];
            if (!path) {
              controller.close();
              release();
              return;
            }
            reader = Bun.file(path).stream().getReader();
          }
          const item = await reader.read();
          if (item.done) {
            reader.releaseLock();
            reader = null;
            continue;
          }
          controller.enqueue(item.value);
          return;
        }
      } catch (error) {
        controller.error(error);
        release();
      }
    },
    async cancel() {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      reader = null;
      release();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="wisp-${task.id}-turn-${n}-diagnostic.jsonl"`,
      "x-wisp-diagnostic-state": state,
      "x-wisp-diagnostic-bytes": String(turn.diagnostic_bytes ?? 0),
      ...(turn.diagnostic_detail
        ? { "x-wisp-diagnostic-detail": encodeURIComponent(turn.diagnostic_detail) }
        : {}),
    },
  });
}
