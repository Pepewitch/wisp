import type { QueryClient } from "@tanstack/react-query";

import { qk } from "./query";
import type { ApiTask, TaskDetail, TaskState, WispEvent } from "./types";

/**
 * The EventSource→queryClient bridge (the wisp-dev frontend reference): the app holds exactly
 * ONE EventSource on /api/events, and this module translates each WispEvent
 * into query invalidations. Everything realtime flows through here — no
 * component opens its own /api/events connection, and nothing polls.
 *
 * The invalidation mapping mirrors the classic UI (web/index.html):
 *   task event    → metadata-only renames patch task caches directly; other
 *                   changes invalidate the list and selected detail
 *   turn event    → the selected task's detail + diff (debounced)
 *   project event → the repos list (debounced; add/remove re-shape the sidebar)
 *   any task/turn → /api/status git badges (debounced)
 *   reconnect     → invalidate everything once (a slept laptop resync)
 */
export interface SseLike {
  onmessage: ((ev: { data: string }) => void) | null;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  readonly readyState: number;
  /** named-frame subscription (the log stream's backlog/append/turn-end); /api/events uses onmessage */
  addEventListener(type: string, listener: (ev: { data: string }) => void): void;
  close(): void;
}

export type SseFactory = (url: string) => SseLike;

// EventSource's handler types (MessageEvent) don't narrow structurally to the
// bridge's minimal frame shape under strictFunctionTypes — adapt at the seam
export const defaultSseFactory: SseFactory = (url) => new EventSource(url) as unknown as SseLike;

/** EventSource.CLOSED — a hard failure (e.g. 401); the browser never retries these. */
export const SSE_CLOSED = 2;

export interface EventsBridgeOptions {
  client: QueryClient;
  /** detail/diff invalidations only fire for the currently selected task */
  getSelectedId: () => string | null;
  /** mint the wisp_token cookie before reconnecting (opens the token modal when needed) */
  ensureSession: () => Promise<void>;
  factory?: SseFactory;
  onConnectionChange?: (live: boolean) => void;
  /** a reconnect also reopens the selected task's log stream (both die together on a slept laptop) */
  onReconnect?: () => void;
  /** debounce windows in ms; 0 applies synchronously (tests) */
  tasksDebounceMs?: number;
  statusDebounceMs?: number;
  detailDebounceMs?: number;
  reconnectDelayMs?: number;
}

function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (ms <= 0) {
      fn();
      return;
    }
    if (t !== null) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn();
    }, ms);
  };
}

export function connectEventsBridge(opts: EventsBridgeOptions): () => void {
  const factory = opts.factory ?? defaultSseFactory;
  const reconnectDelayMs = opts.reconnectDelayMs ?? 3_000;
  let source: SseLike | null = null;
  let closed = false;
  let wasDown = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const invalidateTasks = debounce(() => void opts.client.invalidateQueries({ queryKey: qk.tasks }), opts.tasksDebounceMs ?? 300);
  const invalidateStatus = debounce(
    () => void opts.client.invalidateQueries({ queryKey: qk.status }),
    opts.statusDebounceMs ?? 400,
  );
  const invalidateRepos = debounce(
    () => void opts.client.invalidateQueries({ queryKey: qk.repos }),
    opts.statusDebounceMs ?? 400,
  );
  const invalidateSelectedTurn = debounce(() => {
    const id = opts.getSelectedId();
    if (!id) return;
    void opts.client.invalidateQueries({ queryKey: qk.task(id) });
    // skills follow turn boundaries too: the init event that names them lands
    // at finalize, and a session that refused while running answers now
    void opts.client.invalidateQueries({ queryKey: qk.skills(id) });
    void opts.client.invalidateQueries({ queryKey: qk.diff(id) });
  }, opts.detailDebounceMs ?? 400);
  const invalidateSelectedMessages = debounce(() => {
    const id = opts.getSelectedId();
    if (id) void opts.client.invalidateQueries({ queryKey: qk.task(id) });
  }, opts.detailDebounceMs ?? 400);

  function onEvent(evt: WispEvent): void {
    if (!evt) return;
    // project add/remove carries no taskId — it only re-shapes the repos list
    if (evt.type === "project") {
      invalidateRepos();
      return;
    }
    if (!("taskId" in evt) || !evt.taskId) return;
    // A rename carries the complete metadata delta. Patching it directly keeps
    // status, skills, diff, and the task list off the network.
    if (evt.type === "task" && evt.title !== undefined && evt.updatedAt !== undefined) {
      opts.client.setQueriesData<ApiTask[]>({ queryKey: qk.tasks }, (current) =>
        current?.map((task) =>
          task.id === evt.taskId ? { ...task, title: evt.title!, updated_at: evt.updatedAt! } : task,
        ),
      );
      opts.client.setQueryData<TaskDetail>(qk.task(evt.taskId), (current) =>
        current ? { ...current, title: evt.title!, updated_at: evt.updatedAt! } : current,
      );
      return;
    }
    if (evt.type === "message") {
      if (evt.taskId === opts.getSelectedId()) invalidateSelectedMessages();
      return;
    }
    // State and turn boundaries can change git-status badges.
    invalidateStatus();
    if (evt.type === "task") {
      // state/title/archive changes land in the sidebar
      invalidateTasks();
      if (evt.taskId === opts.getSelectedId()) {
        // instant header echo; the debounced refetch brings the truth (and
        // archive flips, which the event alone can't carry)
        opts.client.setQueryData<TaskDetail>(qk.task(evt.taskId), (old) =>
          old ? { ...old, state: evt.state as TaskState, state_detail: evt.stateDetail } : old,
        );
        invalidateSelectedTurn();
      }
    } else if (evt.type === "turn" && evt.taskId === opts.getSelectedId()) {
      invalidateSelectedTurn();
    }
  }

  function onOpen(): void {
    if (closed) return;
    if (!wasDown) return; // the initial connect reports nothing
    // the stream went down and came back: report, refetch the world once, and
    // reopen the log stream so its pane restarts from a fresh backlog
    wasDown = false;
    opts.onConnectionChange?.(true);
    void opts.client.invalidateQueries({ queryKey: qk.tasks });
    void opts.client.invalidateQueries({ queryKey: qk.status });
    void opts.client.invalidateQueries({ queryKey: qk.repos });
    const id = opts.getSelectedId();
    if (id) {
      void opts.client.invalidateQueries({ queryKey: qk.task(id) });
      void opts.client.invalidateQueries({ queryKey: qk.skills(id) });
      void opts.client.invalidateQueries({ queryKey: qk.diff(id) });
    }
    opts.onReconnect?.();
  }

  function onError(): void {
    if (closed) return;
    if (!wasDown) opts.onConnectionChange?.(false);
    wasDown = true;
    // readyState CLOSED means a hard failure (e.g. 401): the browser will not
    // retry on its own — re-mint the cookie, then rebuild the stream once.
    if (source && source.readyState === SSE_CLOSED && reconnectTimer === null) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void opts.ensureSession().then(() => {
          if (!closed) open();
        });
      }, reconnectDelayMs);
    }
  }

  function open(): void {
    source?.close();
    const next = factory("/api/events");
    next.onmessage = (ev) => {
      if (closed) return;
      let evt: WispEvent;
      try {
        evt = JSON.parse(ev.data) as WispEvent;
      } catch {
        return; // heartbeats arrive as comments, but never trust the frame
      }
      onEvent(evt);
    };
    next.onopen = onOpen;
    next.onerror = onError;
    source = next;
  }

  open();

  return () => {
    closed = true;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    source?.close();
  };
}
