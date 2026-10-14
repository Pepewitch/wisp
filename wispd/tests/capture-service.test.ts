import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { samplePng } from "../scripts/harness/image-output-probe";
import { CaptureFailure } from "../src/capture/capture";
import { CaptureRefusal, captureForTask, viewportOf, type CaptureDeps } from "../src/capture/service";
import { capturesOfTask } from "../src/capture/store";
import { LOG_DIR, loadConfig } from "../src/config";
import { parseOutputManifest, publishOutputImage } from "../src/outputs";
import { createTask, createTurn, finishTurn, freeSlot, getTurn, newTaskId, setTaskFields } from "../src/store";
import { portRange, taskEnv } from "../src/turn-input";

function fixture(fields: Record<string, unknown> = {}) {
  const task = createTask({ id: newTaskId(), title: "Capture fixture", repo_path: "/synthetic/repo", harness: "fake", model: null, slot: freeSlot(), ...fields });
  setTaskFields(task.id, { worktree_path: "/synthetic/worktree" });
  const turnId = createTurn(task.id, 1, "Look at the app", null, join(LOG_DIR, `${task.id}-1.log`), null);
  return { task, turnId };
}

const shot = { bytes: samplePng(), mediaType: "image/png" as const, width: 2560, height: 1800, dpr: 2, finalUrl: "http://127.0.0.1:3000/x?session=s3cret#/a", status: 200, errors: ["boom"], blocked: [], settled: true, clipped: false };

function deps(overrides: Partial<CaptureDeps> = {}): CaptureDeps {
  return { cfg: loadConfig(), chrome: () => ({ path: "/fake/chrome" }), shoot: async () => shot, served: async () => "worktree", ...overrides };
}

