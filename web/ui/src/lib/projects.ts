import type { ApiTask, RepoInfo } from "./types";

/**
 * The sidebar's project grouping (UX flow 1). GET /api/repos already returns
 * resolved paths, config projects first then task-history repos, each with a
 * display name (configured, else the server-derived basename) — so a group
 * exists for every repo the daemon knows about, even one with no tasks (the
 * `+` on an empty project is how its first task gets made).
 *
 * A task whose repo_path matches no listed repo still groups: under a
 * path-derived name, after the listed groups, in first-seen order. That is a
 * defensive state (the repos endpoint folds task history in, so it should not
 * happen) — but a stale or racing repos response must never drop a task row.
 */
export interface ProjectGroup {
  /** resolved repo path — the group's identity and the create modal's repoPath */
  path: string;
  /** display name from /api/repos (configured name or basename) */
  name: string;
  /** the daemon's fs probe at repos-fetch time */
  exists: boolean;
  /** true when no /api/repos entry backed this group (task-history-only fallback) */
  unlisted: boolean;
  tasks: ApiTask[];
}

/** Paths are resolved server-side; the only drift to absorb is a trailing slash. */
function normalizePath(path: string): string {
  return path.replace(/\/+$/, "");
}

/** A path-derived display name — the last non-empty segment, else the path itself. */
export function pathBasename(path: string): string {
  const segments = normalizePath(path).split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

export function groupTasksByProject(tasks: ApiTask[], repos: RepoInfo[]): ProjectGroup[] {
  const groups: ProjectGroup[] = repos.map((repo) => ({
    path: repo.path,
    name: repo.name ?? pathBasename(repo.path),
    exists: repo.exists,
    unlisted: false,
    tasks: [],
  }));
  const byPath = new Map(groups.map((g) => [normalizePath(g.path), g]));

  for (const task of tasks) {
    const key = normalizePath(task.repo_path);
    let group = byPath.get(key);
    if (!group) {
      group = {
        path: task.repo_path,
        name: pathBasename(task.repo_path),
        exists: true, // a task exists, so its repo did at creation time
        unlisted: true,
        tasks: [],
      };
      byPath.set(key, group);
      groups.push(group);
    }
    group.tasks.push(task);
  }
  return groups;
}
