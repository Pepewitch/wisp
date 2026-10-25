// Autopilot on subtasks, by kind, and who may let a subtask merge: a person,
// or a parent agent passing on rights a person gave it, re-checked at merge.
import { describe, expect, test } from "bun:test";
import { autopilotRow, setAutopilot } from "../src/autopilot/store";
import { holdsMergeRights, inheritedRightsLost } from "../src/autopilot/subtask-policy";
import type { WispConfig } from "../src/config";
import { createAndLaunchTask } from "../src/domain/task-create";
import { createWorkflow, changeWorkflowState } from "../src/workflows/store";
import { BUILTIN_WORKFLOWS, validateWorkflowParams } from "../src/workflows/definitions";
import { autopilotRoute } from "../src/routes/autopilot";
import { createTask, db, freeSlot, getTask, newTaskId, setTaskFields, transition } from "../src/store";
import { holdClass } from "../src/subtask-reports";
import type { SubtaskKind } from "../src/types";

function task(parent?: string, kind: SubtaskKind = "explore"): string {
  const id = newTaskId();
  createTask({
    id, title: parent ? "child" : "parent", repo_path: "/fixture", harness: "fake", model: null, slot: freeSlot(),
    ...(parent ? { subtask: { parent_task_id: parent, subtask_kind: kind, report_to_parent: true, base_from: "project" } } : {}),
  });
  setTaskFields(id, { worktree_path: "/fixture", branch: `wisp/${id}` });
  transition(id, "done");
  return id;
}

const granted = (id: string) => getTask(id)!.merge_granted_by ?? null;
const heartbeat = BUILTIN_WORKFLOWS.find((definition) => definition.id === "heartbeat")!;

describe("autopilot on subtasks", () => {
  test("by kind: an explore child may run every switch; review and continue children none; off always works", () => {
    const parent = task();
    const explore = task(parent);
    expect(setAutopilot(explore, { autoFix: true, autoReview: true }, new Date(), `agent:${parent}`)).toMatchObject({ autoFix: true, autoReview: true });
    for (const kind of ["review", "continue"] as const) {
      const child = task(parent, kind);
      expect(() => setAutopilot(child, { autoFix: true })).toThrow(kind === "review" ? "never pushes" : "opens no PR");
      expect(setAutopilot(child, { autoMerge: false })).toMatchObject({ autoMerge: false });
    }
  });

  test("a person grants auto-merge on any explore child, recorded as theirs; switching it off clears the grant", () => {
    const parent = task();
    const child = task(parent);
    setAutopilot(child, { autoMerge: true }, new Date(), "web");
    expect(granted(child)).toBe("person");
    setAutopilot(child, { autoMerge: false }, new Date(), "web");
    expect(granted(child)).toBeNull();
  });

  test("an agent passes auto-merge on only to its own explore child, and only while it holds rights from a person", () => {
    const parent = task();
    const child = task(parent);
    expect(() => setAutopilot(child, { autoMerge: true }, new Date(), `agent:${parent}`)).toThrow(`merge rights: task ${parent} has none from a person`);
    expect(autopilotRow(child)).toBeNull();
    // its own auto-merge, an agent's, confers nothing
    setAutopilot(parent, { autoMerge: true }, new Date(), `agent:${parent}`);
    expect(granted(parent)).toBe(`agent:${parent}`);
    expect(holdsMergeRights(parent)).toBe(false);
    // a person's does
    setAutopilot(parent, { autoMerge: false }, new Date(), "web");
    setAutopilot(parent, { autoMerge: true }, new Date(), "web");
    expect(holdsMergeRights(parent)).toBe(true);
    expect(() => setAutopilot(child, { autoMerge: true }, new Date(), "agent:tstranger")).toThrow("only for its own explore subtasks");
    setAutopilot(child, { autoMerge: true }, new Date(), `agent:${parent}`);
    expect(granted(child)).toBe(`parent:${parent}`);
    expect(inheritedRightsLost(getTask(child)!)).toBeNull();
    // the parent's auto-merge goes off: the child's inherited grant no longer stands at merge time
    setAutopilot(parent, { autoMerge: false }, new Date(), "web");
    const lost = inheritedRightsLost(getTask(child)!);
    expect(lost).toContain(`Merge rights came from task ${parent}`);
    expect(holdClass(lost!)).toBe("merge-rights");
    // a person's own grant on a child does not depend on the parent
    const other = task(parent);
    setAutopilot(other, { autoMerge: true }, new Date(), "web");
    expect(inheritedRightsLost(getTask(other)!)).toBeNull();
  });

  test("rights from a workflow: a person's live allowMerge counts; an expired one, an agent's resume, and a legacy row do not", () => {
    const parent = task();
    const params = validateWorkflowParams(heartbeat, { prompt: "merge when green", allowMerge: true });
    // recorded the way the workflows route records it: the person's own actor
    const flow = createWorkflow(parent, heartbeat, params, new Date(), "web");
    expect(holdsMergeRights(parent)).toBe(true);
    db.run("UPDATE workflows SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [flow.id]);
    expect(holdsMergeRights(parent)).toBe(false);
    db.run("UPDATE workflows SET expires_at = '9999-01-01T00:00:00.000Z' WHERE id = ?", [flow.id]);
    changeWorkflowState(flow.id, "paused", "Stop", new Date());
    changeWorkflowState(flow.id, "active", "resumed", new Date(), `agent:${parent}`);
    expect(holdsMergeRights(parent)).toBe(false);
    db.run("UPDATE workflows SET merge_allowed_by = NULL WHERE id = ?", [flow.id]);
    expect(holdsMergeRights(parent)).toBe(false);
  });

  test("the policy holds at creation, before any row exists, and through the route", async () => {
    const parent = task();
    const cfg = { maxConcurrentTasks: 100, repos: [] } as unknown as WispConfig;
    const before = db.query("SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = ?").get(parent) as { n: number };
    const refused = await createAndLaunchTask({
      repoPath: "", prompt: "x", harness: "quick", fast: false, mode: "worktree", actor: `agent:${parent}`,
      subtask: { parentId: parent }, autopilot: { autoMerge: true, autoFix: false },
    }, cfg, { quick: { bin: "bash", exec: ["-c", "printf done"], parse: { format: "text" }, attach: null } }, null);
    expect(refused).toEqual({ kind: "conflict", error: `merge rights: task ${parent} has none from a person, so it cannot pass them on` });
    expect(db.query("SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = ?").get(parent)).toEqual(before);
    const child = task(parent);
    const path = `/api/tasks/${child}/autopilot`;
    const response = await autopilotRoute(new Request(`http://wisp.test${path}`, {
      method: "PUT", body: JSON.stringify({ autoMerge: true }), headers: { "x-wisp-client": "cli", "x-wisp-task": parent },
    }), path);
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 409, body: { error: `merge rights: task ${parent} has none from a person, so it cannot pass them on` },
    });
  });
});
