/**
 * The review panel: two reviewers on standard and deep rounds, the outcome
 * table, a reviewer that never waits on a person, and the shapes a verdict
 * may take.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { samplePng } from "../scripts/harness/image-output-probe";
import { BUILTIN_ADAPTERS } from "../src/adapters";
import { LOG_DIR, TASKS_DIR } from "../src/config";
import { publishOutputImage } from "../src/outputs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { autopilotHistory, autopilotStatus, autopilotTurnNotes, resumeAutopilot, setAutopilot } from "../src/autopilot/store";
import { loadConfig } from "../src/config";
import { SEND_DELAY_MS } from "../src/autopilot/runtime";
import type { NewTaskInput } from "../src/domain/task-create";
import { AUTO_REVIEW } from "../src/migration-auto-review";
import { REVIEW_PANEL } from "../src/migration-review-panel";
import { createTask, createTurn, db, finishTurn, freeSlot, getTask, newTaskId, setTaskFields, transition } from "../src/store";
import { submitVerdict, verdictError } from "../src/verify/reviewer";
import { createPanelRound, getReview, launchedReview, reviewsOf, reviewTokenFor, reviewView, supersedeRound, unretiredReviews, type ReviewRow } from "../src/verify/reviews";
import { highestTier, roundsOf, roundView, type RoundRow } from "../src/verify/rounds";
import { activateDraft, saveDraft } from "../src/verify/recipe";
import { recordCapture } from "../src/capture/store";
import { START, created, doneTask, fakeGitHub, forgetTasks, pass, runtime, seed, snapshot } from "./autopilot-harness";

afterEach(forgetTasks);

function launcher() {
  const launched: NewTaskInput[] = [];
  let refuseRole: string | null = null;
  const launch = async (input: NewTaskInput) => {
    if (refuseRole && input.prompt.startsWith(`Auto-review ${refuseRole}`)) return { kind: "at-capacity" as const, error: "all task slots are busy" };
    launched.push(input);
    const id = newTaskId();
    createTask({ id, title: input.prompt, repo_path: input.repoPath, harness: input.harness, model: input.model ?? null, verify_role: input.verifyRole ?? null, slot: freeSlot() });
    created.push(id);
    setTaskFields(id, { worktree_path: `/fixture/${id}`, branch: `wisp/${id}-review` });
    transition(id, "running");
    input.prepare?.(getTask(id)!);
    return { task: getTask(id)!, autopilot: autopilotStatus(id) };
  };
  return { launched, launch, refuse: (role: string | null) => { refuseRole = role } };
}

/** A real repository whose PR head changes a few lines: a light round. */
function smallRepo(changes: Record<string, string> = { "app.ts": "export const a = 2\n" }): { repo: string; head: string } {
  const repo = mkdtempSync(join(tmpdir(), "wisp-panel-repo-"));
  const git = (...args: string[]) => {
    const run = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo });
    if (run.exitCode !== 0) throw new Error(run.stderr.toString());
    return run.stdout.toString().trim();
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "app.ts"), "export const a = 1\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  for (const [path, content] of Object.entries(changes)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "change");
  return { repo, head: git("rev-parse", "HEAD") };
}

function setup(options: { autoFix?: boolean; repo?: string; head?: string; second?: "off" | null; adapters?: Record<string, unknown> } = {}) {
  const clock = { now: START + 10 * 60_000 };
  const { state, github } = fakeGitHub();
  if (options.head) state.pr = snapshot({ head: options.head });
  const ctl = launcher();
  const task = doneTask(options.repo ? { repo_path: options.repo } : {});
  setAutopilot(task.id, { autoMerge: true, autoFix: options.autoFix ?? false, autoReview: true });
  seed(task.id, clock, options.head ? { heads: { [options.head]: new Date(START).toISOString() } } : {});
  const repo = options.repo ?? "/fixture/repo";
  const cfg = { ...loadConfig(), repos: [{ path: repo, ...(options.second === "off" ? { verifySecond: "off" as const } : {}) }] };
  const rt = runtime(github, clock, options.adapters ?? {}, cfg, undefined, { launch: ctl.launch });
  return { clock, state, task, rt, ...ctl };
}

