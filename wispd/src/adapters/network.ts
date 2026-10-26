/**
 * A turn that ended because this machine lost its connection to the provider,
 * told apart from every other failure. Harness-agnostic on purpose: one list
 * read against any harness's extracted failure detail, because a dropped
 * network is the same event whichever CLI was talking. It holds the operating
 * system's own words, which every harness passes through in some form, and
 * each builtin's words for the same outage, taken from offline captures
 * (tests/fixtures/network-outages.json and network-live-frames.json): runs
 * with every route to a provider blocked, so no request ever left the machine.
 *
 * A match prefixes the task's state_detail with `network: ` (turn-finalize.ts),
 * which autopilot reads as a pause it may resume (autopilot/network.ts).
 */

export const NETWORK_PREFIX = "network: ";

const NETWORK_MARKERS = [
  // the operating system's error codes and words
  "enotfound", "eai_again", "econnrefused", "econnreset", "econnaborted", "etimedout",
  "enetunreach", "enetdown", "ehostunreach", "getaddrinfo", "connection refused", "connection reset",
  "network is unreachable", "failed to lookup address", "dns error",
  // claude: "Can't reach the API server" and its API Error wordings
  "can't reach the api server", "unable to connect to api", "api error: connection error",
  // droid: the provider SDK's connection failure (exec), and how its live JSON-RPC turn ends on one
  "connection error.", "model_provider_unreachable",
  // opencode: "Cannot connect to API: Unable to connect. Is the computer able to access the url?"
  "cannot connect to api",
  // codex: its transport gave up ("Reconnecting... 5/5" before it), or a request never left
  "workspace routing discovery failed", "stream disconnected before completion", "error sending request for url",
];

/**
 * Words that make a failure something a retry cannot fix, whatever else the
 * detail mentions: credentials, plan limits and quotas. A login that fails
 * because the network is down still reads as a login failure here — Wisp
 * never retries one.
 */
const NEVER_NETWORK = [
  /\b40[1-3]\b/, /\b429\b/, /unauthori[sz]ed/, /forbidden/, /authenticat/, /api[ -_]?key/, /\/login\b/, /log ?in again/,
  /oauth/, /token (?:has )?expired/, /usage limit/, /rate[ _-]?limit/, /quota/, /credit/, /billing/,
];

/** Credentials, plan limits or quotas in a lowercased failure detail: no retry, and no other agent's turn, fixes those. */
export function cannotRetry(normalized: string): boolean {
  return NEVER_NETWORK.some((pattern) => pattern.test(normalized));
}

/**
 * True when a failed turn ended on the network. `exitCode` is the harness's
 * own: a turn that died to a signal (128 and up) did not end on the network,
 * whatever its last words were. Null is an exit Wisp did not see — a live
 * turn settled while its process lingers, or one recovered after a restart —
 * and its words decide.
 */
export function isNetworkFailure(detail: string | null, exitCode: number | null): boolean {
  if (detail === null || (exitCode !== null && exitCode >= 128)) return false;
  const normalized = detail.toLowerCase();
  if (cannotRetry(normalized)) return false;
  return NETWORK_MARKERS.some((marker) => normalized.includes(marker));
}

/** A task detail turn-finalize.ts wrote for a turn that ended on the network. */
export function isNetworkDetail(detail: string | null): boolean {
  return detail?.startsWith(NETWORK_PREFIX) === true;
}
