import { afterAll, describe, expect, spyOn, test } from "bun:test";
import type { WispConfig } from "../src/config";
import { deliverOutbox, redactWebhookUrl, WEBHOOK_MAX_AGE_MS, WEBHOOK_MAX_ATTEMPTS } from "../src/outbox";
import { createTask, db, freeSlot, newTaskId, outboxSummary, pendingOutbox, transition, undeliveredOutbox } from "../src/store";
import type { OutboxRow, TaskState } from "../src/types";

const baseCfg: WispConfig = {
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

/** A throwaway webhook endpoint: records every POST body, status is reconfigurable mid-test. */
function stubWebhook() {
  const received: string[] = [];
  let status = 200;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      received.push(await req.text());
      return new Response("stub", { status });
    },
  });
  servers.push(server);
  return {
    received,
    url: `http://127.0.0.1:${server.port}/hook`,
    setStatus(s: number) {
      status = s;
    },
    stop() {
      server.stop(true);
    },
  };
}

const servers: ReturnType<typeof Bun.serve>[] = [];
const taskIds: string[] = [];

afterAll(() => {
  for (const s of servers) s.stop(true);
  for (const taskId of taskIds) {
    db.run("DELETE FROM outbox WHERE task_id = ?", [taskId]);
    db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
  }
});

/** Create a real outbox row the way production does: a notify-worthy transition. */
function makeRow(event: TaskState = "done"): OutboxRow {
  const task = createTask({
    id: newTaskId(),
    title: "outbox test",
    repo_path: "/tmp/repo",
    harness: "fake",
    model: null,
    slot: freeSlot(),
  });
  taskIds.push(task.id);
  transition(task.id, event, "test detail");
  return undeliveredOutbox().find((r) => r.task_id === task.id)!;
}

const rowById = (id: number) => undeliveredOutbox().find((r) => r.id === id);

/** Rewind a row's next_attempt_at so the next delivery pass picks it up despite backoff. */
function forceDue(id: number): void {
  db.run(`UPDATE outbox SET next_attempt_at = ? WHERE id = ?`, [new Date(Date.now() - 60_000).toISOString(), id]);
}

/** Silence and collect the daemon log; restoring a spy also clears its calls, so they are copied out. */
function captureErrors(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  return { lines, restore: () => spy.mockRestore() };
}

/** Seconds until the row's next scheduled attempt, measured from right now. */
function retryInSec(row: OutboxRow): number {
  return (new Date(row.next_attempt_at).getTime() - Date.now()) / 1000;
}

