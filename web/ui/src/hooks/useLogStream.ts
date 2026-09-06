import { useEffect, useReducer } from "react";

import { connectionStore } from "@/lib/conn";
import { useDaemonRuntime } from "@/lib/runtime";
import { SSE_CLOSED, type SseFactory, type SseLike } from "@/lib/sse";
import type { ActivityLogStreamFrames, LogStreamFrames } from "@/lib/types";
import { initialStreamState, streamReducer, type StreamState } from "@/stream/reducer";

/**
 * The per-task log follow: ONE EventSource on /api/tasks/:id/log/stream,
 * feeding the stream-pane reducer. Kept out of the query cache on purpose —
 * it is an append-only transcript with reset-on-reconnect semantics, not
 * replaceable server state (skills/wisp-dev/references/frontend.md).
 *
 * `state` frames are ignored here on purpose: cache truth flows through the
 * /api/events bridge, which already turns task/turn events into invalidations.
 *
 * `generation` lets the events bridge force a reopen after a reconnect (the
 * classic UI's openLogStream-on-reconnect): both streams die together when a
 * laptop sleeps.
 */
export function useLogStream(
  taskId: string | null,
  format: "activity" | "raw",
  generation: number,
  factory?: SseFactory,
): StreamState {
  const runtime = useDaemonRuntime();
  const conn = connectionStore(runtime.connectionId);
  const [state, dispatch] = useReducer(streamReducer, initialStreamState);

  useEffect(() => {
    if (!taskId) {
      dispatch({ type: "reset", note: "select a task" });
      conn.set("log", true); // nothing to stream is not an outage
      return;
    }

    let source: SseLike | null = null;
    let closed = false;
    let errored = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const open = (note: string) => {
      source?.close();
      dispatch({ type: "reset", note });
      const next = factory
        ? factory(`/api/tasks/${taskId}/log/stream?format=${format}`)
        : (runtime.transport.openEventStream(
            `/api/tasks/${taskId}/log/stream?format=${format}`,
          ) as unknown as SseLike);
      const isCurrent = () => !closed && source === next;
      next.addEventListener("backlog", (ev) => {
        if (!isCurrent()) return;
        if (format === "activity") {
          const d = JSON.parse(ev.data) as ActivityLogStreamFrames["backlog"]
          dispatch({ type: "backlog", turn: d.turn, prompt: d.prompt, activity: d.activity })
        } else {
          const d = JSON.parse(ev.data) as LogStreamFrames["backlog"]
          dispatch({ type: "raw-backlog", turn: d.turn, prompt: d.prompt, text: d.text })
        }
      });
      next.addEventListener("append", (ev) => {
        if (!isCurrent()) return;
        if (format === "activity") {
          const d = JSON.parse(ev.data) as ActivityLogStreamFrames["append"]
          dispatch({ type: "append", turn: d.turn, activity: d.activity })
        } else {
          const d = JSON.parse(ev.data) as LogStreamFrames["append"]
          dispatch({ type: "raw-append", turn: d.turn, text: d.text })
        }
      });
      next.addEventListener("turn-end", (ev) => {
        if (!isCurrent()) return;
        const d = JSON.parse(ev.data) as LogStreamFrames["turn-end"];
        dispatch({ type: "turn-end", turn: d.turn, status: d.status });
      });
      next.onopen = () => {
        if (!isCurrent()) return;
        // EventSource auto-reconnected: the daemon resends the current turn's
        // backlog from scratch, so reset the pane instead of duplicating it
        if (errored) dispatch({ type: "reset", note: "reconnected — waiting for output…" });
        errored = false;
        conn.set("log", true);
      };
      next.onerror = () => {
        if (!isCurrent()) return;
        errored = true;
        conn.set("log", false);
        // a hard failure (e.g. 401) never reconnects on its own — re-mint the
        // cookie and rebuild once, not on a loop
        if (next.readyState === SSE_CLOSED && reconnectTimer === null) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            void runtime.transport.ensureReady().then(() => {
              if (!closed) open("connecting…");
            });
          }, 3_000);
        }
      };
      source = next;
    };

    open("connecting…");

    return () => {
      closed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      source?.close();
      conn.set("log", true);
    };
  }, [taskId, format, generation, factory, runtime, conn]);

  return state;
}
