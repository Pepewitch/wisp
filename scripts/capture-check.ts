/**
 * `wisp capture` in a real Chrome: what the hermetic suite cannot show.
 * A policy function fed fake requests proves nothing about which requests
 * Chrome actually sends through the proxy, so every boundary here is checked
 * by a listener that counts the connections it receives.
 *
 * Required in CI (the browser-security job has Chrome); a machine without
 * Chrome says it skipped and exits 0.
 */
import { mkdtempSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

process.env.WISP_HOME = mkdtempSync(join(tmpdir(), "wisp-capture-check-"));
const { capturePage, CaptureFailure, imageSize, MAX_SIDE_PX, MAX_SHOT_BYTES, VIEWPORTS } = await import("../wispd/src/capture/capture");
const { BROWSER_DIR, findChrome } = await import("../wispd/src/capture/chrome");

const found = findChrome(process.env.CHROME_PATH);
if (!("path" in found)) {
  if (process.env.CI) throw new Error(`capture check needs Chrome in CI: ${found.reason}`);
  console.log(`capture check skipped: ${found.reason}`);
  process.exit(0);
}

/** A loopback listener that counts every connection, so "refused" means it saw nothing. */
async function counter(): Promise<{ port: number; seen: () => number; server: Server }> {
  let seen = 0;
  const server = createServer((socket) => { seen++; socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nno"); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  return { port: (server.address() as { port: number }).port, seen: () => seen, server };
}

const outside = await counter();
const app = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  fetch(req) {
    const path = new URL(req.url).pathname;
    const html = (body: string) => new Response(`<!doctype html><html><body style="margin:0">${body}</body></html>`, { headers: { "content-type": "text/html" } });
    if (path === "/missing") return new Response("gone", { status: 404 });
    if (path === "/redirect") return Response.redirect(`http://127.0.0.1:${outside.port}/`, 302);
    if (path === "/tall") return html(`<div style="height:20000px;background:linear-gradient(red,blue)"></div>`);
    if (path === "/below") return html(`<div style="height:3000px"></div><div id="box" style="width:300px;height:200px;background:rgb(0,0,200)"></div>`);
    if (path === "/timer") return html(`<p>soon gone</p><script>setTimeout(() => { location.href = "/missing" }, 200)</script>`);
    if (path === "/reach") {
      return html(`<iframe src="http://127.0.0.1:${outside.port}/frame"></iframe><img src="http://127.0.0.1:${outside.port}/i.png">
        <script>fetch("http://127.0.0.1:${outside.port}/f").catch(() => {}); try { new WebSocket("ws://127.0.0.1:${outside.port}/ws") } catch {}</script>`);
    }
    return html(`<button id="go" onclick="document.body.style.background='rgb(0, 160, 0)';document.getElementById('done').hidden=false">Go</button><p id="done" hidden>Done</p>`);
  },
});
const base = `http://127.0.0.1:${app.port}`;
const context = { chromePath: found.path, daemonPort: 1, ports: [], publicAllowed: false };
const request = (path: string, extra: Partial<Parameters<typeof capturePage>[0]> = {}) => ({
  url: new URL(`${base}${path}`), viewport: VIEWPORTS.desktop, dark: false, selector: null, fullPage: false, waitFor: null, waitMs: 0, script: null, ...extra,
});

/** A shot's real size, from its encoded header: the limits are about the bytes, not what the engine reports. */
function decoded(shot: { bytes: Uint8Array; width: number; height: number }): { width: number; height: number } {
  const size = imageSize(shot.bytes);
  if (!size) throw new Error("the shot's header could not be read");
  if (size.width !== shot.width || size.height !== shot.height) throw new Error(`reported ${shot.width}×${shot.height}, but the image is ${size.width}×${size.height}`);
  return size;
}

/** The first pixel of a PNG: its first row's first pixel is stored unfiltered whatever the row's filter. */
function firstPixel(png: Uint8Array): [number, number, number] {
  const bytes = Buffer.from(png);
  const chunks: Buffer[] = [];
  for (let at = 8; at < bytes.length;) {
    const length = bytes.readUInt32BE(at);
    if (bytes.toString("latin1", at + 4, at + 8) === "IDAT") chunks.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  return [raw[1]!, raw[2]!, raw[3]!];
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CaptureFailure) return error.reason;
    throw error;
  }
  throw new Error("expected the capture to fail");
}

