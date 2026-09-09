import { createHash, timingSafeEqual } from "node:crypto";
import type { WispConfig } from "../config";
import { err, json, jsonObjectBody } from "./http";

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
  const header = req.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
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
  const allowed = (process.env[ALLOWED_ORIGINS_ENV] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return allowed.includes(origin) ? "allowed" : "foreign";
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

export async function postSession(req: Request, cfg: WispConfig): Promise<Response> {
  // The same body contract as every mutating route (ENG-09), so `null`, an
  // array, and unparseable bytes are named 400s rather than "unauthorized" —
  // a wrong token and a wrong body are different mistakes, and this was the
  // last `req.json()` left in the daemon (a review's note).
  const body = await jsonObjectBody(req);
  if (body instanceof Response) return body;
  if (!tokenAuthorizes(body.token, cfg)) return err("unauthorized", 401);
  return json({ ok: true }, 200, { "set-cookie": RETIRED_COOKIE });
}
