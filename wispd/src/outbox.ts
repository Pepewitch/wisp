import { logFailure } from "./failure-log";
import { backgroundPass } from "./home-lifetime";
import type { WispConfig } from "./config";
import { getTask, markAttempt, markDead, markDelivered, pendingOutbox } from "./store";
import type { OutboxRow } from "./types";

const activeTasks = new Set<string>();
export const taskDeliveryActive = (id: string): boolean => activeTasks.has(id);

/**
 * When delivery gives up on an event: after this many failed attempts, or
 * once the event is this old, whichever comes first. With backoff doubling
 * from 10 s to its 15-minute ceiling, the two land about a day apart from the
 * first failure: long enough to ride out a consumer that is down overnight,
 * short enough that a typo'd URL stops being retried.
 */
export const WEBHOOK_MAX_ATTEMPTS = 100;
export const WEBHOOK_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * A webhook URL as it may be stored or logged: its origin, and "/…" when it
 * had more. Chat-style incoming webhooks carry their secret in the path, and
 * others in the query or userinfo, so none of those three is kept. Which URL
 * failed stays identifiable by its host and its position in `webhooks`.
 */
export function redactWebhookUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "(an invalid URL)";
  }
  if (parsed.origin === "null") return `${parsed.protocol}…`;
  const more = parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "" || parsed.username !== "" || parsed.password !== "";
  return `${parsed.origin}${more ? "/…" : ""}`;
}

/** An error message with every spelling of the URL it may quote replaced by the redacted one. */
function scrubbed(message: string, url: string, redacted: string): string {
  const spellings = [url];
  try {
    spellings.push(new URL(url).href); // the normalized form an error may quote instead
  } catch {
    // an unparseable URL has only the spelling it was configured with
  }
  return spellings.filter(Boolean).reduce((out, spelling) => out.split(spelling).join(redacted), message);
}

/**
 * POST one event to one URL. Redirects are refused, not followed: a 307 or
 * 308 would re-send the payload (task title, state detail) to wherever the
 * Location header points, so a 3xx is a failure like any other status.
 * Returns the failure, with the URL redacted, or null on success.
 */
async function post(url: string, index: number, payload: string): Promise<string | null> {
  const redacted = redactWebhookUrl(url);
  const label = `webhook ${index + 1} (${redacted})`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status >= 300 && res.status < 400) return `${label}: HTTP ${res.status} redirect refused (webhooks are not redirected)`;
    if (!res.ok) return `${label}: HTTP ${res.status}`;
    return null;
  } catch (e) {
    return `${label}: ${scrubbed(e instanceof Error ? e.message : String(e), url, redacted)}`;
  }
}

/**
 * The age limit runs from the event's FIRST FAILURE, not its creation: a
 * laptop that slept past the limit must not retire every event it queued on
 * its first attempt after waking.
 */
function givesUp(row: OutboxRow, attempts: number, nowMs: number): boolean {
  const firstFailed = row.first_failed_at === null ? nowMs : Date.parse(row.first_failed_at);
  return attempts >= WEBHOOK_MAX_ATTEMPTS || (Number.isFinite(firstFailed) && nowMs - firstFailed >= WEBHOOK_MAX_AGE_MS);
}

/**
 * One delivery pass over every due outbox row, exported so tests can drive it
 * directly against a stub server instead of waiting on the 5s loop.
 *
 * At-least-once semantics with a known sharp edge (the outbox regression case):
 * delivery is tracked per ROW, not per URL. One failing URL therefore forces
 * redelivery to the URLs that already accepted the event — healthy consumers
 * will see duplicates and must dedup on (task_id, seq). Per-URL tracking
 * isn't worth the additional schema for this local daemon.
 *
 * A failure is logged through logFailure, so a URL that keeps failing is
 * reported once in full and then summarized, not once per row per pass.
 */
export async function deliverOutbox(cfg: WispConfig, onlyTaskId?: string): Promise<void> {
  for (const row of pendingOutbox(onlyTaskId)) {
    if (!getTask(row.task_id) || getTask(row.task_id)?.purge_pending || activeTasks.has(row.task_id)) continue;
    activeTasks.add(row.task_id);
    try {
      if (cfg.webhooks.length === 0) {
        markDelivered(row.id);
        continue;
      }
      let lastErr = "";
      for (const [index, url] of cfg.webhooks.entries()) {
        const failure = await post(url, index, row.payload);
        if (failure === null) continue;
        lastErr = failure;
        logFailure("webhook delivery", failure);
      }
      if (lastErr === "") {
        markDelivered(row.id);
        continue;
      }
      const attempts = row.attempts + 1;
      if (givesUp(row, attempts, Date.now())) {
        markDead(row.id, attempts, lastErr);
        logFailure(
          `webhook delivery gave up on an event after ${WEBHOOK_MAX_ATTEMPTS} attempts or ${WEBHOOK_MAX_AGE_MS / 3_600_000} h of failing; it stays in GET /api/outbox`,
          lastErr,
          Date.now(),
          `task ${row.task_id} seq ${row.seq}, attempt ${attempts}`,
        );
      } else markAttempt(row.id, attempts, lastErr);
    } finally { activeTasks.delete(row.task_id); }
  }
}

/**
 * At-least-once webhook delivery. Rows are written atomically with their state
 * transition (store.transition); this loop retries with backoff until every
 * configured URL has accepted the event, or gives up on it (see
 * WEBHOOK_MAX_ATTEMPTS). Consumers dedup on (task_id, seq).
 */
export function startOutboxLoop(cfg: WispConfig): ReturnType<typeof setInterval> {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // don't overlap slow deliveries
    running = true;
    try {
      await backgroundPass("webhook delivery", () => deliverOutbox(cfg), { loop: true });
    } finally {
      running = false;
    }
  }, 5000);
  timer.unref?.();
  return timer;
}
