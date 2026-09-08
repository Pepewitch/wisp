import { createHash, timingSafeEqual } from "node:crypto";
import type { WispConfig } from "../config";
import { err, json } from "./http";

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

// Bearer header, or the HttpOnly cookie minted by POST /api/session for
// browser streaming clients — EventSource/WebSocket can't set Authorization
// headers, and tokens in URL query params stay BANNED (they leak into logs
// and browser history — a prior audit).
export function authorized(req: Request, cfg: WispConfig): boolean {
  const header = req.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (token !== null && tokenMatches(token, cfg.token)) return true;
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === "wisp_token" && tokenMatches(part.slice(eq + 1).trim(), cfg.token)) {
      return true;
    }
  }
  return false;
}

/**
 * POST /api/session: trade the bearer token for an HttpOnly cookie. This is
 * the ONLY unauthenticated /api route — it is how the cookie gets minted.
 */
export async function postSession(req: Request, cfg: WispConfig): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { token?: unknown };
  if (typeof body.token !== "string" || !tokenMatches(body.token, cfg.token)) return err("unauthorized", 401);
  return json({ ok: true }, 200, {
    "set-cookie": `wisp_token=${cfg.token}; Path=/; HttpOnly; SameSite=Strict`,
  });
}
