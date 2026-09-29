import { createHash, timingSafeEqual } from "node:crypto";
import type { WispConfig } from "../config";
import { boundedJsonObjectBody, err, json } from "./http";

/**
 * Constant-time token comparison. Both sides are hashed first, so the
 * compared digests are equal-length by construction (timingSafeEqual needs
 * that, and the hash erases the length signal a raw compare would leak). A
 * bearer token over localhost is low-exposure, but the comparison is one
 * line — there is no reason for it to be naive.
 */
function tokenMatches(given: string, expected: string): boolean {
  return timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(expected).digest());
}

/**
 * The daemon accepts exactly ONE credential: the bearer token, in the
 * Authorization header. Nothing ambient.
 *
 * It used to also accept `wisp_token`, an HttpOnly cookie whose value WAS the
 * root token, because EventSource and WebSocket cannot set headers. A security
 * review named the consequence: cookies are scoped to host and path, never to
 * port (RFC 6265 §8.5–8.6), so any other HTTP service on 127.0.0.1 — a dev
 * server, something behind a local tunnel — received the daemon's full-control
 * token in its Cookie header and could replay it as a bearer credential.
 * Renaming it, restricting its path, or making it opaque would not have
 * changed that: the flaw was ambient authority on a shared host, not the
 * cookie's shape.
 *
 * The browser therefore carries the token itself now: `fetch` streaming for
 * SSE (headers welcome), an authenticated fetch to a blob URL for media, and
 * an in-band handshake for the terminal socket. Tokens in URL query params
 * stay BANNED — they leak into logs and browser history (a prior audit).
 */
export function authorized(req: Request, cfg: WispConfig): boolean {
  const token = bearerToken(req);
  return token !== null && tokenMatches(token, cfg.token);
}

/**
 * The same check for a credential that arrives in a message body rather than a
 * header — the terminal socket's first frame. A browser cannot put a header on
 * a WebSocket handshake, and the alternatives were worse: a cookie is the
 * cross-port leak above, and a query parameter is the banned one. So the socket
 * upgrades with no authority at all and spawns nothing until this passes.
 */
export function tokenAuthorizes(token: unknown, cfg: WispConfig): boolean {
  return typeof token === "string" && token !== "" && tokenMatches(token, cfg.token);
}

/** The address a failed credential is counted against. */
export function remoteAddress(req: Request, server: { requestIP(req: Request): { address: string } | null }): string {
  return server.requestIP(req)?.address ?? "unknown";
}

/** The bearer token a request presents, or null when it presents none. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

/** Below this many characters `wisp doctor` calls a configured token weak. A minted one is 36. */
export const MIN_TOKEN_LENGTH = 32;

export interface AuthThrottleOptions {
  /** Distinct wrong credentials an address may present before it has to wait. */
  freeFailures?: number;
  /** The first wait; each further distinct failure doubles it, up to `maxDelayMs`. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** An address with no new wrong credential for this long starts over. */
  forgetMs?: number;
  /** Addresses remembered at once; the oldest is forgotten first. */
  maxAddresses?: number;
  /** Wrong credentials remembered per address, so a repeat is recognized. */
  maxTokensPerAddress?: number;
  now?: () => number;
}

interface ThrottleEntry {
  /** Distinct wrong credentials seen, including any no longer remembered. */
  failures: number;
  seen: Set<string>;
  lastFailureAt: number;
  lockedUntil: number;
}

/**
 * Failed-authentication throttle, per remote address, in memory only.
 *
 * A minted token (a random UUID) cannot be guessed at any rate, but config.json
 * accepts any string, and a short hand-set token can be brute-forced by anything
 * that reaches the port: a local process, or a web page through DNS rebinding.
 *
 * What counts is DISTINCT wrong credentials. Everything local shares one
 * address (the desktop app, the CLI, agents calling `wisp` inside tasks, other
 * browser tabs, a reverse proxy), and a stale client re-sending the one old
 * token it has must never lock the others out; a guesser, by definition, sends
 * a different token each time. So a wrong token already seen from an address
 * is refused (401) without counting, and after `freeFailures` new ones the
 * address waits, 1 s at first and doubling to 30 s, before any credential from
 * it is compared again. The wait refuses the right token too: compared during
 * the wait, it would answer "right" while every guess answered "wait", which is
 * the full-speed oracle the wait exists to deny. That wait falls only on an
 * address something is actively guessing from. Only the fingerprint of a wrong
 * token is kept, and only a bounded number of them. A request that presents no
 * credential at all is not a guess and is never counted.
 */
export class AuthThrottle {
  private readonly freeFailures: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly forgetMs: number;
  private readonly maxAddresses: number;
  private readonly maxTokens: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, ThrottleEntry>();

  constructor(options: AuthThrottleOptions = {}) {
    this.freeFailures = options.freeFailures ?? 10;
    this.baseDelayMs = options.baseDelayMs ?? 1_000;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.forgetMs = options.forgetMs ?? 15 * 60_000;
    this.maxAddresses = options.maxAddresses ?? 1024;
    this.maxTokens = options.maxTokensPerAddress ?? 32;
    this.now = options.now ?? Date.now;
  }

