import { describe, expect, it } from "vitest";

import { groupTasksByProject, pathBasename } from "./projects";
import type { ApiTask, RepoInfo } from "./types";

function makeTask(id: string, repoPath: string, overrides: Partial<ApiTask> = {}): ApiTask {
  return {
    id,
    title: `task ${id}`,
    repo_path: repoPath,
    worktree_path: `/tmp/wt-${id}`,
    branch: `wisp/${id}-x`,
    base_commit: "deadbeef",
    harness: "droid",
    model: "kimi-k3",
    effort: null,
    slot: 1,
    state: "running",
    state_detail: null,
    session_id: null,
    seq: 1,
    turn_count: 1,
    archived: false,
    mode: "worktree",
    created_at: "2026-08-23T00:00:00Z",
    updated_at: "2026-08-23T00:00:00Z",
    ...overrides,
  };
}

const repo = (path: string, name: string | null = null, exists = true): RepoInfo => ({
  path,
  name,
  exists,
  setupScript: "",
  archiveScript: "",
  copyFiles: [],
  configured: true,
});

describe("groupTasksByProject", () => {
  it("creates a group per repo in /api/repos order, even with no tasks", () => {
    const groups = groupTasksByProject([], [repo("/a/one", "one"), repo("/a/two", "two")]);
    expect(groups.map((g) => g.name)).toEqual(["one", "two"]);
    expect(groups.every((g) => g.tasks.length === 0 && !g.unlisted)).toBe(true);
  });

  it("matches tasks to projects by repo_path and keeps their order", () => {
    const groups = groupTasksByProject(
      [makeTask("t1", "/a/one"), makeTask("t2", "/a/two"), makeTask("t3", "/a/one")],
      [repo("/a/one", "one"), repo("/a/two", "two")],
    );
    expect(groups[0]!.tasks.map((t) => t.id)).toEqual(["t1", "t3"]);
    expect(groups[1]!.tasks.map((t) => t.id)).toEqual(["t2"]);
  });

  it("absorbs a trailing-slash drift between task and repo paths", () => {
    const groups = groupTasksByProject([makeTask("t1", "/a/one/")], [repo("/a/one", "one")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.tasks.map((t) => t.id)).toEqual(["t1"]);
  });

  it("a task whose repo is not a configured project still groups, path-derived, after the listed groups", () => {
    const groups = groupTasksByProject(
      [makeTask("t1", "/a/one"), makeTask("t2", "/elsewhere/legacy")],
      [repo("/a/one", "one")],
    );
    expect(groups.map((g) => g.name)).toEqual(["one", "legacy"]);
    expect(groups[1]!.unlisted).toBe(true);
    expect(groups[1]!.path).toBe("/elsewhere/legacy");
    expect(groups[1]!.tasks.map((t) => t.id)).toEqual(["t2"]);
  });

  it("uses the configured display name, else the path basename", () => {
    const groups = groupTasksByProject([], [repo("/a/pinned", "pretty name"), repo("/a/plain", null)]);
    expect(groups.map((g) => g.name)).toEqual(["pretty name", "plain"]);
  });
});

describe("pathBasename", () => {
  it("takes the last non-empty segment", () => {
    expect(pathBasename("/a/b/c")).toBe("c");
    expect(pathBasename("/a/b/c/")).toBe("c");
    expect(pathBasename("/")).toBe("/");
  });
});