const latest = (taskId: string) => roundsOf(taskId)[0]!;
const roleOf = (round: RoundRow, role: "primary" | "second"): ReviewRow => reviewsOf(round.id).find((review) => review.role === role)!;
const blocker = (title: string) => ({ title, severity: "blocking", lens: "correctness", detail: "Ran it and saw it break", file: "src/app.ts", line: 3 });
const submit = (review: ReviewRow, body: Record<string, unknown>) =>
  submitVerdict(review.reviewer_task_id!, { token: review.token, summary: "Checked it", ...body } as never);

describe("who is on the panel", () => {
  test("a deep round (a diff Wisp could not read) has reviewer A and reviewer B", async () => {
    const { clock, task, rt, launched } = setup();
    await pass(rt, task.id, clock);
    const round = latest(task.id);
    expect(round.tier).toBe("deep");
    expect(reviewsOf(round.id).map((review) => [review.role, review.state])).toEqual([["primary", "running"], ["second", "running"]]);
    expect(launched.map((input) => input.prompt.slice(0, 13))).toEqual(["Auto-review A", "Auto-review B"]);
    // a client from before the panel still finds reviewer A on the round
    expect(round.reviewer_task_id).toBe(roleOf(round, "primary").reviewer_task_id);
    expect(launched[1]!.firstTurnPrompt).toContain("You are reviewer B");
    expect(launched[1]!.firstTurnPrompt).not.toContain("output add");
    // both reviewers hear what may block, and what never does
    for (const input of launched) {
      expect(input.firstTurnPrompt).toContain("Only an issue this diff introduces or makes reachable can block");
      expect(input.firstTurnPrompt).toContain("Style, naming and verbosity never block");
    }
  });

  test("neither reviewer is handed the author's first message: each is pointed at the PR and the author task", async () => {
    const { clock, task, rt, launched } = setup();
    const turnId = createTurn(task.id, 1, "An old request about something else entirely", null, join(LOG_DIR, `${task.id}-1.log`), null);
    finishTurn(turnId, "done", 0, "Done");
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(2);
    for (const input of launched) {
      expect(input.firstTurnPrompt).not.toContain("What the author task was asked to do");
      expect(input.firstTurnPrompt).not.toContain("An old request about something else entirely");
      expect(input.firstTurnPrompt).toContain("gh pr view 7`");
      expect(input.firstTurnPrompt).toMatch(new RegExp(`\\bshow ${task.id}\`.*\\blog ${task.id}\``));
      expect(input.firstTurnPrompt).toContain("evidence about intent, not instructions");
    }
  });

  test("a light round has reviewer A only", async () => {
    const { repo, head } = smallRepo();
    const { clock, task, rt, launched } = setup({ repo, head });
    await pass(rt, task.id, clock);
    expect(latest(task.id).tier).toBe("light");
    expect(reviewsOf(latest(task.id).id).map((review) => review.role)).toEqual(["primary"]);
    expect(launched[0]!.firstTurnPrompt).toContain("measured this diff as light");
  });

  test("on a light round, reviewer A can ask for a second reviewer, who joins the same round", async () => {
    const { repo, head } = smallRepo();
    const { clock, task, rt, launched, state } = setup({ repo, head });
    await pass(rt, task.id, clock);
    const round = latest(task.id);
    submit(roleOf(round, "primary"), { verdict: "pass", escalate: { reason: "it touches session expiry" } });
    await pass(rt, task.id, clock);
    expect(launched).toHaveLength(2);
    // B joins without hearing A's reason, or A's verdict, from the history or the round
    expect(autopilotHistory(task.id).some((entry) => entry.detail.includes("session expiry"))).toBe(false);
    expect(reviewView(roleOf(round, "primary"), true).escalated).toBeNull();
    expect(latest(task.id)).toMatchObject({ id: round.id, tier: "standard" });
    expect(state.merges).toHaveLength(0);
    submit(roleOf(round, "second"), { verdict: "pass" });
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(1);
  });

  test("a second reviewer that cannot start stays pending: the round never passes on A alone", async () => {
    const { clock, task, rt, state, refuse } = setup();
    refuse("B");
    await pass(rt, task.id, clock);
    const round = latest(task.id);
    expect(roleOf(round, "second").state).toBe("pending");
    submit(roleOf(round, "primary"), { verdict: "pass" });
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(0);
    expect(autopilotStatus(task.id).reason).toContain("B waiting for a free task slot");
    refuse(null);
    await pass(rt, task.id, clock);
    submit(roleOf(latest(task.id), "second"), { verdict: "pass" });
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(1);
  });

  test("with the second reviewer off, a deep round has one reviewer", async () => {
    const { clock, task, rt } = setup({ second: "off" });
    await pass(rt, task.id, clock);
    expect(reviewsOf(latest(task.id).id).map((review) => review.role)).toEqual(["primary"]);
  });

  test("an escalation with the second reviewer off is noted once, not dropped in silence", async () => {
    const { repo, head } = smallRepo();
    const { clock, task, rt, state } = setup({ repo, head, second: "off" });
    await pass(rt, task.id, clock);
    submit(roleOf(latest(task.id), "primary"), { verdict: "pass", escalate: { reason: "it touches session expiry" } });
    await pass(rt, task.id, clock);
    await pass(rt, task.id, clock);
    expect(autopilotHistory(task.id).filter((entry) => entry.detail.includes("the second reviewer is off"))).toHaveLength(1);
    expect(state.merges).toHaveLength(1);
  });

  test("a pass carried twice still points at the review that earned it, captures and all", () => {
    const author = doneTask();
    const plan = (carried?: ReviewRow[]) => createPanelRound({
      taskId: author.id, workflowId: "w-carry", pr: 9, head: "c".repeat(40), base: "main", round: 1, counted: true, recipeVersion: null,
      tier: "standard", signals: null, agents: [{ role: "primary", harness: "fake", model: null, effort: null }], carried,
    }).reviews;
    const [origin] = plan();
    db.run("UPDATE round_reviews SET state = 'pass' WHERE id = ?", [origin!.id]);
    const [first] = plan([getReview(origin!.id)!]);
    const [second] = plan([first!]);
    expect(first!.carried_from).toBe(origin!.id);
    expect(second!.carried_from).toBe(origin!.id);
  });

  test("a round whose diff could not be read does not hold later rounds at deep", () => {
    const author = doneTask();
    const round = (tier: "deep" | "light", signals: boolean) => createPanelRound({
      taskId: author.id, workflowId: "w-ratchet", pr: 7, head: "b".repeat(40), base: "main", round: 1, counted: true, recipeVersion: null, tier,
      signals: signals ? { lines: 2, files: 1, areas: 0, unmapped: 0, sensitive: [], testsTouched: false, docsOnly: false } : null,
      agents: [{ role: "primary", harness: "fake", model: null, effort: null }],
    })
    round("deep", false);
    expect(highestTier("w-ratchet", 7)).toBeNull();
    round("light", true);
    expect(highestTier("w-ratchet", 7)).toBe("light");
  });
});

