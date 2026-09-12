import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { ApiError } from "@/lib/api";
import { reconcilePullRequests } from "@/lib/pull-request-record";
import { useDaemonRuntime, type DaemonRuntime } from "@/lib/runtime";
import type {
  ApiTask,
  AttachResponse,
  ConversationDetail,
  DiffResponse,
  HarnessesResponse,
  PullRequestOverview,
  PullRequestStatus,
  RepoInfo,
  SearchResponse,
  StatusEntry,
  SuffixPrompt,
  TaskSkills,
  UpdateStatus,
  WorktreeFileResponse,
} from "@/lib/types";

/** GET /api/tasks — unfinished cleanup stays visible even with archived history hidden. */
export function useTasks(showArchived: boolean) {
  const { transport, qk } = useDaemonRuntime();
  return useQuery({
    queryKey: qk.tasksList(showArchived),
    queryFn: () => transport.request<ApiTask[]>(`/api/tasks${showArchived ? "?archived=1" : "?cleanup=1"}`),
  });
}

/**
 * GET /api/search — the sidebar's cross-project search.
 *
 * `placeholderData: keepPrevious` is what makes typing feel like filtering
 * rather than reloading: the previous answer stays on screen while the next
 * one is in flight, so the results list never blinks empty between keystrokes.
 * An empty query is not a request — the daemon refuses it, and there is
 * nothing to ask.
 */
export function useTaskSearch(query: string) {
  const { transport, qk } = useDaemonRuntime();
  const trimmed = query.trim();
  return useQuery({
    queryKey: qk.search(trimmed),
    queryFn: () => transport.request<SearchResponse>(`/api/search?q=${encodeURIComponent(trimmed)}`),
    enabled: trimmed !== "",
    placeholderData: (previous) => previous,
    staleTime: 10_000,
  });
}

/** GET /api/status — sidebar git badges; covers live tasks only. */
export function useStatus() {
  const { transport, qk } = useDaemonRuntime();
  return useQuery({
    queryKey: qk.status,
    queryFn: () => transport.request<{ tasks: Record<string, StatusEntry> }>("/api/status"),
    select: (data) => data.tasks,
  });
}

export const UPDATE_STATUS_POLL_MS = 60 * 60 * 1000

/** Release discovery is daemon-cached, so one hourly read does not become one GitHub call per browser. */
export function useUpdateStatus(
  target?: Pick<DaemonRuntime, "transport" | "qk">
) {
  const active = useDaemonRuntime()
  const { transport, qk } = target ?? active
  return useQuery({
    queryKey: qk.update,
    queryFn: () => transport.request<UpdateStatus>("/api/update"),
    refetchInterval: UPDATE_STATUS_POLL_MS,
    refetchIntervalInBackground: false,
  })
}

/**
 * Prefer SQLite-only history, but retain protocol-1 compatibility. Older
 * daemons do not advertise the additive route, so only its 404 falls back to
 * the legacy Git-aware detail endpoint.
 */
export function useTaskDetail(id: string | null) {
  const { transport, qk } = useDaemonRuntime();
  return useQuery({
    queryKey: qk.task(id ?? ""),
    queryFn: async () => {
      try {
        return await transport.request<ConversationDetail>(`/api/tasks/${id}/conversation`)
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error
        return transport.request<ConversationDetail>(`/api/tasks/${id}`)
      }
    },
    enabled: id !== null,
  });
}

export const PULL_REQUEST_POLL_MS = 30_000;
export const PULL_REQUEST_OVERVIEW_POLL_MS = 60_000;

export function pullRequestPollInterval(data: PullRequestStatus | undefined): number | false {
  if (data?.kind === "unsupported") return false;
  return PULL_REQUEST_POLL_MS;
}

/**
 * The selected task's forge status. `refetchIntervalInBackground` stays false,
 * so a hidden tab makes no provider calls. Unsupported origins stop entirely.
 * Every GitHub result keeps watching because a task branch can be reused for
 * another PR after the current one closes or merges.
 */
export function usePullRequestStatus(id: string | null) {
  const { transport, qk } = useDaemonRuntime();
  return useQuery({
    queryKey: qk.pullRequest(id ?? ""),
    queryFn: () => transport.request<PullRequestStatus>(`/api/tasks/${id}/pull-request`),
    enabled: id !== null,
    refetchInterval: (query) => pullRequestPollInterval(query.state.data),
    refetchIntervalInBackground: false,
  });
}

/**
 * One provider overview for every live sidebar row. The daemon batches task
 * branches per repository and serves its shared cache, so this interval is not
 * one GitHub request per row or per browser tab. Hidden tabs never poll.
 */
