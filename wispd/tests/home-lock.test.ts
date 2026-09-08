/**
 * One owner per Wisp home (ENG-02).
 *
 * The reproduction this is built around: a review started two daemons against
 * one home and both came up healthy, because the only check was "is my
 * configured address free?" — asked with a probe listener that was released
 * before recovery ran. The second daemon's boot recovery then flipped the
 * first daemon's live `creating` task to `failed`.
 *
 * So the assertions are not just "the second one refuses". They are that it
 * refuses HAVING CHANGED NOTHING, that a separate process refuses too, and
 * that ownership is genuinely released when the owner stops — otherwise the
 * fix would trade a correctness bug for an unstartable daemon.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_PATH } from "../src/config";
import { serve } from "../src/daemon";
import { acquireHomeOwnership, HomeBusyError, ownsHome } from "../src/home-lock";
import { createTask, freeSlot, getTask, newTaskId } from "../src/store";

const TOKEN = "home-lock-token";
let server: Awaited<ReturnType<typeof serve>> | null = null;

afterEach(async () => {
  if (server) await server.stop(true);
  server = null;
});

/**
 * A port no test binds. Ownership is refused before any bind, so this only
 * matters if that ordering ever regresses — in which case a stray listener on
 * a made-up port is a much better outcome than one on the operator's.
 */
const UNUSED_PORT = 39_871;

function writeConfig(): void {
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      instanceId: "123e4567-e89b-42d3-a456-426614174000",
      port: UNUSED_PORT,
      host: "127.0.0.1",
      token: TOKEN,
      webhooks: [],
      stuckMinutes: 10,
      logMaxBytes: 5_000_000,
      setupTimeoutMinutes: 10,
      envAllowlist: {},
      harnessDefaults: {},
    }),
  );
}

/** A task mid-creation, made AFTER the owner booted so only a second boot could touch it. */
function creatingTask(): string {
  const id = newTaskId();
  createTask({
    id,
    title: "mid-creation when the second daemon started",
    repo_path: "/tmp/repo",
    harness: "fake",
    model: null,
    slot: freeSlot(),
  });
  expect(getTask(id)!.state).toBe("creating");
  return id;
}

describe("the home lock itself", () => {
  test("a second acquisition is refused, and a released one can be retaken", () => {
    const first = acquireHomeOwnership();
    expect(ownsHome()).toBe(true);
    expect(() => acquireHomeOwnership()).toThrow(HomeBusyError);
    first.release();
    expect(ownsHome()).toBe(false);

    const second = acquireHomeOwnership();
    expect(ownsHome()).toBe(true);
    second.release();
  });

  test("releasing twice is harmless", () => {
    const ownership = acquireHomeOwnership();
    ownership.release();
    ownership.release();
    expect(ownsHome()).toBe(false);
    acquireHomeOwnership().release();
  });
});

describe("a second daemon in this process", () => {
  test("is refused, changes nothing, and says what to do", async () => {
    writeConfig();
    server = await serve({ port: 0 });
    const taskId = creatingTask();

    const message = await serve({ port: 0 }).then(
      () => "the second daemon was allowed to start",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(message).toContain("already being served");
    expect(message).toContain("changed no tasks");
    // The reproduction, inverted: boot recovery must not have run.
    expect(getTask(taskId)!.state).toBe("creating");
  }, 20_000);

  test("ownership is released when the owner stops, so the next daemon can start", async () => {
    writeConfig();
    const first = await serve({ port: 0 });
    await first.stop(true);

    server = await serve({ port: 0 });
    expect(server.port).toBeGreaterThan(0);
  }, 20_000);
});

describe("a second daemon in another process", () => {
  /**
   * The case an in-process check could never catch. `WISP_HOME` is inherited,
   * so the child is aimed at exactly this home; the assertion is that it exits
   * without having reconciled anything.
   */
  test("exits refusing the home, leaving live state alone", async () => {
    writeConfig();
    server = await serve({ port: 0 });
    const taskId = creatingTask();

    const child = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "../src/index.ts"), "serve"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const output = `${stdout}\n${stderr}`;

    expect(exitCode).not.toBe(0);
    expect(output).toContain("already being served");
    expect(output).not.toContain("wispd listening");
    expect(getTask(taskId)!.state).toBe("creating");
  }, 40_000);
});
