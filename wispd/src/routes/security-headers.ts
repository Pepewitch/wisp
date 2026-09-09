/**
 * The response headers for the page itself.
 *
 * The daemon used to serve its HTML with nothing but a Content-Type, so the
 * browser shell had no framing protection and no content policy (SEC-04). The
 * Tauri shell has had a CSP all along; this is the daemon-served page catching
 * up, and it is deliberately built from the bundle it is actually serving
 * rather than from a hand-maintained list of hashes that would rot the next
 * time the build changes.
 *
 * The one self-inflicted constraint: the app is a SINGLE inlined HTML file, so
 * `script-src` cannot be `'self'` — the script has no URL. Hashing the inline
 * script is what keeps the policy meaningful anyway; a blanket
 * `'unsafe-inline'` would leave a future injection with the same authority the
 * bundle has, which is the whole thing this defends against.
 */
import { createHash } from "node:crypto";

/**
 * The contents of every inline `<script>` in `html`, scanned the way a browser
 * parses one.
 *
 * A global search for `<script` would be WRONG here and quietly so: the bundle
 * embeds Markdown-sanitizer regexes that contain that literal text, and it
 * would hash them as if they were code. The scan therefore alternates —
 * outside an element, the next `<script` is a real start tag; inside one, the
 * next `</script` ends it, because that is a raw-text element and the parser
 * has no other way out. Bundlers escape `<\/script` in string literals for
 * exactly this reason, so the alternation cannot be fooled.
 *
 * A script with a `src` is skipped: it has a URL, so it is covered by a source
 * expression rather than a hash. This bundle has none.
 */
export function inlineScriptSources(html: string): string[] {
  const sources: string[] = [];
  const lower = html.toLowerCase();
  let cursor = 0;
  for (;;) {
    const open = lower.indexOf("<script", cursor);
    if (open === -1) return sources;
    const tagEnd = html.indexOf(">", open);
    if (tagEnd === -1) return sources;
    const attributes = html.slice(open + "<script".length, tagEnd);
    const close = lower.indexOf("</script", tagEnd + 1);
    const contentEnd = close === -1 ? html.length : close;
    if (!/\ssrc\s*=/i.test(attributes)) sources.push(html.slice(tagEnd + 1, contentEnd));
    if (close === -1) return sources;
    const closeEnd = html.indexOf(">", close);
    cursor = closeEnd === -1 ? html.length : closeEnd + 1;
  }
}

/** A CSP hash source expression, the form a browser compares against. */
export function hashSource(source: string): string {
  return `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;
}

export interface PageSecurityPolicy {
  /** Hash sources for the bundle's inline scripts, computed once at startup. */
  scriptHashes: string[];
}

export function pageSecurityPolicy(html: string): PageSecurityPolicy {
  return { scriptHashes: inlineScriptSources(html).map(hashSource) };
}

/**
 * The policy for one request. `origin` is this daemon's own origin as the
 * browser reached it, which is the only way to name the WebSocket endpoint:
 * CSP3 says `'self'` covers a same-host `ws:` connection, but naming it
 * explicitly costs one string and does not depend on that reading.
 */
export function contentSecurityPolicy(policy: PageSecurityPolicy, origin: string): string {
  const socketOrigins = socketFormsOf(origin);
  return [
    // Nothing loads unless a directive below says so.
    "default-src 'none'",
    `script-src ${policy.scriptHashes.join(" ")}`.trim(),
    // 'unsafe-inline' is load-bearing and cannot be narrowed: xterm creates
    // <style> elements after load (see desktop/README.md), and React writes
    // inline style attributes. Adding a hash here would DISABLE it — CSP
    // ignores 'unsafe-inline' in a directive that also carries a hash — so
    // style-src deliberately has no hashes.
    "style-src 'self' 'unsafe-inline'",
    // Fonts are inlined as data: URIs by the single-file build.
    "font-src 'self' data:",
    // 'self' for the API, blob: for attachment media the browser fetched with
    // its bearer token (SEC-01), data: for the generated favicon. Remote
    // http(s) images are what agent prose can reference today; narrowing that
    // is a product decision, not a header change (SEC-03).
    "img-src 'self' data: blob: https: http:",
    `connect-src 'self' blob: ${socketOrigins.join(" ")}`.trim(),
    // The app never frames anything and must never BE framed: a framed Wisp is
    // a clickjacking surface for consequential buttons (archive, force-stop).
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    // Nothing in the app submits a form; a navigation that tried would be an
    // injection.
    "form-action 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join("; ");
}

/** The ws:/wss: spellings of an http(s) origin, for connect-src. */
function socketFormsOf(origin: string): string[] {
  if (origin.startsWith("https://")) return [`wss://${origin.slice("https://".length)}`];
  if (origin.startsWith("http://")) return [`ws://${origin.slice("http://".length)}`];
  return [];
}

/**
 * Every header the HTML response carries.
 *
 * `X-Frame-Options` duplicates `frame-ancestors` on purpose: the CSP is the
 * modern control, and the legacy header is what an older browser or an
 * intermediary honors. `Referrer-Policy: no-referrer` keeps task ids and paths
 * out of the Referer header when an agent's link is followed off-site.
 */
export function pageSecurityHeaders(policy: PageSecurityPolicy, origin: string): Record<string, string> {
  return {
    "content-security-policy": contentSecurityPolicy(policy, origin),
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    // The page needs none of these, and an injection should not be able to
    // ask the operator's browser for them.
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  };
}