describe("wisp capture's service", () => {
  test("a capture is stored in the running turn as a published image, with what Wisp saw recorded beside it", async () => {
    const { task, turnId } = fixture();
    const result = await captureForTask(task.id, { url: "http://127.0.0.1:3000/x?session=s3cret", area: "web" }, deps());
    expect(result.failed).toBeUndefined();
    const outputs = parseOutputManifest(getTurn(turnId)!.outputs_json);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ source: "published", mediaType: "image/png", name: "capture-desktop.png" });
    expect(result.imageUrl).toBe(`/api/tasks/${task.id}/outputs/1/${outputs[0]!.id}`);
    expect(result.capture).toMatchObject({
      status: "ok", area: "web", url: "http://127.0.0.1:3000/x?session=*", finalUrl: "http://127.0.0.1:3000/x?session=*#/a",
      httpStatus: 200, servedFrom: "worktree", errors: ["boom"], imageId: outputs[0]!.id,
    });
  });

  test("a failure is a recorded attempt with its reason, not an error the agent can describe its own way", async () => {
    const { task } = fixture();
    const missing = await captureForTask(task.id, { url: "http://localhost:3000/" }, deps({ chrome: () => ({ reason: "no Chrome here" }) }));
    expect(missing).toMatchObject({ failed: true, capture: { status: "failed", reason: "no-chrome", message: "no Chrome here" } });
    const notFound = await captureForTask(task.id, { url: "http://localhost:3000/" }, deps({ shoot: async () => { throw new CaptureFailure("http-error", "the page answered HTTP 404") } }));
    expect(notFound.capture).toMatchObject({ reason: "http-error" });
    expect(capturesOfTask(task.id).map((capture) => capture.reason)).toEqual(["http-error", "no-chrome"]);
  });

  test("the caller's mistakes are refused before anything is recorded", async () => {
    const { task } = fixture();
    const refused = (body: Record<string, unknown>, status: number) => expect(captureForTask(task.id, body as never, deps())).rejects.toMatchObject({ status });
    await refused({ url: "http://example.com/" }, 400);
    await refused({ url: "http://localhost:3000/", viewport: "9999x10" }, 400);
    await refused({ url: "http://localhost:3000/", area: "Not An Area" }, 400);
    await refused({ url: "http://localhost:3000/", allowPorts: [0] }, 400);
    expect(capturesOfTask(task.id)).toHaveLength(0);
  });

  test("only a running turn captures, and a reviewer only with its live review token", async () => {
    const { task, turnId } = fixture();
    finishTurn(turnId, "done", 0, null);
    await expect(captureForTask(task.id, { url: "http://localhost:3000/" }, deps())).rejects.toBeInstanceOf(CaptureRefusal);
    const reviewer = fixture({ verify_role: "reviewer" });
    await expect(captureForTask(reviewer.task.id, { url: "http://localhost:3000/", token: "guess" }, deps())).rejects.toMatchObject({ status: 403 });
  });

  test("the browser may use the page's port, the task's PORT range and --allow-port, and nothing else local", async () => {
    const { task } = fixture({ verify_role: "recipe" });
    let ports: number[] = [];
    await captureForTask(task.id, { url: "http://localhost:3000/", allowPorts: [5432] }, deps({ shoot: async (_request, context) => { ports = context.ports; return shot } }));
    const [low, high] = portRange(task)!;
    expect(ports).toContain(5432);
    expect(ports).toContain(low);
    expect(ports).toContain(high);
    expect(ports).toHaveLength(11);
  });

  test("a second capture in the same task is refused, not recorded as the machine being busy", async () => {
    const { task } = fixture();
    let release = () => {};
    const slow = deps({ shoot: () => new Promise((resolve) => { release = () => resolve(shot) }) });
    const first = captureForTask(task.id, { url: "http://localhost:3000/" }, slow);
    await Bun.sleep(10);
    await expect(captureForTask(task.id, { url: "http://localhost:3000/" }, slow)).rejects.toMatchObject({ status: 409 });
    release();
    await first;
    expect(capturesOfTask(task.id).map((capture) => capture.status)).toEqual(["ok"]);
  });

  test("a turn that ends while the browser works gets no image: the attempt is recorded as cancelled", async () => {
    const { task, turnId } = fixture();
    const result = await captureForTask(task.id, { url: "http://localhost:3000/" }, deps({ shoot: async () => { finishTurn(turnId, "done", 0, null); return shot } }));
    expect(result).toMatchObject({ failed: true, capture: { reason: "cancelled" } });
    expect(parseOutputManifest(getTurn(turnId)!.outputs_json)).toHaveLength(0);
  });

  test("where the page came from is judged on the page now on screen, not the address first opened", async () => {
    const { task } = fixture();
    const asked: number[] = [];
    const served = async (port: number) => { asked.push(port); return port === 3000 ? "worktree" as const : "elsewhere" as const };
    const moved = await captureForTask(task.id, { url: "http://localhost:3000/" }, deps({ served, shoot: async () => ({ ...shot, finalUrl: "http://127.0.0.1:4000/elsewhere" }) }));
    expect(moved.capture.servedFrom).toBe("elsewhere");
    expect(asked).toEqual([4000]);
    const offMachine = await captureForTask(task.id, { url: "http://localhost:3000/" }, deps({ served, shoot: async () => ({ ...shot, finalUrl: "https://example.com/" }) }));
    expect(offMachine.capture.servedFrom).toBe("elsewhere");
  });

  test("a shot that cannot be stored is a recorded attempt", async () => {
    const { task, turnId } = fixture();
    // fill the turn's image quota with distinct images, so the capture's own publication is refused
    for (let i = 0; i < 32; i++) publishOutputImage(turnId, Buffer.concat([samplePng(), Buffer.from([i])]), `filler-${i}.png`, "published");
    const result = await captureForTask(task.id, { url: "http://localhost:3000/" }, deps({ shoot: async () => ({ ...shot, bytes: Buffer.concat([samplePng(), Buffer.from("x")]) }) }));
    expect(result).toMatchObject({ failed: true, capture: { reason: "storage" } });
  });

  test("viewports", () => {
    expect(viewportOf(undefined)).toMatchObject({ width: 1280, mobile: false });
    expect(viewportOf("mobile")).toMatchObject({ width: 390, mobile: true });
    expect(viewportOf("800x600")).toEqual({ width: 800, height: 600, mobile: false });
    expect(() => viewportOf("3000x600")).toThrow("viewport");
  });
});

describe("ports for reviewer and recipe tasks", () => {
  test("a verify-role task gets PORT and WISP_PORT_RANGE; an author task does not", () => {
    const reviewer = fixture({ verify_role: "reviewer" }).task;
    const env = taskEnv(reviewer);
    const base = 20_000 + reviewer.slot * 10;
    expect(env).toMatchObject({ PORT: String(base), WISP_PORT_RANGE: `${base}-${base + 9}` });
    expect(taskEnv(fixture().task)).not.toHaveProperty("PORT");
  });
});
