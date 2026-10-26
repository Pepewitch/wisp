/**
 * A turn that ended because the provider itself could not serve it: a 5xx
 * answer, an overload, "service unavailable". Harness-agnostic like
 * network.ts, and for the same reason: an outage is the same event whichever
 * CLI was talking, and every builtin passes the provider's status and words
 * through to the failure detail its error strategy extracts (claude's
 * "API Error: 503 …", codex's `"status":503`). An adapter's own
 * `transientMarkers` stay its narrower, captured list; this one only answers
 * whether another agent could have done the turn instead (verify/fallback.ts).
 *
 * Credentials, quotas and limits never count, whatever else the words say
 * (network.ts cannotRetry).
 */
import { cannotRetry } from "./network";

const OUTAGE_WORDS = [
  "service unavailable", "service_unavailable", "temporarily unavailable", "overloaded", "bad gateway", "gateway timeout",
  "internal server error", "internal_server_error", "upstream connect error",
];

/** A 5xx status where a provider's answer names one: `API Error: 503`, `status 502`, `"status":529`, `HTTP 500`. */
const OUTAGE_STATUS = /\b(?:api error|status|http)\b[^0-9\n]{0,12}5(?:0[0234]|29)\b/;

/** True when a failure detail says the provider was unavailable. */
export function isProviderOutage(detail: string | null): boolean {
  if (detail === null) return false;
  const normalized = detail.toLowerCase();
  if (cannotRetry(normalized)) return false;
  return OUTAGE_STATUS.test(normalized) || OUTAGE_WORDS.some((word) => normalized.includes(word));
}
