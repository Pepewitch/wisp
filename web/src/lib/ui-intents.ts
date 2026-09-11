/**
 * Cross-component UI intents for the `/` palette (A2): the steer box issues,
 * the conversation answers. The same tiny-store pattern as lib/conn.ts — a
 * monotonic counter as the snapshot, consumers react in an effect. Never state
 * that matters: a missed intent is a shrug, not a bug.
 *
 * FOUR intents. `/log` is the palette's one command that needs another
 * component to move (`/diff`'s intent was deleted with the command, lib/slash.ts:
 * the Changes pane is always visible). A task focus request is the desktop
 * shell's: a clicked notification names a task on a connection whose view is
 * already mounted, and that view is the only thing that can select it. A find
 * request is ⌘F, the task overflow menu, and a picked cross-project result:
 * three places that all mean "open the transcript's find bar", none of which
 * owns the scroller that has to answer. A local-setup request is the same
 * shape again: the first-run panel and the sidebar's error row both mean "open
 * the Local Wisp dialog", and neither owns it — the desktop connection chrome
 * does, and it is mounted in two different shells.
 */
import { LOCAL_CONNECTION_ID } from "./transport";

/** A request to select one task; `seq` lets a view ignore requests older than its mount. */
export interface TaskFocusRequest {
  readonly taskId: string;
  readonly seq: number;
}

/**
 * A request to open find-in-task. `query` seeds the box; null keeps what is
 * there. `turn` is the one a cross-project result matched IN — a prose hit
 * lives inside a timeline that is collapsed until someone opens it, so the
 * request names the turn to open rather than landing the reader on 0/0.
 */
export interface FindRequest {
  readonly query: string | null;
  readonly turn: number | null;
  readonly seq: number;
}

export interface UiIntents {
  subscribe(fn: () => void): () => void;
  streamFocusRequests(): number;
  focusStream(): void;
  taskFocusRequest(): TaskFocusRequest | null;
  focusTask(taskId: string): void;
  findRequest(): FindRequest | null;
  openFind(query?: string | null, turn?: number | null): void;
  localSetupRequests(): number;
  openLocalSetup(): void;
}

function createUiIntents(): UiIntents {
  const listeners = new Set<() => void>();
  let streamFocusRequests = 0;
  let taskFocusRequest: TaskFocusRequest | null = null;
  let findRequest: FindRequest | null = null;
  let localSetupRequests = 0;
  const notify = () => {
    for (const fn of listeners) fn();
  };
  return {
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    /** `/log` — the conversation re-pins to the live tail */
    streamFocusRequests(): number {
      return streamFocusRequests;
    },
    focusStream(): void {
      streamFocusRequests += 1;
      notify();
    },
    /** the latest task the desktop shell asked this connection's view to show */
    taskFocusRequest(): TaskFocusRequest | null {
      return taskFocusRequest;
    },
    focusTask(taskId: string): void {
      taskFocusRequest = { taskId, seq: (taskFocusRequest?.seq ?? 0) + 1 };
      notify();
    },
    /** the latest ⌘F / menu / picked-result request to open find-in-task */
    findRequest(): FindRequest | null {
      return findRequest;
    },
    openFind(query: string | null = null, turn: number | null = null): void {
      findRequest = { query, turn, seq: (findRequest?.seq ?? 0) + 1 };
      notify();
    },
    /** the latest "open the Local Wisp setup dialog" request */
    localSetupRequests(): number {
      return localSetupRequests;
    },
    openLocalSetup(): void {
      localSetupRequests += 1;
      notify();
    },
  };
}

const stores = new Map<string, UiIntents>();

/** Cross-component intents never leak between daemon connection views. */
export function uiIntentsFor(connectionId: string): UiIntents {
  let intents = stores.get(connectionId);
  if (!intents) {
    intents = createUiIntents();
    stores.set(connectionId, intents);
  }
  return intents;
}

/** Compatibility for the current single-daemon web runtime. */
export const uiIntents = uiIntentsFor(LOCAL_CONNECTION_ID);