export function usePullRequestOverview() {
  const { transport, qk } = useDaemonRuntime();
  return useQuery({
    queryKey: qk.pullRequests,
    queryFn: () => transport.request<PullRequestOverview>("/api/pull-requests"),
    refetchInterval: PULL_REQUEST_OVERVIEW_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

/**
 * The app's ONE reading of pull-request state, for the sidebar and the header
 * alike. Each used to read its own query and they drifted apart between ticks;
 * see `reconcilePullRequests` for what that looked like on screen and why
 * folding both responses into one record is the whole fix.
 *
 * Both queries still run — the selected task is worth watching twice as often
 * as the rest — but neither is read on its own any more.
 */
export function usePullRequests(selectedId: string | null) {
  const overview = usePullRequestOverview();
  const selected = usePullRequestStatus(selectedId);
  const tasks = useMemo(
    () =>
      reconcilePullRequests(overview.data?.tasks, selectedId, selected.data, {
        selected: selected.dataUpdatedAt,
        overview: overview.dataUpdatedAt,
      }),
    [
      overview.data,
      overview.dataUpdatedAt,
      selectedId,
      selected.data,
      selected.dataUpdatedAt,
    ],
  );
  return {
    tasks,
    selected: selectedId === null ? undefined : tasks[selectedId]?.status,
  };
}

/**
 * GET /api/tasks/:id/skills — the harness's own registry for the palette's
 * Tier 3 (A4). A 409 (task running/creating) is an expected transient state,
 * not an error surface: the Skills group is simply absent until the next turn
 * boundary invalidates and the daemon can answer. Nothing is faked in between.
 */
export function useTaskSkills(id: string | null, archived: boolean) {
  const { transport, qk } = useDaemonRuntime();
  return useQuery({
    queryKey: qk.skills(id ?? ""),
    enabled: id !== null && !archived,
    queryFn: () => transport.request<TaskSkills>(`/api/tasks/${id}/skills`),
  });
}
/**
 * GET /api/tasks/:id/attach — the harness's own interactive resume command for
 * the stored session. The session id rides the query key, so a compaction's
 * replacement refetches. `argv: null` and failures are expected shapes, not
 * errors to surface: the resume hint renders nothing rather than pretending.
 */
export function useAttachCommand(id: string | null, session: string | null) {
  const { transport, qk } = useDaemonRuntime();
  return useQuery({
    queryKey: qk.attach(id ?? "", session ?? ""),
    enabled: id !== null && session !== null,
    queryFn: () => transport.request<AttachResponse>(`/api/tasks/${id}/attach`),
  });
}

/** GET /api/repos — the sidebar's project groups and the create modal's project picker. */
export function useRepos() {
  const { transport, qk } = useDaemonRuntime();
  return useQuery({
    queryKey: qk.repos,
    queryFn: () => transport.request<{ repos: RepoInfo[] }>("/api/repos"),
    select: (data) => data.repos,
  });
}

/** GET /api/suffix-prompts — the daemon-wide library shared by both composers. */
export function useSuffixPrompts(enabled = true) {
  const { transport, qk } = useDaemonRuntime();
  return useQuery({
    queryKey: qk.suffixPrompts,
    queryFn: () => transport.request<{ suffixPrompts: SuffixPrompt[] }>("/api/suffix-prompts"),
    select: (data) => data.suffixPrompts,
    enabled,
  });
}

/**
 * GET /api/harnesses — the create modal's harness→model dropdown plus the
 * steer box's paste capability (S3). The daemon serves the probe cache, so a
 * request never blocks on a CLI.
 */
export function useHarnesses(enabled: boolean) {
  const { transport, qk } = useDaemonRuntime();
  return useQuery({
    queryKey: qk.harnesses,
    queryFn: () => transport.request<HarnessesResponse>("/api/harnesses"),
    select: (data) => data.harnesses,
    enabled,
  });
}

/**
 * Daemon-level capability flags from the same /api/harnesses cache. A flag
 * absent on an older daemon reads as unsupported — never optimistic.
 */
export function useHarnessFeatures() {
  const { transport, qk } = useDaemonRuntime();
  return useQuery({
    queryKey: qk.harnesses,
    queryFn: () => transport.request<HarnessesResponse>("/api/harnesses"),
    select: (data) => data.features ?? {},
  });
}

/**
 * The diff pane's data. A 409 (archived / no worktree) is an expected state,
 * rendered as a muted note rather than an error — parity with the classic UI.
 *
 * A worktree git can no longer read arrives as a 200 carrying `worktreeReason`
 * (D1) and folds into that same `unavailable` shape: it is the same kind of
 * news, so it gets the same one muted line rather than a second mechanism.
 */
export type DiffData = ({ kind: "ok" } & DiffResponse) | { kind: "unavailable"; message: string };

export function useDiff(id: string | null, archived: boolean) {
  const { transport, qk } = useDaemonRuntime();
  return useQuery({
    queryKey: qk.diff(id ?? ""),
    enabled: id !== null && !archived, // an archived task's worktree is gone — there is no diff to fetch
    queryFn: async (): Promise<DiffData> => {
      try {
        const d = await transport.request<DiffResponse>(`/api/tasks/${id}/diff`);
        if (d.worktreeReason !== null) return { kind: "unavailable", message: d.worktreeReason };
        return { kind: "ok", ...d };
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) return { kind: "unavailable", message: e.message };
        throw e;
      }
    },
  });
}

/**
 * GET /api/tasks/:id/file — one worktree file, fetched when the viewer opens.
 *
 * A path arrives from a link an agent wrote, so a miss is ordinary: the query
 * resolves on click rather than on render, and the daemon's refusal is what
 * the viewer shows. Cached per (connection, task, path) because reopening the
 * same plan while reading a turn should not re-read it.
 */
export function useWorktreeFile(taskId: string | null, path: string | null) {
  const { transport, qk } = useDaemonRuntime();
  return useQuery({
    queryKey: qk.worktreeFile(taskId ?? "", path ?? ""),
    enabled: taskId !== null && path !== null,
    queryFn: () =>
      transport.request<WorktreeFileResponse>(
        `/api/tasks/${taskId}/file?path=${encodeURIComponent(path!)}`,
      ),
  });
}