  private entry(address: string): ThrottleEntry | undefined {
    const entry = this.entries.get(address);
    if (entry && this.now() - entry.lastFailureAt >= this.forgetMs) {
      this.entries.delete(address);
      return undefined;
    }
    return entry;
  }

  /** Milliseconds until this address may present a credential again; 0 when it may now. */
  retryAfterMs(address: string): number {
    const entry = this.entry(address);
    return entry ? Math.max(0, entry.lockedUntil - this.now()) : 0;
  }

  /** A wrong credential from this address. One it already presented changes nothing. */
  failed(address: string, token: string): void {
    const now = this.now();
    const fingerprint = createHash("sha256").update(token).digest("base64").slice(0, 16);
    const entry = this.entry(address) ?? { failures: 0, seen: new Set<string>(), lastFailureAt: now, lockedUntil: 0 };
    if (entry.seen.has(fingerprint)) return;
    // Past the bound a new token still counts; it is only not remembered, and
    // the bound is reached only by something presenting many distinct tokens.
    if (entry.seen.size < this.maxTokens) entry.seen.add(fingerprint);
    entry.failures++;
    entry.lastFailureAt = now;
    if (entry.failures >= this.freeFailures) {
      const doublings = Math.min(entry.failures - this.freeFailures, 30);
      entry.lockedUntil = now + Math.min(this.baseDelayMs * 2 ** doublings, this.maxDelayMs);
    }
    this.entries.delete(address); // re-inserted last: the map's order is least recently failed first
    if (this.entries.size >= this.maxAddresses) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(address, entry);
  }
}

export type CredentialVerdict = "valid" | "absent" | "invalid" | "throttled";

/**
 * Judge a presented credential through the throttle. An address that must
 * wait is refused before its credential is compared, and only a wrong
 * credential counts against it.
 */
export function judgeCredential(
  token: unknown,
  cfg: WispConfig,
  throttle: AuthThrottle | undefined,
  address: string,
): CredentialVerdict {
  if (typeof token !== "string" || token === "") return "absent";
  if (throttle && throttle.retryAfterMs(address) > 0) return "throttled";
  if (tokenMatches(token, cfg.token)) return "valid";
  throttle?.failed(address, token);
  return "invalid";
}

const waitSeconds = (throttle: AuthThrottle, address: string): number =>
  Math.max(1, Math.ceil(throttle.retryAfterMs(address) / 1000));

/** Why an address that must wait was refused, for a socket that cannot carry a status. */
export function throttledMessage(throttle: AuthThrottle, address: string): string {
  return `too many failed authentication attempts; retry in ${waitSeconds(throttle, address)} s`;
}

/** The 429 for an address that must wait. */
export function throttledResponse(throttle: AuthThrottle, address: string): Response {
  return json({ error: throttledMessage(throttle, address) }, 429, { "retry-after": String(waitSeconds(throttle, address)) });
}

/** The response that refuses a credential, or null when it is valid. */
export function credentialRefusal(
  token: unknown,
  cfg: WispConfig,
  throttle: AuthThrottle | undefined,
  address: string,
): Response | null {
  const verdict = judgeCredential(token, cfg, throttle, address);
  if (verdict === "throttled") return throttledResponse(throttle!, address);
  return verdict === "valid" ? null : err("unauthorized", 401);
}

/**
 * Extra browser origins allowed to open a terminal socket, comma-separated.
 * Needed only when a reverse proxy rewrites Host, so the daemon cannot derive
 * the browser's own origin from the request it received.
 */
export const ALLOWED_ORIGINS_ENV = "WISP_ALLOWED_ORIGINS";

/** `absent` is a non-browser client; `foreign` is a browser page that is not ours. */
export type OriginVerdict = "absent" | "allowed" | "foreign";

/**
 * Whose page sent this request.
 *
 * `url.origin` comes from the Host header, which a BROWSER sets from the
 * address it actually connected to and page JavaScript cannot forge. So for a
 * browser, an exact match means the request came from this daemon's own page,
 * and anything else is another origin — including another port on the same
 * host. Absent means no browser sent it: the CLI, and the desktop app's
 * native proxy, which strips Origin and injects its own credential.
 *
 * What this is NOT: a network-level check. Anything that is not a browser can
 * send a matching `Origin` and `Host` and be called `allowed`. That is fine
 * and deliberate — it only buys the caller an UNAUTHENTICATED terminal
 * upgrade, which attaches to nothing, spawns nothing, and does not answer
 * whether the task exists until a valid token arrives.
 */
export function originVerdict(req: Request, url: URL): OriginVerdict {
  const origin = req.headers.get("origin");
  if (origin === null) return "absent";
  if (origin === url.origin) return "allowed";
  return allowedOrigins().includes(origin) ? "allowed" : "foreign";
}

/**
 * The extra origins as configured, parsed. Its own function because three
 * things need the same list now: the verdict, the log line that explains a
 * refusal, and the diagnostics that report the configuration.
 */
