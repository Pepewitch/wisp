import { expect, test } from "bun:test";
import { createWorkflowPrSource } from "../src/workflows/github";

const url = "https://github.com/example/project/pull/42";
const head = "a".repeat(40);
const pull = { state: "open", merged: false, head: { sha: head } };
const check = { id: 1, name: "Tests", status: "completed", conclusion: "failure", html_url: `${url}/checks`, completed_at: "2026-01-01T00:00:00Z" };
const comment = {
  id: 1, user: { login: "reviewer", type: "User" }, body: "A small nit",
  updated_at: "2026-01-01T00:00:00Z", html_url: `${url}#discussion`,
};
const signal = () => new AbortController().signal;

test("CI normalizes completed failures and pending statuses for the pinned head", async () => {
  const paths: string[] = [];
  const source = createWorkflowPrSource(async path => {
    paths.push(path);
    if (path.includes("/check-runs")) return { check_runs: [check] };
    if (path.includes("/status?")) return { statuses: [{ id: 2, context: "Deploy", state: "pending", target_url: "" }] };
    return pull;
  });
  const result = await source(url, false, "/fixture", signal());
  expect(result.head).toBe(head);
  expect(result.checks.map(c => c.state)).toEqual(["failed", "pending"]);
  expect(paths.filter(path => path === "repos/example/project/pulls/42")).toHaveLength(2);
  expect(paths.some(path => path.includes(`/commits/${head}/check-runs`))).toBe(true);
});

test("review polling includes comment-only reviews, thread replies, comments, and edited bodies", async () => {
  const source = createWorkflowPrSource(async path => {
    if (path === "user") return { login: "agent" };
    if (path.includes("/reviews?")) return [{ ...comment, state: "COMMENTED", submitted_at: comment.updated_at }];
    if (path.includes("/comments?")) return [comment];
    return pull;
  });
  const result = await source(url, true, "/fixture", signal());
  expect(result.viewer).toBe("agent");
  expect(result.feedback.map(f => f.id).sort()).toEqual(["comment:1", "inline:1", "review:1"]);
  expect(result.feedback[0]?.body).toBe("A small nit");
});

test("a head change during collection refuses stale evidence", async () => {
  let reads = 0;
  const source = createWorkflowPrSource(async path => {
    if (path.includes("/check-runs")) return { check_runs: [] };
    if (path.includes("/status?")) return { statuses: [] };
    return ++reads === 1 ? pull : { ...pull, head: { sha: "b".repeat(40) } };
  });
  await expect(source(url, false, "/fixture", signal())).rejects.toThrow("changed during the check");
});

test("closed PRs finish without fetching checks or review history", async () => {
  let calls = 0;
  const source = createWorkflowPrSource(async () => { calls++; return { ...pull, state: "closed", merged: true }; });
  expect((await source(url, true, "/fixture", signal())).merged).toBe(true);
  expect(calls).toBe(1);
});

test("pagination is explicit and refuses incomplete or oversized collections", async () => {
  const paths: string[] = [];
  const source = createWorkflowPrSource(async path => {
    paths.push(path);
    if (path === "user") return { login: "agent" };
    if (path.includes("/comments?") || path.includes("/reviews?")) {
      return path.endsWith("page=1") ? Array.from({ length: 100 }, (_, id) => ({ ...comment, id })) : [];
    }
    return pull;
  });
  expect((await source(url, true, "/fixture", signal())).feedback).toHaveLength(300);
  expect(paths.filter(p => p.endsWith("page=2"))).toHaveLength(3);
  const oversized = createWorkflowPrSource(async path => {
    if (path === "user") return { login: "agent" };
    return path.includes("?") ? Array.from({ length: 100 }, () => comment) : pull;
  });
  await expect(oversized(url, true, "/fixture", signal())).rejects.toThrow("exceeds 500");
  const malformed = createWorkflowPrSource(async path => path.includes("?") ? {} : pull);
  await expect(malformed(url, false, "/fixture", signal())).rejects.toThrow("incomplete");
});
