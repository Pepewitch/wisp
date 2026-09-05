import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api, completeAuth, mintSession } from "@/lib/api";
import type { AttachmentPayload } from "@/lib/attachments";
import { qk } from "@/lib/query";
import type { ApiTask, SendResponse, SuffixPrompt, TaskDetail, TaskMessage, TaskMode } from "@/lib/types";

/**
 * Every WRITE the app makes, one hook each — the mirror of queries.ts.
 *
 * The rule that makes this file worth having: a hook owns the invalidation its
 * own write implies, and nothing else. Navigation, closing a dialog, clearing
 * a composer and remembering an effort level are the CALL SITE's business and
 * ride in the `onSuccess` passed to `mutate`, so the hook stays reusable from
 * the next screen that needs the same verb.
 *
 * Query keys come from `qk` (lib/query.ts) — the same factory the SSE bridge
 * invalidates through, so a write and an event agree on what went stale.
 */

/* ---------------- tasks ---------------- */

export interface CreateTaskBody {
  repoPath: string;
  prompt: string;
  harness: string;
  model: string;
  mode: TaskMode;
  effort?: string;
  suffixPromptId?: string;
  attachments?: AttachmentPayload[];
}

/** POST /api/tasks — the composer's submit. Resolves to the created row. */
export function useCreateTask() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTaskBody) => api<ApiTask>("/api/tasks", { method: "POST", body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.tasks });
    },
  });
}

/** PATCH /api/tasks/:id — replace the task's display name without changing its branch or session. */
export function useRenameTask() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api<ApiTask>(`/api/tasks/${id}`, { method: "PATCH", body: { title } }),
    onSuccess: (saved) => {
      // The response is enough for an immediate rename. The daemon's matching
      // metadata event patches other connected tabs without broad refetches.
      client.setQueriesData<ApiTask[]>({ queryKey: qk.tasks }, (current) =>
        current?.map((task) =>
          task.id === saved.id ? { ...task, title: saved.title, updated_at: saved.updated_at } : task,
        ),
      );
      client.setQueryData<TaskDetail>(qk.task(saved.id), (current) =>
        current ? { ...current, title: saved.title, updated_at: saved.updated_at } : current,
      );
    },
  });
}

/**
 * POST /api/tasks/:id/send — steer the task with another prompt. Only the
 * detail query carries turns, so only the detail query goes stale here; the
 * state change that follows arrives as an SSE event.
 */
export function useSendMessage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      message,
      suffixPromptId,
      attachments,
      clientMessageId,
    }: {
      id: string;
      message: string;
      suffixPromptId?: string;
      attachments?: AttachmentPayload[];
      clientMessageId: string;
    }) =>
      // the field is OMITTED rather than sent empty: the daemon rejects
      // attachments on a harness without the capability, and an empty array
      // would make every plain steer of a droid task carry that question
      api<SendResponse>(`/api/tasks/${id}/send`, {
        method: "POST",
        body: {
          message,
          clientMessageId,
          ...(suffixPromptId ? { suffixPromptId } : {}),
          ...(attachments ? { attachments } : {}),
        },
      }),
    onSuccess: (_data, { id }) => {
      void client.invalidateQueries({ queryKey: qk.task(id) });
    },
  });
}

export function useUpdateQueuedMessage() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId, messageId, message }: { taskId: string; messageId: string; message: string }) =>
      api<TaskMessage>(`/api/tasks/${taskId}/messages/${messageId}`, { method: "PATCH", body: { message } }),
    onSuccess: (_saved, { taskId }) => {
      void client.invalidateQueries({ queryKey: qk.task(taskId) })
    },
  })
}

export function useCancelQueuedMessage() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId, messageId }: { taskId: string; messageId: string }) =>
      api<TaskMessage>(`/api/tasks/${taskId}/messages/${messageId}`, { method: "DELETE" }),
    onSuccess: (_saved, { taskId }) => {
      void client.invalidateQueries({ queryKey: qk.task(taskId) })
    },
  })
}

/* ---------------- suffix prompts ---------------- */

/** POST /api/suffix-prompts — save one daemon-wide reusable suffix. */
export function useCreateSuffixPrompt() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; prompt: string }) =>
      api<SuffixPrompt>("/api/suffix-prompts", { method: "POST", body }),
    onSuccess: (saved) => {
      client.setQueryData<{ suffixPrompts: SuffixPrompt[] }>(qk.suffixPrompts, (current) => ({
        suffixPrompts: [...(current?.suffixPrompts ?? []), saved],
      }));
    },
  });
}

/** PATCH /api/suffix-prompts/:id — rename or reword one, keeping its id. */
export function useUpdateSuffixPrompt() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name, prompt }: { id: string; name: string; prompt: string }) =>
      api<SuffixPrompt>(`/api/suffix-prompts/${id}`, { method: "PATCH", body: { name, prompt } }),
    onSuccess: (saved) => {
      client.setQueryData<{ suffixPrompts: SuffixPrompt[] }>(qk.suffixPrompts, (current) => ({
        suffixPrompts: (current?.suffixPrompts ?? []).map((prompt) => (prompt.id === saved.id ? saved : prompt)),
      }));
    },
  });
}

