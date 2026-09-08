import type { WispConfig } from "./config";
import { markAttempt, markDelivered, pendingOutbox } from "./store";

/**
 * One delivery pass over every due outbox row, exported so tests can drive it
 * directly against a stub server instead of waiting on the 5s loop.
 *
 * At-least-once semantics with a known sharp edge (the outbox regression case):
 * delivery is tracked per ROW, not per URL. One failing URL therefore forces
 * redelivery to the URLs that already accepted the event — healthy consumers
 * will see duplicates and must dedup on (task_id, seq). Per-URL tracking
 * isn't worth the additional schema for this local daemon.
 */
export async function deliverOutbox(cfg: WispConfig): Promise<void> {
  for (const row of pendingOutbox()) {
    if (cfg.webhooks.length === 0) {
      markDelivered(row.id);
      continue;
    }
    let lastErr = "";
    let allOk = true;
    for (const url of cfg.webhooks) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: row.payload,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          allOk = false;
          lastErr = `${url}: HTTP ${res.status}`;
        }
      } catch (e) {
        allOk = false;
        lastErr = `${url}: ${String(e instanceof Error ? e.message : e)}`;
      }
    }
    if (allOk) markDelivered(row.id);
    else markAttempt(row.id, row.attempts + 1, lastErr);
  }
}

/**
 * At-least-once webhook delivery. Rows are written atomically with their state
 * transition (store.transition); this loop retries with backoff until every
 * configured URL has accepted the event. Consumers dedup on (task_id, seq).
 */
export function startOutboxLoop(cfg: WispConfig): ReturnType<typeof setInterval> {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // don't overlap slow deliveries
    running = true;
    try {
      await deliverOutbox(cfg);
    } finally {
      running = false;
    }
  }, 5000);
  timer.unref?.();
  return timer;
}
