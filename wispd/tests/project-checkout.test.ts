// #412: a path inside a linked worktree is taken back to the project checkout
// Wisp knows for the same repository, so a task created from inside another
// task's worktree gets the project's recipe and settings.
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AdapterDef } from "../src/adapters";
import type { WispConfig } from "../src/config";
import { projectCheckoutFor } from "../src/domain/project-checkout";
import { createAndLaunchTask, type NewTaskInput } from "../src/domain/task-create";
import { hasRunningTurn } from "../src/runner";
import { getTask, turnsFor } from "../src/store";

const cfg: WispConfig = {
  instanceId: "123e4567-e89b-42d3-a456-426614174000",
  port: 0,
  host: "127.0.0.1",
  token: "test",
  webhooks: [],
  repos: [],
  stuckMinutes: 10,
  logMaxBytes: 5_000_000,
  setupTimeoutMinutes: 10,
  envAllowlist: {},
  harnessDefaults: {},
};
const adapters: Record<string, AdapterDef> = {
  quick: { bin: "bash", exec: ["-c", "printf done"], parse: { format: "text" }, attach: null },
};

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-c", "user.name=Checkout Test", "-c", "user.email=checkout@example.invalid", ...args], {
    cwd, stdout: "ignore", stderr: "pipe",
  });
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
}

/** A checkout with two linked worktrees beside it, the way task worktrees sit. */
async function project(): Promise<{ checkout: string; linked: string; other: string }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wisp-checkout-")));
  const checkout = join(root, "project");
  mkdirSync(checkout);
  await git(checkout, "init", "-q");
  await git(checkout, "commit", "-q", "--allow-empty", "-m", "init");
  const linked = join(root, "task-a");
  const other = join(root, "task-b");
  await git(checkout, "worktree", "add", "-q", "-b", "a", linked);
  await git(checkout, "worktree", "add", "-q", "-b", "b", other);
  return { checkout, linked, other };
}

describe("the project a creation path belongs to", () => {
  test("a linked worktree, or a directory inside one, belongs to the configured checkout", async () => {
    const { checkout, linked } = await project();
    mkdirSync(join(linked, "sub"));
    expect(await projectCheckoutFor(linked, [checkout], [])).toBe(checkout);
    expect(await projectCheckoutFor(join(linked, "sub"), [checkout], [])).toBe(checkout);
    // a checkout known only from a live task's repository counts too
    expect(await projectCheckoutFor(linked, [], [checkout])).toBe(checkout);
  });

  test("the path is kept when it is not a linked worktree, is configured itself, or has no known checkout", async () => {
    const { checkout, linked } = await project();
    expect(await projectCheckoutFor(checkout, [], [])).toBe(checkout);
    expect(await projectCheckoutFor(linked, [linked, checkout], [])).toBe(linked);
    expect(await projectCheckoutFor(linked, [], [])).toBe(linked);
    const unrelated = (await project()).checkout;
    expect(await projectCheckoutFor(linked, [unrelated], [join(unrelated, "missing")])).toBe(linked);
  });

  test("a task's worktree recorded as a repository by the old behaviour is never chosen", async () => {
    const { checkout, linked, other } = await project();
    expect(await projectCheckoutFor(other, [], [linked])).toBe(other);
    // the main checkout wins over a configured linked worktree of the same repository
    expect(await projectCheckoutFor(other, [linked], [checkout])).toBe(checkout);
    expect(await projectCheckoutFor(other, [linked], [])).toBe(linked);
  });

  test("a worktree task created from inside another worktree is created for the checkout; a local one stays", async () => {
    const { checkout, linked } = await project();
    const input = (mode: NewTaskInput["mode"]): NewTaskInput => ({
      repoPath: linked, prompt: "from inside a worktree", harness: "quick", fast: false, mode, actor: "cli",
    });
    const created = await createAndLaunchTask(input("worktree"), { ...cfg, repos: [checkout] }, adapters, null);
    if ("error" in created) throw new Error(created.error);
    expect(created.task.repo_path).toBe(checkout);
    const local = await createAndLaunchTask(input("local"), { ...cfg, repos: [checkout] }, adapters, null);
    if ("error" in local) throw new Error(local.error);
    expect(local.task.repo_path).toBe(linked);
    for (const id of [created.task.id, local.task.id]) {
      const deadline = Date.now() + 10_000;
      while (getTask(id)!.state === "creating" || hasRunningTurn(id) !== null || turnsFor(id).some((t) => t.status === "running")) {
        if (Date.now() > deadline) throw new Error(`task ${id} did not settle`);
        await Bun.sleep(25);
      }
    }
    expect(getTask(created.task.id)!.worktree_path).not.toBe(linked);
  });
});