export function allowedOrigins(): string[] {
  return (process.env[ALLOWED_ORIGINS_ENV] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * Why a terminal upgrade was refused, in one sentence.
 *
 * Composed once and read in three places, because a browser cannot read a
 * failed WebSocket upgrade's response body: the page saw only a socket that
 * did not open, so the 403 explained itself where nothing could reach it. The
 * same sentence therefore also goes to the daemon log and to the authenticated
 * origin report the page asks for after a handshake dies.
 *
 * `configured` is the allowed set, and is passed ONLY where the reader is
 * trusted. The 403 body is answered before any credential is checked, so it
 * names the rejected and the expected origin — both of which the caller
 * already supplied — and never the operator's proxy hostnames.
 */
export function foreignOriginMessage(origin: string | null, expected: string, configured?: string[]): string {
  const extra =
    configured === undefined
      ? ""
      : configured.length > 0
        ? ` ${ALLOWED_ORIGINS_ENV} also allows ${configured.map((entry) => JSON.stringify(entry)).join(", ")}.`
        : ` ${ALLOWED_ORIGINS_ENV} is unset.`;
  return (
    `terminal upgrades must come from this daemon's own origin, not ${JSON.stringify(origin)}` +
    ` — it answers as ${JSON.stringify(expected)}.${extra}` +
    ` If a reverse proxy rewrites Host, name the browser's origin in ${ALLOWED_ORIGINS_ENV}` +
    ` and restart the daemon (docs/REMOTE-ACCESS.md).`
  );
}

/** What the daemon reports about the origin a request actually carried. */
export interface OriginReport {
  verdict: OriginVerdict;
  /** The Origin header as received, or null for a non-browser caller. */
  origin: string | null;
  /** The origin this daemon derives from Host, which a same-origin page matches. */
  expected: string;
  /** The parsed `WISP_ALLOWED_ORIGINS`, in the daemon's own environment. */
  allowed: string[];
  env: typeof ALLOWED_ORIGINS_ENV;
  /** The refusal sentence, present only when this caller would be refused. */
  reason: string | null;
}

/**
 * POST /api/terminal-origin: "would you accept a terminal socket from me?"
 *
 * POST, not GET, and that is the whole trick. A browser omits `Origin` on a
 * same-origin GET but always sends it on a POST, so this sees the same header
 * the WebSocket handshake sent and can answer about the real refusal rather
 * than a hypothetical one. The page cannot read a failed upgrade's body, but it
 * can read this.
 *
 * Authenticated like every other /api route, so unlike the 403 it may name the
 * configured set — that is the answer an operator is actually missing, and the
 * daemon's own environment is the only place it is true.
 */
export function terminalOriginRoute(req: Request, url: URL): Response {
  const origin = req.headers.get("origin");
  const verdict = originVerdict(req, url);
  const allowed = allowedOrigins();
  const report: OriginReport = {
    verdict,
    origin,
    expected: url.origin,
    allowed,
    env: ALLOWED_ORIGINS_ENV,
    reason: verdict === "foreign" ? foreignOriginMessage(origin, url.origin, allowed) : null,
  };
  return json(report, 200, { "cache-control": "private, no-store" });
}

/**
 * POST /api/session: the one unauthenticated /api route. It verifies a token
 * so the browser's auth dialog can refuse a wrong one before storing it —
 * that is all it does now.
 *
 * It also expires the pre-0.4 `wisp_token` cookie. An upgraded daemon no
 * longer reads it, but a browser that authenticated against an older release
 * still holds the root token in its cookie jar and would keep sending it to
 * every other service on the host; the one moment we know that browser is
 * talking to us is here.
 */
/**
 * The Set-Cookie that retires the pre-0.4 root-token cookie. Served by the
 * page and by `/api/session`, so any browser that either loads the app or
 * verifies a token stops carrying it.
 */
export const RETIRED_COOKIE = "wisp_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict";

/**
 * The most `POST /api/session` reads. The body is `{"token": "..."}`, so this
 * is generous; the daemon-wide ceiling is sized for attachments and is far
 * too much to buffer for a route that any web page can reach.
 */
export const SESSION_BODY_MAX_BYTES = 4096;

export async function postSession(
  req: Request,
  cfg: WispConfig,
  throttle?: AuthThrottle,
  address = "unknown",
): Promise<Response> {
  // The same body contract as every mutating route (ENG-09), so `null`, an
  // array, and unparseable bytes are named 400s rather than "unauthorized" —
  // a wrong token and a wrong body are different mistakes, and this was the
  // last `req.json()` left in the daemon (a review's note). It is also the one
  // unauthenticated body the daemon reads, and a cross-site page can send it
  // without a preflight, so an oversized one is refused before it is buffered.
  const body = await boundedJsonObjectBody(req, SESSION_BODY_MAX_BYTES);
  if (body instanceof Response) return body;
  return credentialRefusal(body.token, cfg, throttle, address) ?? json({ ok: true }, 200, { "set-cookie": RETIRED_COOKIE });
}