describe("deliverOutbox against a stub server (the outbox regression case)", () => {
  test("delivers the row to every configured URL and marks it delivered", async () => {
    const a = stubWebhook();
    const b = stubWebhook();
    const row = makeRow("done");

    await deliverOutbox({ ...baseCfg, webhooks: [a.url, b.url] }, row.task_id);

    expect(a.received.length).toBe(1);
    expect(b.received.length).toBe(1);
    expect(JSON.parse(a.received[0]!)).toMatchObject({
      task_id: row.task_id, seq: row.seq, state: "done", harness: "fake", title: "outbox test", detail: "test detail",
    });
    expect(rowById(row.id)).toBeUndefined(); // delivered rows leave the pending set
  });

  test("with no webhooks configured, rows drain immediately", async () => {
    const row = makeRow("failed");

    await deliverOutbox(baseCfg, row.task_id);

    expect(rowById(row.id)).toBeUndefined();
  });

  test("a task-scoped pass is not hidden behind the global batch limit", async () => {
    const older = Array.from({ length: 21 }, () => makeRow());
    const target = makeRow();

    await deliverOutbox(baseCfg, target.task_id);

    expect(rowById(target.id)).toBeUndefined();
    expect(older.every((row) => rowById(row.id) !== undefined)).toBe(true);
  });

  test("a failing URL schedules a retry with backoff and records last_error", async () => {
    const bad = stubWebhook();
    bad.setStatus(500);
    const row = makeRow();
    const cfg = { ...baseCfg, webhooks: [bad.url] };

    await deliverOutbox(cfg, row.task_id);

    const after = rowById(row.id)!;
    expect(after).toBeDefined(); // still pending
    expect(after.attempts).toBe(1);
    expect(after.last_error).toContain(`webhook 1 (${new URL(bad.url).origin}/…)`); // redacted, never the full URL
    expect(after.last_error).not.toContain(bad.url);
    expect(after.last_error).toContain("HTTP 500");
    // first backoff: 2^1 * 5 = 10s
    expect(retryInSec(after)).toBeGreaterThan(8);
    expect(retryInSec(after)).toBeLessThanOrEqual(10.5);

    // ...and the row is NOT retried before that time comes
    await deliverOutbox(cfg, row.task_id);
    expect(bad.received.length).toBe(1);
  });

  test("backoff doubles per attempt and is capped at 15 minutes", async () => {
    const bad = stubWebhook();
    bad.setStatus(500);
    const row = makeRow();
    const cfg = { ...baseCfg, webhooks: [bad.url] };

    await deliverOutbox(cfg, row.task_id); // attempt 1 → 10s
    forceDue(row.id);
    await deliverOutbox(cfg, row.task_id); // attempt 2 → 20s
    const second = rowById(row.id)!;
    expect(second.attempts).toBe(2);
    expect(retryInSec(second)).toBeGreaterThan(18);
    expect(retryInSec(second)).toBeLessThanOrEqual(20.5);

    // simulate a row that has already failed 10 times: 2^11 * 5s would be ~2.8h
    db.run(`UPDATE outbox SET attempts = 10 WHERE id = ?`, [row.id]);
    forceDue(row.id);
    await deliverOutbox(cfg, row.task_id);
    const capped = rowById(row.id)!;
    expect(capped.attempts).toBe(11);
    expect(retryInSec(capped)).toBeGreaterThan(895);
    expect(retryInSec(capped)).toBeLessThanOrEqual(900.5); // min(backoff, 900s)
  });

  test("partial failure: one bad URL forces redelivery to the healthy ones (at-least-once)", async () => {
    const good = stubWebhook();
    const bad = stubWebhook();
    bad.setStatus(500);
    const cfg = { ...baseCfg, webhooks: [good.url, bad.url] };
    const row = makeRow("needs-input");

    await deliverOutbox(cfg, row.task_id);

    expect(good.received.length).toBe(1); // the healthy URL accepted the event...
    expect(rowById(row.id)).toBeDefined(); // ...but the ROW stays undelivered:
    expect(rowById(row.id)!.last_error).toContain("HTTP 500");
    // delivery is tracked per row, not per URL — one bad URL blocks them all.

    bad.setStatus(200); // the bad URL recovers
    forceDue(row.id);
    await deliverOutbox(cfg, row.task_id);

    expect(rowById(row.id)).toBeUndefined(); // delivered now
    // ...and the retry went to EVERY url, so the healthy consumer sees the
    // same event twice and must dedup on (task_id, seq) — the at-least-once contract
    expect(good.received.length).toBe(2);
    expect(good.received[0]).toBe(good.received[1]);
    expect(bad.received.length).toBe(2);
  });

  test("transport errors (not just HTTP statuses) surface in last_error", async () => {
    const dead = stubWebhook();
    const url = dead.url;
    dead.stop(); // nothing is listening now — fetch will refuse the connection
    const row = makeRow();

    await deliverOutbox({ ...baseCfg, webhooks: [url] }, row.task_id);

    const after = rowById(row.id)!;
    expect(after.attempts).toBe(1);
    expect(after.last_error).toContain(new URL(url).origin);
    expect(after.last_error).not.toContain(url);
    expect(after.last_error).not.toContain("HTTP"); // a connection error, not a status line
  });

  test("a redirect is refused, not followed, so the payload never reaches the Location", async () => {
    const elsewhere = stubWebhook();
    const redirecting = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(null, { status: 307, headers: { location: elsewhere.url } }),
    });
    servers.push(redirecting);
    const row = makeRow();

    await deliverOutbox({ ...baseCfg, webhooks: [`http://127.0.0.1:${redirecting.port}/hook`] }, row.task_id);

    expect(elsewhere.received).toEqual([]);
    const after = rowById(row.id)!;
    expect(after.attempts).toBe(1);
    expect(after.last_error).toContain("HTTP 307 redirect refused");
  });

  test("a URL's secrets never reach last_error or the log", async () => {
    const bad = stubWebhook();
    bad.setStatus(500);
    const port = new URL(bad.url).port;
    const secretUrl = `http://someone:hunter2@127.0.0.1:${port}/services/T0/B0/pathsecret?token=querysecret`;
    const row = makeRow();
    const logged = captureErrors();
    try {
      await deliverOutbox({ ...baseCfg, webhooks: [secretUrl] }, row.task_id);
    } finally {
      logged.restore();
    }
    const lines = logged.lines;
    const stored = rowById(row.id)!.last_error!;
    for (const text of [stored, ...lines]) {
      for (const secret of ["hunter2", "someone", "pathsecret", "querysecret"]) expect(text).not.toContain(secret);
    }
    expect(stored).toContain(`http://127.0.0.1:${port}/…`);
    expect(lines.some((line) => line.includes("[wisp] webhook delivery") && line.includes("HTTP 500"))).toBe(true);
  });

  test("a URL that keeps failing is logged once, not once per attempt", async () => {
    const bad = stubWebhook();
    bad.setStatus(502);
    const row = makeRow();
    const cfg = { ...baseCfg, webhooks: [bad.url] };
    const logged = captureErrors();
    try {
      await deliverOutbox(cfg, row.task_id);
      forceDue(row.id);
      await deliverOutbox(cfg, row.task_id);
    } finally {
      logged.restore();
    }
    expect(bad.received.length).toBe(2);
    const reports = logged.lines.filter((line) => line.includes(new URL(bad.url).origin));
    expect(reports.length).toBe(1);
  });

  test("delivery gives up after the attempt limit, marks the event dead, and never retries it", async () => {
    const bad = stubWebhook();
    bad.setStatus(500);
    const row = makeRow();
    const cfg = { ...baseCfg, webhooks: [bad.url] };
    db.run(`UPDATE outbox SET attempts = ? WHERE id = ?`, [WEBHOOK_MAX_ATTEMPTS - 1, row.id]);
    forceDue(row.id);
    const logged = captureErrors();
    try {
      await deliverOutbox(cfg, row.task_id);
    } finally {
      logged.restore();
    }

    const dead = rowById(row.id)!; // still listed as undelivered, for inspection
    expect(dead.attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
    expect(dead.dead_at).not.toBeNull();
    expect(dead.last_error).toContain("HTTP 500");
    expect(logged.lines.some((line) => line.includes("webhook delivery gave up on an event"))).toBe(true);
    expect(pendingOutbox(row.task_id)).toEqual([]);

    forceDue(row.id);
    await deliverOutbox(cfg, row.task_id);
    expect(bad.received.length).toBe(1); // never again
    const summary = outboxSummary();
    expect(summary.dead).toBeGreaterThanOrEqual(1);
    expect(summary.lastError).not.toBeNull();
  });

  test("delivery gives up on an event older than the age limit, whatever its attempt count", async () => {
    const bad = stubWebhook();
    bad.setStatus(500);
    const row = makeRow();
    db.run(`UPDATE outbox SET created_at = ? WHERE id = ?`, [new Date(Date.now() - WEBHOOK_MAX_AGE_MS - 60_000).toISOString(), row.id]);
    const logged = captureErrors();
    try {
      await deliverOutbox({ ...baseCfg, webhooks: [bad.url] }, row.task_id);
    } finally {
      logged.restore();
    }
    expect(rowById(row.id)!.attempts).toBe(1);
    expect(rowById(row.id)!.dead_at).not.toBeNull();
  });

  test("a failing event is counted for doctor until it is delivered", async () => {
    const bad = stubWebhook();
    bad.setStatus(500);
    const row = makeRow();
    const cfg = { ...baseCfg, webhooks: [bad.url] };
    const before = outboxSummary().failing;
    const logged = captureErrors();
    try {
      await deliverOutbox(cfg, row.task_id);
      expect(outboxSummary().failing).toBe(before + 1);
      bad.setStatus(200);
      forceDue(row.id);
      await deliverOutbox(cfg, row.task_id);
    } finally {
      logged.restore();
    }
    expect(outboxSummary().failing).toBe(before);
  });
});

describe("redactWebhookUrl", () => {
  test("keeps the origin and drops the path, query, fragment and userinfo", () => {
    expect(redactWebhookUrl("https://hooks.example.com/services/T0/B0/secret")).toBe("https://hooks.example.com/…");
    expect(redactWebhookUrl("https://user:pass@example.com:8443/?key=secret#frag")).toBe("https://example.com:8443/…");
    expect(redactWebhookUrl("https://example.com")).toBe("https://example.com");
    expect(redactWebhookUrl("not a url")).toBe("(an invalid URL)");
  });
});
