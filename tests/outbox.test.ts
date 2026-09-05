import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { WispConfig } from "../src/config";
import { deliverOutbox } from "../src/outbox";
import { createTask, db, freeSlot, newTaskId, transition, undeliveredOutbox } from "../src/store";
import type { OutboxRow, TaskState } from "../src/types";

const baseCfg: WispConfig = {
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

beforeAll(() => {
  // the test db may be shared with other files in this process; retire any
  // rows they left behind so delivery passes here only touch this file's rows
  db.run(`UPDATE outbox SET delivered_at = ? WHERE delivered_at IS NULL`, [new Date().toISOString()]);
});

afterAll(() => {
  for (const s of servers) s.stop(true);
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
  transition(task.id, event, "test detail");
  return undeliveredOutbox().find((r) => r.task_id === task.id)!;
}

const rowById = (id: number) => undeliveredOutbox().find((r) => r.id === id);

/** Rewind a row's next_attempt_at so the next delivery pass picks it up despite backoff. */
function forceDue(id: number): void {
  db.run(`UPDATE outbox SET next_attempt_at = ? WHERE id = ?`, [new Date(Date.now() - 60_000).toISOString(), id]);
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

    await deliverOutbox({ ...baseCfg, webhooks: [a.url, b.url] });

    expect(a.received.length).toBe(1);
    expect(b.received.length).toBe(1);
    expect(JSON.parse(a.received[0]!)).toMatchObject({ task_id: row.task_id, seq: row.seq, state: "done" });
    expect(rowById(row.id)).toBeUndefined(); // delivered rows leave the pending set
  });

  test("with no webhooks configured, rows drain immediately", async () => {
    const row = makeRow("failed");

    await deliverOutbox(baseCfg);

    expect(rowById(row.id)).toBeUndefined();
  });

  test("a failing URL schedules a retry with backoff and records last_error", async () => {
    const bad = stubWebhook();
    bad.setStatus(500);
    const row = makeRow();
    const cfg = { ...baseCfg, webhooks: [bad.url] };

    await deliverOutbox(cfg);

    const after = rowById(row.id)!;
    expect(after).toBeDefined(); // still pending
    expect(after.attempts).toBe(1);
    expect(after.last_error).toContain(bad.url);
    expect(after.last_error).toContain("HTTP 500");
    // first backoff: 2^1 * 5 = 10s
    expect(retryInSec(after)).toBeGreaterThan(8);
    expect(retryInSec(after)).toBeLessThanOrEqual(10.5);

    // ...and the row is NOT retried before that time comes
    await deliverOutbox(cfg);
    expect(bad.received.length).toBe(1);
  });

  test("backoff doubles per attempt and is capped at 15 minutes", async () => {
    const bad = stubWebhook();
    bad.setStatus(500);
    const row = makeRow();
    const cfg = { ...baseCfg, webhooks: [bad.url] };

    await deliverOutbox(cfg); // attempt 1 → 10s
    forceDue(row.id);
    await deliverOutbox(cfg); // attempt 2 → 20s
    const second = rowById(row.id)!;
    expect(second.attempts).toBe(2);
    expect(retryInSec(second)).toBeGreaterThan(18);
    expect(retryInSec(second)).toBeLessThanOrEqual(20.5);

    // simulate a row that has already failed 10 times: 2^11 * 5s would be ~2.8h
    db.run(`UPDATE outbox SET attempts = 10 WHERE id = ?`, [row.id]);
    forceDue(row.id);
    await deliverOutbox(cfg);
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

    await deliverOutbox(cfg);

    expect(good.received.length).toBe(1); // the healthy URL accepted the event...
    expect(rowById(row.id)).toBeDefined(); // ...but the ROW stays undelivered:
    expect(rowById(row.id)!.last_error).toContain("HTTP 500");
    // delivery is tracked per row, not per URL — one bad URL blocks them all.

    bad.setStatus(200); // the bad URL recovers
    forceDue(row.id);
    await deliverOutbox(cfg);

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

    await deliverOutbox({ ...baseCfg, webhooks: [url] });

    const after = rowById(row.id)!;
    expect(after.attempts).toBe(1);
    expect(after.last_error).toContain(url);
    expect(after.last_error).not.toContain("HTTP"); // a connection error, not a status line
  });
});