/** DELETE /api/suffix-prompts/:id — drop one. The call site resets a selection pointing at it. */
export function useDeleteSuffixPrompt() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/suffix-prompts/${id}`, { method: "DELETE" }),
    onSuccess: (_data, id) => {
      client.setQueryData<{ suffixPrompts: SuffixPrompt[] }>(qk.suffixPrompts, (current) => ({
        suffixPrompts: (current?.suffixPrompts ?? []).filter((prompt) => prompt.id !== id),
      }));
    },
  });
}

/**
 * What the two task verbs answer with. Interrupt acknowledges; push carries `git
 * push`'s own output, which `/attach`'s sibling `/push` shows on hover — so the
 * field is typed here rather than cast at the call site.
 */
export interface TaskVerbResult {
  ok?: boolean;
  output?: string;
}

/** POST /api/tasks/:id/interrupt — SIGTERM the running turn, keeping the session. */
export function useInterruptTask() {
  return useTaskVerb("interrupt");
}

/** POST /api/tasks/:id/push — `git push -u origin <branch>` in the task's worktree. */
export function usePushTask() {
  return useTaskVerb("push");
}

/**
 * The interrupt and push verbs. They refetch on `onSettled` rather than `onSuccess`
 * deliberately: a refused interrupt or a rejected push can still have moved the
 * daemon's view of the task (a push that fails after creating the upstream
 * ref). Callers own the refusal message; this hook owns keeping the task and
 * status views truthful afterwards.
 */
function useTaskVerb(verb: "interrupt" | "push") {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<TaskVerbResult>(`/api/tasks/${id}/${verb}`, { method: "POST" }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: qk.tasks });
      void client.invalidateQueries({ queryKey: qk.status });
    },
  });
}

/**
 * POST /api/tasks/:id/archive — unforced first, always. The daemon's 409 names
 * what is unsaved and what the remedies are, and that sentence is the confirm
 * dialog's whole value, so the refusal belongs to the call site.
 */
export function useArchiveTask() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, force }: { id: string; force: boolean }) =>
      api(`/api/tasks/${id}/archive`, { method: "POST", body: { force } }),
    onSuccess: (_data, { id }) => settleTask(client, id),
  });
}

/** POST /api/tasks/:id/fresh-session — drop `session_id` so the next turn starts clean. */
export function useFreshSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/tasks/${id}/fresh-session`, { method: "POST" }),
    onSuccess: (_data, id) => settleTask(client, id),
  });
}

/** A verb that changes the row itself: the list, its git badges and its detail. */
function settleTask(client: ReturnType<typeof useQueryClient>, id: string): void {
  void client.invalidateQueries({ queryKey: qk.tasks });
  void client.invalidateQueries({ queryKey: qk.status });
  void client.invalidateQueries({ queryKey: qk.task(id) });
}

/* ---------------- projects ---------------- */

export interface SaveProjectBody {
  path: string;
  setupScript: string;
  archiveScript: string;
  copyFiles: string[];
}

/**
 * POST /api/projects — a PATCH in spirit: it carries only the fields the
 * settings modal owns, and the daemon preserves the display name it does not
 * send.
 */
export function useSaveProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: SaveProjectBody) => api("/api/projects", { method: "POST", body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.repos });
    },
  });
}

/**
 * DELETE /api/projects — unregister a configured project. Task history stays
 * and nothing on disk is deleted; the call site closes the settings modal.
 */
export function useRemoveProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => api("/api/projects", { method: "DELETE", body: { path } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.repos });
    },
  });
}

export interface CopyPreview {
  files: string[];
  truncated: boolean;
}

/**
 * POST /api/projects/copy-preview — a READ that has to be a POST, because the
 * pattern list is a body rather than a path.
 *
 * It lives here, as a mutation, rather than in queries.ts: the call site fires
 * it at a moment (debounced, once the typing stops) instead of subscribing to a
 * key, and as a query it would inherit this client's window-focus refetch and
 * 5xx retry — extra requests for a preview nobody asked to re-run. The
 * mutation's `variables` are what the call site compares against the patterns
 * on screen, so a superseded answer is never shown as the current match.
 */
export function useCopyPreview() {
  return useMutation({
    mutationFn: ({ path, patterns }: { path: string; patterns: string[] }) =>
      api<CopyPreview>("/api/projects/copy-preview", { method: "POST", body: { path, patterns } }),
  });
}

/* ---------------- harnesses ---------------- */

/** How long the daemon's async probes get before the refreshed list is worth refetching. */
const REPROBE_SETTLE_MS = 1_800;

/**
 * `GET /api/harnesses?refresh=1` — a GET, but a command: it kicks the daemon's
 * model probes and returns the CACHED list, so the fresh answer does not exist
 * yet when the request resolves. The wait is inside `mutationFn` so `isPending`
 * covers it, and a failed kick is swallowed — the reasons already in the menu
 * say what this machine knows, which is more than a banner would.
 */
export function useReprobeHarnesses() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api("/api/harnesses?refresh=1").catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, REPROBE_SETTLE_MS));
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.harnesses });
    },
  });
}

/* ---------------- auth ---------------- */

/**
 * POST /api/session — trade the token for the HttpOnly cookie EventSource
 * needs. Nothing is invalidated: every request parked on the 401 gate retries
 * itself once `completeAuth` releases it.
 */
export function useMintSession() {
  return useMutation({
    mutationFn: (token: string) => mintSession(token),
    onSuccess: (_data, token) => completeAuth(token),
  });
}
