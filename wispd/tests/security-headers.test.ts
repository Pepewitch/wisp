/**
 * The page's security headers (SEC-04), including the part that is easy to get
 * quietly wrong: the inline-script hashes have to be the hashes of the script
 * the daemon is really serving, or the policy silently blocks the whole app.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

import { CONFIG_PATH } from "../src/config";
import { serve } from "../src/daemon";
import {
  contentSecurityPolicy,
  hashSource,
  inlineScriptSources,
  pageSecurityHeaders,
  pageSecurityPolicy,
} from "../src/routes/security-headers";

const TOKEN = "security-headers-test-token";
let server: Awaited<ReturnType<typeof serve>> | null = null;

afterEach(async () => {
  if (server) await server.stop(true);
  server = null;
});

function writeConfig(): void {
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      port: 18710,
      host: "127.0.0.1",
      token: TOKEN,
      webhooks: [],
      stuckMinutes: 10,
      logMaxBytes: 5_000_000,
      setupTimeoutMinutes: 10,
      envAllowlist: {},
      harnessDefaults: {},
    }),
  );
}

function directive(policy: string, name: string): string | null {
  for (const part of policy.split(";").map((entry) => entry.trim())) {
    if (part === name) return "";
    if (part.startsWith(`${name} `)) return part.slice(name.length + 1);
  }
  return null;
}

describe("inline script scanning", () => {
  test("finds a real inline script and its exact bytes", () => {
    const html = '<!doctype html><head><script type="module">console.log(1)</script></head>';
    expect(inlineScriptSources(html)).toEqual(["console.log(1)"]);
  });

  /**
   * The bundle embeds Markdown-sanitizer regexes containing the literal text
   * `<script`. A global search would hash those as if they were code — and,
   * worse, could miss the real script. The scan alternates in/out of raw-text
   * elements the way a parser does, so script CONTENT is never mistaken for a
   * tag.
   */
  test("does not mistake the string '<script' inside code for a tag", () => {
    const html = [
      "<!doctype html><body>",
      '<script>const unsafe = /<script[^>]*>/gi; const also = "<script src=x>";</script>',
      "</body>",
    ].join("");
    expect(inlineScriptSources(html)).toEqual([
      'const unsafe = /<script[^>]*>/gi; const also = "<script src=x>";',
    ]);
  });

  /**
   * The scan searches the ORIGINAL bytes. Lowercasing the whole document first
   * (the first version) desynchronizes the indices as soon as a character
   * changes length when lowercased, and the hash of a wrong slice means the
   * browser refuses the real script: a blank app, failing closed but blank.
   */
  test("a character that changes length when lowercased does not shift the slice", () => {
    const script = 'boot("\u00df")';
    // U+0130 (capital I with dot above) lowercases to TWO code units
    // (i + combining dot), so every index after it would be off by one in a
    // lowercased copy of the document.
    const html = `<!doctype html><body><p>\u0130\u0130</p><script>${script}</script></body>`;
    expect("\u0130".toLowerCase().length).toBe(2); // the premise of the test
    expect(inlineScriptSources(html)).toEqual([script]);
  });

  test("an upper-case tag is still found", () => {
    expect(inlineScriptSources("<SCRIPT>boot()</SCRIPT>")).toEqual(["boot()"]);
  });

  test("skips a script with a src, which a hash cannot cover", () => {
    const html = '<script src="/app.js"></script><script>inline()</script>';
    expect(inlineScriptSources(html)).toEqual(["inline()"]);
  });

  test("hashSource is the base64 sha256 CSP compares against", () => {
    const digest = createHash("sha256").update("console.log(1)", "utf8").digest("base64");
    expect(hashSource("console.log(1)")).toBe(`'sha256-${digest}'`);
  });
});

describe("the assembled policy", () => {
  const policy = pageSecurityPolicy('<script type="module">boot()</script>');

  test("script-src carries the bundle's hash and never 'unsafe-inline'", () => {
    const csp = contentSecurityPolicy(policy, "http://127.0.0.1:18710");
    expect(directive(csp, "script-src")).toBe(hashSource("boot()"));
    expect(directive(csp, "script-src")).not.toContain("unsafe-inline");
  });

  /**
   * style-src must NOT carry a hash: CSP ignores 'unsafe-inline' in a
   * directive that also has one, and xterm creates stylesheets after load.
   */
  test("style-src keeps 'unsafe-inline' usable by carrying no hash", () => {
    const styles = directive(contentSecurityPolicy(policy, "http://127.0.0.1:18710"), "style-src");
    expect(styles).toContain("'unsafe-inline'");
    expect(styles).not.toContain("sha256-");
  });

  test("the page cannot be framed, navigate, or load a plugin", () => {
    const csp = contentSecurityPolicy(policy, "http://127.0.0.1:18710");
    expect(directive(csp, "default-src")).toBe("'none'");
    expect(directive(csp, "frame-ancestors")).toBe("'none'");
    expect(directive(csp, "object-src")).toBe("'none'");
    expect(directive(csp, "base-uri")).toBe("'none'");
    expect(directive(csp, "form-action")).toBe("'none'");
  });

  test("connect-src names this daemon's own websocket endpoint, and no other", () => {
    expect(directive(contentSecurityPolicy(policy, "http://127.0.0.1:18710"), "connect-src")).toBe(
      "'self' blob: ws://127.0.0.1:18710",
    );
    expect(directive(contentSecurityPolicy(policy, "https://wisp.example.ts.net"), "connect-src")).toBe(
      "'self' blob: wss://wisp.example.ts.net",
    );
  });

  test("media the app really loads is allowed: blob attachments, data fonts", () => {
    const csp = contentSecurityPolicy(policy, "http://127.0.0.1:18710");
    expect(directive(csp, "img-src")).toContain("blob:");
    expect(directive(csp, "img-src")).toContain("data:");
    expect(directive(csp, "font-src")).toContain("data:");
    // A1d: an attached video plays from a blob: URL the app fetched with its
    // bearer token. Without this directive default-src 'none' refuses it, and
    // nothing else in this file would notice a later edit dropping it.
    expect(directive(csp, "media-src")).toContain("blob:");
  });

  test("the legacy framing header and a no-referrer policy ride along", () => {
    const headers = pageSecurityHeaders(policy, "http://127.0.0.1:18710");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("the served page", () => {
  test("carries a policy whose script hash matches the bundle it just served", async () => {
    writeConfig();
    server = await serve({ port: 0 });
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    const html = await response.text();

    const csp = response.headers.get("content-security-policy");
    expect(csp).not.toBeNull();
    expect(response.headers.get("x-frame-options")).toBe("DENY");

    // The real bundle, hashed independently of the code that served it.
    const sources = inlineScriptSources(html);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) expect(csp).toContain(hashSource(source));
  });

  test("the policy's websocket origin follows the address the browser used", async () => {
    writeConfig();
    server = await serve({ port: 0 });
    const response = await fetch(`http://127.0.0.1:${server.port}/`, {
      headers: { host: "wisp.local:9999" },
    });
    expect(response.headers.get("content-security-policy")).toContain("ws://wisp.local:9999");
  });

  test("attachment bytes are not stored by the browser after the daemon deletes them", async () => {
    // SEC-08. The header is the contract; the attachment route's own tests
    // cover delivery.
    const { ATTACHMENT_CACHE_CONTROL } = await import("../src/routes/task-messages");
    expect(ATTACHMENT_CACHE_CONTROL).toBe("private, no-store");
  });
});
