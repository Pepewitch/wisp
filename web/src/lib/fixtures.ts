import type { ApiTask, RepoInfo, StatusEntry } from "./types"

/**
 * Sample data for the `#/gallery` route only. The live app reads the daemon.
 * Shapes come from ./types.ts, so a gallery entry and the real thing can never
 * drift apart without the typechecker noticing.
 */

const now = Date.now()
const at = (minsAgo: number): string => new Date(now - minsAgo * 60_000).toISOString()

function task(t: Partial<ApiTask> & Pick<ApiTask, "id" | "title" | "state">): ApiTask {
  return {
    repo_path: "/Users/dev/work/wisp",
    worktree_path: `/Users/dev/.wisp/worktrees/${t.id}`,
    branch: `wisp/${t.id}`,
    base_commit: "8f2a1c9",
    harness: "droid",
    model: "kimi-k3",
    effort: "high",
    slot: 1,
    state_detail: null,
    session_id: "01a02d59-1323-7211-bb77-57eb3d7ad11b",
    seq: 12,
    turn_count: 3,
    mode: "worktree",
    archived: false,
    created_at: at(90),
    updated_at: at(2),
    ...t,
  }
}

export const TASKS: ApiTask[] = [
  task({
    id: "t5qmha",
    title: "Fix the steer box swallowing cmd-enter",
    branch: "wisp/t5qmha-steer-box-hotkey",
    state: "running",
    state_detail: "turn 3 · editing steer-box.tsx",
  }),
  task({
    id: "tppxvp",
    title: "Port the projects API to config write-back",
    branch: "wisp/tppxvp-projects-write-api",
    state: "needs-input",
    state_detail: "Which key wins when both repos and projects are set in config.json?",
    turn_count: 2,
    updated_at: at(4),
  }),
  task({
    id: "twdy9g",
    title: "Terminal tab on the existing websocket",
    branch: "wisp/twdy9g-terminal-tab",
    state: "done",
    harness: "codex",
    model: "gpt-5.6-luna",
    turn_count: 5,
  }),
  task({
    id: "tq2szu",
    title: "Bump actions/setup-node to v5",
    branch: "wisp/tq2szu-setup-node-v5",
    state: "failed",
    state_detail: "harness exited 1 on turn 1",
    turn_count: 1,
  }),
  task({ id: "tvzcjv", title: "Cached model probe at boot", state: "done", turn_count: 4 }),
  task({ id: "tf445e", title: "Per-task effort on POST /api/tasks", state: "done", turn_count: 2 }),
  task({ id: "t4t4r2", title: "Mobile shell behind one md breakpoint", state: "done", turn_count: 6 }),
  task({ id: "twy8qt", title: "Contract tests for the named 409s", state: "done", turn_count: 3 }),
  task({
    id: "t8k41c",
    title: "Refresh the token after settings change",
    repo_path: "/Users/dev/work/sample-app",
    branch: "sample-app/t8k41c-refresh-token",
    state: "stuck",
    state_detail: "quiet for 14 min",
    turn_count: 7,
  }),
  task({
    id: "tw9f2b",
    title: "Disable the stale-data fallback",
    repo_path: "/Users/dev/work/sample-app",
    branch: null,
    worktree_path: null,
    state: "creating",
    state_detail: "creating worktree",
    turn_count: 0,
  }),
  task({
    id: "th2p8d",
    title: "Improve the table filters",
    repo_path: "/Users/dev/work/sample-app",
    branch: "sample-app/th2p8d-table-filters",
    state: "done",
    turn_count: 3,
  }),
  task({
    id: "tk73nv",
    title: "Update the validation rules",
    repo_path: "/Users/dev/work/sample-app",
    branch: "sample-app/tk73nv-validation-rules",
    state: "needs-input",
    state_detail: "the fallback behavior is not in the spec you linked",
    turn_count: 2,
  }),
]

export const PROJECTS: { path: string; name: string; exists: boolean }[] = [
  { path: "/Users/dev/work/wisp", name: "wisp", exists: true },
  { path: "/Users/dev/work/sample-app", name: "sample-app", exists: true },
  { path: "/Users/dev/work/api-service", name: "api-service", exists: true },
]

/** The settings dialog's two faces: a configured project, and a history-only one with nothing set yet. */
export const REPOS: RepoInfo[] = [
  {
    path: "/Users/dev/work/wisp",
    name: "wisp",
    exists: true,
    setupScript: "bun install\nbun run build",
    archiveScript: "rm -rf node_modules",
    copyFiles: [".env*"],
    configured: true,
  },
  {
    path: "/Users/dev/work/api-service",
    name: null,
    exists: true,
    setupScript: "",
    archiveScript: "",
    copyFiles: [],
    configured: false,
  },
]

export const STATUS: Record<string, StatusEntry> = {
  t5qmha: { branch: "wisp/t5qmha-steer-box-hotkey", dirtyFiles: 3, ahead: 2, unpushed: true, worktreeReason: null },
  tppxvp: { branch: "wisp/tppxvp-projects-write-api", dirtyFiles: 3, ahead: 1, unpushed: true, worktreeReason: null },
  twdy9g: { branch: "wisp/twdy9g-terminal-tab", dirtyFiles: 0, ahead: 2, unpushed: true, worktreeReason: null },
  // git has forgotten this one: the row shows muted words where the counts go,
  // because showing nothing there is the silent half of the D1 bug
  tq2szu: {
    branch: "wisp/tq2szu-setup-node-v5",
    worktreeReason:
      "Git no longer tracks this worktree (/Users/dev/.wisp/worktrees/tq2szu) — archive this task to clear the row; the files stay on disk.",
  },
  t8k41c: { branch: "sample-app/t8k41c-refresh-token", dirtyFiles: 1, ahead: 0, unpushed: false, worktreeReason: null },
}
