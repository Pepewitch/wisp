/**
 * GET /api/events frames: one JSON WispEvent per SSE data frame. Events are a
 * realtime convenience, not a ledger; a restarted daemon starts silent.
 */
import type { OutputImage } from "./outputs";

export type WispEvent =
  | {
      type: "task";
      taskId: string;
      state: string;
      stateDetail: string | null;
      seq: number;
      /** Present for a metadata-only rename so clients can patch without refetching task data. */
      title?: string;
      updatedAt?: string;
    }
  | { type: "turn"; taskId: string; n: number; status: string }
  | { type: "outputs"; taskId: string; n: number; outputs: OutputImage[] }
  | { type: "message"; taskId: string; messageId: string }
  | { type: "workflow"; taskId: string }
  /** The task's brief or its switch changed; clients re-ask GET /api/tasks/:id/brief. Never carries the payload. */
  | { type: "brief"; taskId: string }
  /** The task's shell tabs changed — opened, closed, renamed, or now running something else. */
  | { type: "terminals"; taskId: string }
  | { type: "project"; action: "add" | "remove"; path: string }
  | { type: "harnesses" }
  | { type: "settings" }
  /** The daemon checked one harness's plan limits after a turn ended; clients re-ask its shared cache. */
  | { type: "harness-limits"; harness: string };