const checks: [string, () => Promise<void>][] = [
  ["a state behind a click is captured after --script, pixels and all", async () => {
    const shot = await capturePage(request("/", { script: "document.getElementById('go').click()", waitFor: "#done:not([hidden])" }), context);
    const [r, g, b] = firstPixel(shot.bytes);
    if (!(r < 20 && g > 140 && b < 20)) throw new Error(`expected the page green after the click, got rgb(${r}, ${g}, ${b})`);
    const size = decoded(shot);
    if (size.width !== 2560 || size.height !== 1800) throw new Error(`expected 2560×1800 (1280×900 at scale 2), got ${size.width}×${size.height}`);
  }],
  ["a redirect off the page's port is refused, and the other port sees nothing", async () => {
    const reason = await failure(capturePage(request("/redirect"), context));
    if (reason !== "http-error" && reason !== "unreachable") throw new Error(`expected a refused redirect, got ${reason}`);
  }],
  ["an iframe, an image, a fetch and a WebSocket to another local port never connect", async () => {
    const shot = await capturePage(request("/reach"), context);
    if (shot.blocked.length === 0) throw new Error("expected the page's requests to the other port to be reported as blocked");
  }],
  ["a 404 and a dead port are not evidence", async () => {
    if (await failure(capturePage(request("/missing"), context)) !== "http-error") throw new Error("a 404 was stored");
    const dead = await failure(capturePage({ ...request("/"), url: new URL("http://127.0.0.1:9/") }, context));
    if (dead !== "unreachable") throw new Error(`a dead port gave ${dead}`);
  }],
  ["a tall page is cut to the size limits", async () => {
    const shot = await capturePage(request("/tall", { fullPage: true }), context);
    const size = decoded(shot);
    if (size.height > MAX_SIDE_PX || size.width > MAX_SIDE_PX || shot.bytes.length > MAX_SHOT_BYTES || !shot.clipped) {
      throw new Error(`expected a clipped shot within limits, got ${shot.width}×${shot.height}, ${shot.bytes.length} bytes, clipped ${shot.clipped}`);
    }
  }],
  ["mobile is a phone-sized shot", async () => {
    const shot = await capturePage(request("/", { viewport: VIEWPORTS.mobile }), context);
    if (decoded(shot).width !== 780) throw new Error(`expected 780 px wide, got ${decoded(shot).width}`);
  }],
  ["an element below the fold is shot as itself, not blank", async () => {
    const shot = await capturePage(request("/below", { selector: "#box" }), context);
    const [r, g, b] = firstPixel(shot.bytes);
    if (!(r < 20 && g < 20 && b > 180)) throw new Error(`expected the blue box, got rgb(${r}, ${g}, ${b})`);
  }],
  ["a page that moves to a 404 after loading is not evidence, by script or by timer", async () => {
    const scripted = await failure(capturePage(request("/", { script: "location.href = '/missing'; await new Promise((r) => setTimeout(r, 500))" }), context));
    if (scripted !== "http-error") throw new Error(`a scripted move to a 404 gave ${scripted}`);
    const timed = await failure(capturePage(request("/timer", { waitMs: 1500 }), context));
    if (timed !== "http-error") throw new Error(`a timed move to a 404 gave ${timed}`);
  }],
  ["a page that moves somewhere unopenable is not evidence (Chrome's error page)", async () => {
    const reason = await failure(capturePage(request("/", { script: "location.href = 'http://127.0.0.1:9/'; await new Promise((r) => setTimeout(r, 800))" }), context));
    if (reason !== "unreachable" && reason !== "script-error") throw new Error(`a move to a dead port gave ${reason}`);
  }],
  ["a --wait-for that never matches is the page's failure, not the machine's", async () => {
    const reason = await failure(capturePage(request("/", { waitFor: "#never" }), context));
    if (reason !== "no-element") throw new Error(`expected no-element, got ${reason}`);
  }],
  ["a script that never ends is stopped, and no Chrome or profile is left", async () => {
    const reason = await failure(capturePage(request("/", { script: "await new Promise(() => {})" }), context));
    if (reason !== "script-error" && reason !== "timeout") throw new Error(`a hanging script gave ${reason}`);
  }],
];

let failed = 0;
for (const [name, check] of checks) {
  try {
    await check();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (outside.seen() !== 0) {
  failed++;
  console.error(`FAIL the refused port received ${outside.seen()} connection(s)`);
} else console.log("ok   the refused port never received a connection");
const left = readdirSync(BROWSER_DIR);
if (left.length > 0) {
  failed++;
  console.error(`FAIL capture browsers left behind: ${left.join(", ")}`);
} else console.log("ok   every capture browser and profile is gone");
const ps = Bun.spawnSync(["pgrep", "-f", BROWSER_DIR]).stdout.toString().trim();
if (ps) {
  failed++;
  console.error(`FAIL Chrome processes still running: ${ps}`);
}
app.stop(true);
outside.server.close();
if (failed > 0) process.exit(1);
console.log(`capture check: ${checks.length + 2} checks passed with ${found.path}`);
