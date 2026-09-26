import { useEffect, useReducer } from "react";

import { connectionStore } from "@/lib/conn";
import {
  addDecodedLogStreamListener,
  createLogStreamDecoder,
  LogStreamProtocolError,
} from "@/lib/log-stream-protocol";
import { useDaemonRuntime } from "@/lib/runtime";
import { SSE_CLOSED, type SseFactory, type SseLike } from "@/lib/sse";
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
      conn.opening("log");
      dispatch({ type: "reset", note });
      const next = factory
        ? factory(`/api/tasks/${taskId}/log/stream?format=${format}`)
        : runtime.transport.openEventStream(`/api/tasks/${taskId}/log/stream?format=${format}`);
      const decoder = createLogStreamDecoder();
      let protocolFailed = false;
      const isCurrent = () => !closed && !protocolFailed && source === next;
      const failProtocol = (error: unknown) => {
        if (closed || protocolFailed || source !== next) return;
        protocolFailed = true;
        next.close();
        conn.set("log", false);
        const message =
          error instanceof LogStreamProtocolError
            ? error.message
            : "Log stream protocol error: malformed daemon frame";
        dispatch({ type: "reset", note: message });
      };
      const listen = <T,>(
        event: "hello" | "backlog" | "append" | "turn-end",
        decode: (data: string) => T,
        consume: (frame: T) => void,
      ) =>
        addDecodedLogStreamListener({
          source: next,
          event,
          active: isCurrent,
          decode,
          consume,
          fail: failProtocol,
        });
      listen("hello", decoder.hello, () => undefined);
      if (format === "activity") {
        listen("backlog", decoder.activityBacklog, (d) => {
          dispatch({ type: "backlog", turn: d.turn, prompt: d.prompt, activity: d.activity });
        });
        listen("append", decoder.activityAppend, (d) => {
          dispatch({ type: "append", turn: d.turn, activity: d.activity });
        });
      } else {
        listen("backlog", decoder.textBacklog, (d) => {
          dispatch({ type: "raw-backlog", turn: d.turn, prompt: d.prompt, text: d.text });
        });
        listen("append", decoder.textAppend, (d) => {
          dispatch({ type: "raw-append", turn: d.turn, text: d.text });
        });
      }
      listen("turn-end", decoder.turnEnd, (d) => {
        dispatch({ type: "turn-end", turn: d.turn, status: d.status });
      });
      next.onopen = () => {
        if (!isCurrent()) return;
        // the stream auto-reconnected: the daemon resends the current turn's
        // backlog from scratch, so reset the pane instead of duplicating it
        if (errored) dispatch({ type: "reset", note: "reconnected — waiting for output…" });
        errored = false;
        conn.set("log", true);
      };
      next.onerror = () => {
        if (!isCurrent()) return;
        errored = true;
        conn.set("log", false);
        // a hard failure (e.g. 401) never reconnects on its own — re-check the
        // token and rebuild once, not on a loop
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
