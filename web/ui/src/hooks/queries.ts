import { useQuery } from "@tanstack/react-query";

import { ApiError } from "@/lib/api";
import { useDaemonRuntime } from "@/lib/runtime";
import type {
  ApiTask,
  DiffResponse,
  HarnessInfo,
  PullRequestOverview,
  PullRequestStatus,
  RepoInfo,
  StatusEntry,
  SuffixPrompt,
  TaskDetail,
  TaskSkills,
  UpdateStatus,
} from "@/lib/types";

/** GET /api/tasks — archived rows are only present when the sidebar toggle fetched ?archived=1. */
export function useTasks(showArchived: boolean) {
  const { transport, qk } = useDaemonRuntime();
  return useQuery({
    queryKey: qk.tasksList(showArchived),
    queryFn: () => transport.request<ApiTask[]>(`/api/tasks${showArchived ? "?archived=1" : ""}`),
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
export function useUpdateStatus() {
  const { transport, qk } = useDaemonRuntime()
  return useQuery({
    queryKey: qk.update,
    queryFn: () => transport.request<UpdateStatus>("/api/update"),
    refetchInterval: UPDATE_STATUS_POLL_MS,
    refetchIntervalInBackground: false,
  })
}

/** GET /api/tasks/:id — adds turns and diffstat to the list row. */
export function useTaskDetail(id: string | null) {
  const { transport, qk } = useDaemonRuntime();
  return useQuery({
    queryKey: qk.task(id ?? ""),
    queryFn: () => transport.request<TaskDetail>(`/api/tasks/${id}`),
    enabled: id !== null,
  });
}

export const PULL_REQUEST_POLL_MS = 30_000;
export const PULL_REQUEST_OVERVIEW_POLL_MS = 60_000;

export function pullRequestPollInterval(data: PullRequestStatus | undefined): number | false {
  if (data?.kind === "unsupported") return false;
  if (
    data?.kind === "found" &&
    (data.pullRequest.lifecycle === "merged" || data.pullRequest.lifecycle === "closed")
  ) {
    return false;
  }
  return PULL_REQUEST_POLL_MS;
}

/**
 * The selected task's forge status. `refetchIntervalInBackground` stays false,
 * so a hidden tab makes no provider calls. Terminal states and unsupported
 * origins stop entirely; "none" keeps watching for a newly-created PR.
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
    queryFn: () => transport.request<{ harnesses: HarnessInfo[] }>("/api/harnesses"),
    select: (data) => data.harnesses,
    enabled,
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
