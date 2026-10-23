// #412: a path inside a linked worktree is taken back to the project checkout
// Wisp knows for the same repository, so a task created from inside another
// task's worktree gets the project's recipe and settings.
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import type { AdapterDef } from "../src/adapters";
import { createCommand } from "../src/cli-create";
import type { WispConfig } from "../src/config";
import { baseFromCaller, projectCheckoutFor } from "../src/domain/project-checkout";
import { createAndLaunchTask, type NewTaskInput } from "../src/domain/task-create";
import { createTaskRoute } from "../src/routes/tasks";
import { hasRunningTurn } from "../src/runner";
import { getTask, listTasks, turnsFor } from "../src/store";

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

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-c", "user.name=Checkout Test", "-c", "user.email=checkout@example.invalid", ...args], {
    cwd, stdout: "pipe", stderr: "pipe",
  });
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  return (await new Response(proc.stdout).text()).trim();
}

async function settle(id: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (getTask(id)!.state === "creating" || hasRunningTurn(id) !== null || turnsFor(id).some((t) => t.status === "running")) {
    if (Date.now() > deadline) throw new Error(`task ${id} did not settle`);
    await Bun.sleep(25);
  }
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
    expect(await projectCheckoutFor(other, [], [linked, checkout])).toBe(checkout);
    // configured projects come before task history; a configured linked worktree is a project too
    expect(await projectCheckoutFor(other, [linked], [checkout])).toBe(linked);
    expect(await projectCheckoutFor(other, [linked, checkout], [])).toBe(checkout);
  });

  test("a base that depends on the directory is pinned where the caller asked; a branch is kept as typed", async () => {
    const { checkout, linked } = await project();
    await git(linked, "commit", "-q", "--allow-empty", "-m", "only in the worktree");
    const callerHead = await git(linked, "rev-parse", "HEAD");
    const callerParent = await git(linked, "rev-parse", "HEAD~1");
    expect(await baseFromCaller(linked, checkout, "HEAD")).toEqual({ base: callerHead });
    expect(await baseFromCaller(linked, checkout, "HEAD~1")).toEqual({ base: callerParent });
    expect(await baseFromCaller(linked, checkout, "a")).toEqual({ base: "a" });
    expect(await baseFromCaller(linked, checkout, undefined)).toEqual({ base: undefined });
    expect(await baseFromCaller(checkout, checkout, "HEAD")).toEqual({ base: "HEAD" });
  });

  test("a base that does not resolve where the caller asked is refused, even when the checkout resolves it", async () => {
    const { checkout, other } = await project();
    // the worktree has one commit, so its HEAD~1 names nothing; the checkout's names its first commit
    await git(checkout, "commit", "-q", "--allow-empty", "-m", "only in the checkout");
    const refused = { error: `base 'HEAD~1' does not resolve in ${other}` };
    expect(await baseFromCaller(other, checkout, "HEAD~1")).toEqual(refused);
    expect(await baseFromCaller(other, checkout, "no-such-ref")).toEqual({ error: `base 'no-such-ref' does not resolve in ${other}` });
    const created = await createAndLaunchTask(
      { repoPath: other, prompt: "relative base", harness: "quick", fast: false, mode: "worktree", actor: "cli", base: "HEAD~1" },
      { ...cfg, repos: [checkout] },
      adapters,
      null,
    );
    expect(created).toEqual({ kind: "invalid", ...refused });
    expect(listTasks(true).filter((task) => task.repo_path === checkout)).toEqual([]);
  });

  test("a worktree task created from inside another worktree is created for the checkout; a local one stays", async () => {
    const { checkout, linked } = await project();
    await git(linked, "commit", "-q", "--allow-empty", "-m", "the caller's work");
    const callerHead = await git(linked, "rev-parse", "HEAD");
    const input = (mode: NewTaskInput["mode"], extra: Partial<NewTaskInput> = {}): NewTaskInput => ({
      repoPath: linked, prompt: "from inside a worktree", harness: "quick", fast: false, mode, actor: "cli", ...extra,
    });
    const created = await createAndLaunchTask(input("worktree", { base: "HEAD" }), { ...cfg, repos: [checkout] }, adapters, null);
    if ("error" in created) throw new Error(created.error);
    expect(created.task.repo_path).toBe(checkout);
    const local = await createAndLaunchTask(input("local"), { ...cfg, repos: [checkout] }, adapters, null);
    if ("error" in local) throw new Error(local.error);
    expect(local.task.repo_path).toBe(linked);
    for (const id of [created.task.id, local.task.id]) await settle(id);
    const launched = getTask(created.task.id)!;
    expect(launched).toMatchObject({ state: "done", base_commit: callerHead });
    expect(launched.worktree_path).toBeTruthy();
    expect(launched.worktree_path).not.toBe(linked);
    expect(turnsFor(created.task.id)[0]).toMatchObject({ status: "done" });
    expect(getTask(local.task.id)).toMatchObject({ state: "done", worktree_path: linked });
  });

  test("wisp new says which repository the task was created for", async () => {
    const { checkout, linked } = await project();
    const config = { ...cfg, repos: [checkout] };
    let response: Response | undefined;
    // the CLI's request goes to the route in-process, the way the daemon would serve it
    const fetched = spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: RequestInit) => {
      response = await createTaskRoute(new Request(url, init), config, adapters, null);
      return response.clone();
    }) as unknown as typeof fetch);
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      await createCommand([linked, "from the CLI"], { harness: "quick" });
      await createCommand([checkout, "at the checkout"], { harness: "quick" });
    } finally { fetched.mockRestore(); log.mockRestore(); }
    expect(lines.filter((line) => line.startsWith("repository:"))).toEqual([`repository: ${checkout} (${linked} is inside a worktree of it)`]);
    for (const id of lines.flatMap((line) => /^created (t[a-z0-9]+)/.exec(line)?.[1] ?? [])) await settle(id);
  });
});