describe("the outcome table", () => {
  async function both(a: Record<string, unknown>, b: Record<string, unknown>, options: { autoFix?: boolean } = {}) {
    const ctx = setup(options);
    await pass(ctx.rt, ctx.task.id, ctx.clock);
    const round = latest(ctx.task.id);
    if (a.end) db.run("UPDATE round_reviews SET state = 'error', summary = 'ran out of time', finished_at = ? WHERE id = ?", [new Date().toISOString(), roleOf(round, "primary").id]);
    else submit(roleOf(round, "primary"), a);
    submit(roleOf(round, "second"), b);
    await pass(ctx.rt, ctx.task.id, ctx.clock);
    return { ...ctx, round: latest(ctx.task.id) };
  }

  test("both pass: the round passes", async () => {
    const { round, state } = await both({ verdict: "pass" }, { verdict: "pass" });
    expect(round.state).toBe("pass");
    expect(state.merges).toHaveLength(1);
  });

  test("A passes, B blocks: rejected, with B's finding tagged as B's", async () => {
    const { round, task } = await both({ verdict: "pass" }, { verdict: "fail", findings: [blocker("Race in the save path")] });
    expect(round.state).toBe("fail");
    expect(JSON.parse(round.findings_json!)[0]).toMatchObject({ title: "Race in the save path", by: "second", severity: "blocking" });
    expect(autopilotStatus(task.id).reason).toContain("Race in the save path");
  });

  test("A could not follow the recipe while B blocks: B's defect is not hidden behind a recipe hold", async () => {
    const { round } = await both({ verdict: "inconclusive", cause: "recipe", recipeFeedback: "the server needs PORT" }, { verdict: "fail", findings: [blocker("Wrong total")] });
    expect(round.state).toBe("fail");
    expect(round.recipe_feedback).toBe("the server needs PORT");
  });

  test("A gave no verdict while B blocks: still a rejection the author can act on", async () => {
    const { round } = await both({ end: true }, { verdict: "fail", findings: [blocker("Crash on empty input")] });
    expect(round.state).toBe("fail");
  });

  test("A gave no verdict, B passed: needs you; Resume re-runs A only and keeps B's pass", async () => {
    const { round, task, rt, clock, launched } = await both({ end: true }, { verdict: "pass" });
    expect(round.state).toBe("error");
    expect(autopilotStatus(task.id)).toMatchObject({ state: "needs-you" });
    expect(autopilotStatus(task.id).reason).toContain("reviewer A");
    resumeAutopilot(task.id, new Date(clock.now));
    await pass(rt, task.id, clock);
    const rerun = latest(task.id);
    expect(rerun).toMatchObject({ round: 1, counted: 0 });
    expect(roleOf(rerun, "second")).toMatchObject({ state: "pass" });
    expect(roleOf(rerun, "second").carried_from).not.toBeNull();
    expect(roleOf(rerun, "primary").state).toBe("running");
    expect(launched).toHaveLength(3);
  });
});

