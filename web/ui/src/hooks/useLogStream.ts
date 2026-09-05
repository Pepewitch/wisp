import { useEffect, useReducer } from "react";

import { connStore } from "@/lib/conn";
import { defaultSseFactory, SSE_CLOSED, type SseFactory, type SseLike } from "@/lib/sse";
import { ensureSession } from "@/lib/api";
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
  factory: SseFactory = defaultSseFactory,
): StreamState {
  const [state, dispatch] = useReducer(streamReducer, initialStreamState);

  useEffect(() => {
    if (!taskId) {
      dispatch({ type: "reset", note: "select a task" });
      connStore.set("log", true); // nothing to stream is not an outage
      return;
    }

    let source: SseLike | null = null;
    let closed = false;
    let errored = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const open = (note: string) => {
      source?.close();
      dispatch({ type: "reset", note });
      const next = factory(`/api/tasks/${taskId}/log/stream?format=${format}`);
      next.addEventListener("backlog", (ev) => {
        if (format === "activity") {
          const d = JSON.parse(ev.data) as ActivityLogStreamFrames["backlog"]
          dispatch({ type: "backlog", turn: d.turn, prompt: d.prompt, activity: d.activity })
        } else {
          const d = JSON.parse(ev.data) as LogStreamFrames["backlog"]
          dispatch({ type: "raw-backlog", turn: d.turn, prompt: d.prompt, text: d.text })
        }
      });
      next.addEventListener("append", (ev) => {
        if (format === "activity") {
          const d = JSON.parse(ev.data) as ActivityLogStreamFrames["append"]
          dispatch({ type: "append", turn: d.turn, activity: d.activity })
        } else {
          const d = JSON.parse(ev.data) as LogStreamFrames["append"]
          dispatch({ type: "raw-append", turn: d.turn, text: d.text })
        }
      });
      next.addEventListener("turn-end", (ev) => {
        const d = JSON.parse(ev.data) as LogStreamFrames["turn-end"];
        dispatch({ type: "turn-end", turn: d.turn, status: d.status });
      });
      next.onopen = () => {
        // EventSource auto-reconnected: the daemon resends the current turn's
        // backlog from scratch, so reset the pane instead of duplicating it
        if (errored) dispatch({ type: "reset", note: "reconnected — waiting for output…" });
        errored = false;
        connStore.set("log", true);
      };
      next.onerror = () => {
        errored = true;
        connStore.set("log", false);
        // a hard failure (e.g. 401) never reconnects on its own — re-mint the
        // cookie and rebuild once, not on a loop
        if (next.readyState === SSE_CLOSED && reconnectTimer === null) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            void ensureSession().then(() => {
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
      connStore.set("log", true);
    };
  }, [taskId, format, generation, factory]);

  return state;
}