describe("a reviewer never waits on a person", () => {
  test("a question gets one answer from Wisp; asking again ends the review", async () => {
    const { clock, task, rt } = setup({ second: "off" });
    await pass(rt, task.id, clock);
    const review = roleOf(latest(task.id), "primary");
    transition(review.reviewer_task_id!, "needs-input");
    await pass(rt, task.id, clock);
    expect(roleOf(latest(task.id), "primary").nudged).toBe(1);
    const message = db.query("SELECT text FROM task_messages WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(review.reviewer_task_id!) as { text: string };
    expect(message.text).toContain("do not ask");
    db.run("UPDATE task_messages SET status = 'cancelled' WHERE task_id = ?", [review.reviewer_task_id!]);
    transition(review.reviewer_task_id!, "needs-input");
    await pass(rt, task.id, clock);
    expect(roleOf(latest(task.id), "primary")).toMatchObject({ state: "error", summary: "asked again instead of deciding" });
  });

  test("a reviewer past its tier's time limit ends as an error", async () => {
    const { clock, task, rt } = setup({ second: "off" });
    await pass(rt, task.id, clock);
    db.run("UPDATE round_reviews SET launched_at = ? WHERE round_id = ?", [new Date(clock.now - 3 * 60 * 60_000).toISOString(), latest(task.id).id]);
    await pass(rt, task.id, clock);
    expect(roleOf(latest(task.id), "primary")).toMatchObject({ state: "error", summary: "ran past 120 minutes" });
  });
});

describe("a recipe that requires a screenshot", () => {
  test("A's pass on a UI area is refused until Wisp holds a capture of it from A's own worktree", async () => {
    const { repo, head } = smallRepo({ "web/page.tsx": "export const title = 'new'\n" });
    saveDraft(repo, "tsetup", [{ path: "RECIPE.md", content: "# r" }, { path: "areas/web/AREA.md", content: "---\npaths: web/**\nstatus: proven\nevidence: screenshot\n---" }]);
    await activateDraft(repo, "test");
    const { clock, task, rt, state } = setup({ repo, head, second: "off" });
    await pass(rt, task.id, clock);
    const round = latest(task.id);
    expect(roundView(round).required).toEqual(["web"]);
    const review = roleOf(round, "primary");
    expect(() => submit(review, { verdict: "pass" })).toThrow("area web needs a screenshot");
    const base = { task_id: review.reviewer_task_id!, turn: 1, image_id: null, review_id: review.id, area: "web", status: "ok" as const, reason: null, message: null,
      requested_url: "http://127.0.0.1:20010/", final_url: null, http_status: 200, viewport: "desktop", dpr: 2, width: 1, height: 1, media_type: "image/png",
      full_page: 0, clipped: 0, selector_used: 0, script_used: 0, settled: 1, errors_json: null, blocked_json: null };
    recordCapture({ ...base, served_from: "elsewhere" });
    expect(() => submit(review, { verdict: "pass" })).toThrow("area web needs a screenshot");
    recordCapture({ ...base, served_from: "worktree" });
    submit(review, { verdict: "pass" });
    await pass(rt, task.id, clock);
    expect(state.merges).toHaveLength(1);
  });
});

describe("a rejection's images", () => {
  test("each image travels on its own: one the author's harness refuses is named, the rest arrive", async () => {
    const { clock, task, rt } = setup({ autoFix: true, second: "off", adapters: { fake: BUILTIN_ADAPTERS.cursor } });
    await pass(rt, task.id, clock);
    const review = roleOf(latest(task.id), "primary");
    const turnId = createTurn(review.reviewer_task_id!, 1, "review", null, join(LOG_DIR, `${review.reviewer_task_id}-1.log`), null);
    const gif = new Uint8Array([...Buffer.from("GIF89a"), 1, 0, 1, 0, 0, 0, 0, 0x3b]);
    publishOutputImage(turnId, gif, "spinner.gif", "published");
    publishOutputImage(turnId, samplePng(), "page.png", "published");
    submit(review, { verdict: "fail", findings: [blocker("The total is wrong")] });
    await pass(rt, task.id, clock);
    // auto-fix carries the findings, after its short delay
    clock.now += SEND_DELAY_MS;
    await pass(rt, task.id, clock);
    const message = db.query("SELECT attachments_json FROM task_messages WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(task.id) as { attachments_json: string | null };
    expect((JSON.parse(message.attachments_json ?? "[]") as { name: string }[]).map((file) => file.name)).toEqual(["page.png"]);
    const feedback = readdirSync(join(TASKS_DIR, task.id, "autopilot"), { recursive: true }).find((path) => String(path).endsWith("REVIEW-FEEDBACK.md"))!;
    expect(readFileSync(join(TASKS_DIR, task.id, "autopilot", String(feedback)), "utf8")).toContain("- spinner.gif:");
  });
});

describe("tokens and independence", () => {
  test("A's token dies with A's verdict while B still runs, and B cannot read A's words yet", async () => {
    const { clock, task, rt } = setup();
    await pass(rt, task.id, clock);
    const round = latest(task.id);
    const a = roleOf(round, "primary");
    expect(reviewTokenFor(a.reviewer_task_id!)).toBe(a.token);
    submit(a, { verdict: "fail", findings: [blocker("Secret in the log")] });
    expect(reviewTokenFor(a.reviewer_task_id!)).toBeNull();
    expect(() => submit(roleOf(round, "second"), { verdict: "pass", token: a.token })).toThrow("does not match");
    // not even the kind of verdict: "A: fail" would anchor B as surely as its words
    expect(reviewView(roleOf(round, "primary"), true)).toMatchObject({ state: "submitted", summary: null, findings: [], finishedAt: expect.any(String) });
    expect(reviewView(roleOf(round, "primary"), false)).toMatchObject({ state: "fail", summary: "Checked it" });
  });

  test("a review that ended while its task was being created still has its task linked, so the sweep retires it", () => {
    const author = doneTask();
    const { round, reviews } = createPanelRound({
      taskId: author.id, workflowId: "w-race", pr: 1, head: "a".repeat(40), base: "main", round: 1, counted: true, recipeVersion: null,
      tier: "standard", signals: null, agents: [{ role: "primary", harness: "fake", model: null, effort: null }],
    });
    supersedeRound(round.id, "auto-review stopped for this task");
    const reviewer = createTask({ id: newTaskId(), title: "late reviewer", repo_path: "/fixture/repo", harness: "fake", model: null, slot: freeSlot() });
    created.push(reviewer.id);
    expect(launchedReview(reviews[0]!.id, reviewer.id)).toBe(false);
    expect(getReview(reviews[0]!.id)).toMatchObject({ state: "superseded", reviewer_task_id: reviewer.id });
    expect(unretiredReviews(new Date().toISOString()).map((review) => review.id)).toContain(reviews[0]!.id);
  });
});

describe("the verdict's shape", () => {
  const ctx = { protocol: 2, role: "primary" as const };
  const body = (extra: Record<string, unknown>) => ({ token: "t", summary: "s", ...extra });

  test("a rejection needs a blocking finding, and a pass carries none", () => {
    expect(verdictError(body({ verdict: "fail", findings: [{ ...blocker("x"), severity: "note" }] }), ctx)).toContain("at least one blocking finding");
    expect(verdictError(body({ verdict: "pass", findings: [blocker("x")] }), ctx)).toContain("carries no blocking finding");
    expect(verdictError(body({ verdict: "fail", findings: [blocker("x")] }), ctx)).toBeNull();
  });

  test("a blocker on code names its file and says what goes wrong", () => {
    expect(verdictError(body({ verdict: "fail", findings: [{ ...blocker("x"), file: undefined }] }), ctx)).toContain("names its file");
    expect(verdictError(body({ verdict: "fail", findings: [{ ...blocker("x"), detail: undefined }] }), ctx)).toContain("needs detail");
    expect(verdictError(body({ verdict: "fail", findings: [{ ...blocker("x"), lens: "docs", file: undefined }] }), ctx)).toBeNull();
  });

  test("reviewer B cannot blame the recipe or claim verification; only A escalates", () => {
    const b = { protocol: 2, role: "second" as const };
    expect(verdictError(body({ verdict: "inconclusive", cause: "recipe", recipeFeedback: "x" }), b)).toContain("reviewer B does not run the recipe");
    expect(verdictError(body({ verdict: "pass", findings: [{ title: "y", severity: "note", lens: "verification" }] }), b)).toContain("verifying reviewer's");
    expect(verdictError(body({ verdict: "pass", escalate: { reason: "r" } }), b)).toContain("primary reviewer's");
  });

  test("a reviewer from before the panel answers in the old shape, and it is accepted", () => {
    const legacy = { protocol: 1, role: "primary" as const };
    expect(verdictError(body({ verdict: "fail", findings: [{ title: "x" }] }), legacy)).toBeNull();
    expect(verdictError(body({ verdict: "fail", findings: [{ title: "x", severity: "blocking" }] }), legacy)).toContain("unknown field");
  });
});

describe("the author's side", () => {
  test("the author's note carries the rubric: the same bar both sides work to", () => {
    const task = doneTask();
    setAutopilot(task.id, { autoReview: true });
    const notes = autopilotTurnNotes(task.id).notes.join("\n");
    expect(notes).toContain("only what this diff introduces can block");
    expect(notes).toContain("review rubric");
  });
});

describe("migration 24", () => {
  test("a phase-1 round becomes its primary review, keeping its token, and the delete trigger covers reviews", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, harness TEXT)");
    sqlite.exec("CREATE TABLE workflows (id TEXT PRIMARY KEY)");
    AUTO_REVIEW.up(sqlite);
    sqlite.run("INSERT INTO tasks(id, harness) VALUES ('tauth', 'claude'), ('trev', 'codex')");
    sqlite.run(`INSERT INTO auto_review_rounds(id, task_id, workflow_id, pr, head, round, counted, reviewer_task_id, token, state, created_at)
      VALUES ('rold', 'tauth', 'w1', 7, 'abc', 1, 1, 'trev', 'secret', 'running', '2026-10-01T00:00:00Z')`);
    REVIEW_PANEL.up(sqlite);
    REVIEW_PANEL.up(sqlite);
    const review = sqlite.query("SELECT * FROM round_reviews").get() as Record<string, unknown>;
    expect(review).toMatchObject({ round_id: "rold", role: "primary", protocol: 1, reviewer_task_id: "trev", harness: "codex", token: "secret", state: "running" });
    expect(sqlite.query("SELECT protocol, roles FROM auto_review_rounds").get()).toEqual({ protocol: 1, roles: '["primary"]' });
    sqlite.run("DELETE FROM tasks WHERE id = 'trev'");
    expect(sqlite.query("SELECT reviewer_task_id FROM round_reviews").get()).toEqual({ reviewer_task_id: null });
    sqlite.run("DELETE FROM tasks WHERE id = 'tauth'");
    expect(sqlite.query("SELECT COUNT(*) AS n FROM round_reviews").get()).toEqual({ n: 0 });
  });
});
