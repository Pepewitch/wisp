/**
 * The browser half of the security boundary, checked in a real browser.
 *
 * Everything here was verified by hand while fixing SEC-01, SEC-02, and
 * SEC-04, and a review said the obvious thing about that: source tests can be
 * green while a browser still attaches a credential nobody intended. Cookie
 * scope, CSP enforcement, and framing refusal are BROWSER policies. The daemon
 * test suite cannot exercise any of them, and no amount of raw HTTP can.
 *
 * So this drives Chrome over the DevTools protocol against a throwaway daemon
 * and asserts the six things that must stay true:
 *
 *   1. the app loads and renders with no CSP violation and no console error;
 *   2. after authenticating, the page holds NO cookies (SEC-01);
 *   3. its event stream carries an Authorization header and is accepted;
 *   4. the terminal socket completes its in-band handshake (SEC-01);
 *   5. a page on another local port receives no Wisp cookie, cannot write
 *      cross-origin, and cannot upgrade a terminal socket (SEC-01/SEC-02);
 *   6. the app refuses to be framed (SEC-04).
 *
 * It is deliberately a script rather than a `bun test` file: it needs a real
 * browser, a real listener, and a throwaway profile, and none of those belong
 * in the unit suite that must stay hermetic (ENG-12). CI runs it as its own
 * job; a contributor runs `bun run check:browser-security`.
 *
 * Everything it touches is disposable: a temporary WISP_HOME, an ephemeral
 * port, a fresh Chrome profile, and a synthetic checkout, attachment, and shell; no provider harness is called.
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where a browser lives, in the order worth trying. `CHROME_PATH` wins. */
const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function findBrowser(): string {
  for (const candidate of BROWSER_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error(
    `no Chrome or Chromium found. Set CHROME_PATH, or install one. Tried: ${BROWSER_CANDIDATES.filter(Boolean).join(", ")}`,
  );
}

/** A minimal DevTools client: request/response by id, events collected. */
class Cdp {
  private readonly socket: WebSocket;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  readonly events: { method: string; params: Record<string, unknown> }[] = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: Record<string, unknown>;
        error?: { message?: string };
      };
      if (message.id === undefined) {
        if (message.method) this.events.push({ method: message.method, params: message.params ?? {} });
        return;
      }
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error.message ?? "devtools error"));
      else waiter?.resolve(message.result ?? {});
    };
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error(`could not connect to ${url}`));
    });
    return new Cdp(socket);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30_000);
    });
  }

  close(): void {
    this.socket.close();
  }
}

interface Failure {
  check: string;
  detail: string;
}

const failures: Failure[] = [];
const passes: string[] = [];

function check(name: string, condition: boolean, detail: string): void {
  if (condition) passes.push(name);
  else failures.push({ check: name, detail });
}

interface Page {
  client: Cdp;
  session: string;
  evaluate(expression: string): Promise<unknown>;
}

/** A throwaway daemon on a port nothing else uses, with its own home. */
async function startDaemon(home: string, entry: string): Promise<{ daemon: Bun.Subprocess; origin: string; token: string; port: number }> {
  const port = 39_000 + Math.floor(Math.random() * 900);
  const init = Bun.spawnSync({
    cmd: ["bun", entry, "init", "--port", String(port)],
    env: { ...process.env, WISP_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!init.success) throw new Error(`wisp init failed: ${init.stderr.toString()}`);
  const token = (JSON.parse(await readFile(join(home, "config.json"), "utf8")) as { token: string }).token;
  const checkout = join(home, "checkout");
  await mkdir(checkout);
  const seed = Bun.spawnSync([process.execPath, join(import.meta.dir, "../wispd/tests/helpers/seed-transport-daemon.ts"), "browser", checkout], {
    env: { ...process.env, WISP_HOME: home }, stdout: "pipe", stderr: "pipe",
  });
  if (seed.exitCode !== 0) throw new Error(`browser fixture failed: ${seed.stderr.toString()}`);
  const shell = join(home, "fixture-shell");
  await writeFile(shell, '#!/bin/sh\necho started >> "$WISP_HOME/shell-starts"\nexec /bin/bash --noprofile --norc\n');
  await chmod(shell, 0o700);
  const daemon = Bun.spawn({
    cmd: ["bun", entry, "serve"],
    env: { ...process.env, WISP_HOME: home, SHELL: shell },
    // Ignored, not piped: nothing here reads them, and a full pipe buffer
    // would stall the very daemon under test (a review's note).
    stdout: "ignore",
    stderr: "ignore",
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    const health = await fetch(`${origin}/api/health`).catch(() => null);
    if (health?.ok) break;
    if (attempt === 99) throw new Error(`daemon never answered on ${origin}`);
    await sleep(100);
  }
  return { daemon, origin, token, port };
}

/**
 * The other local service: same host, different port. This is the whole point
 * of SEC-01 — a host-scoped cookie is delivered here, and this records what
 * arrives.
 */
function startOtherLocalService(port: number, daemonOrigin: string): Bun.Server<undefined> {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/cookies") {
        return new Response(JSON.stringify({ cookie: request.headers.get("cookie") }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/frame") {
        return new Response(
          `<!doctype html><title>frame</title><body><iframe id="f" src="${daemonOrigin}/"></iframe></body>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      return new Response("<!doctype html><title>other service</title><body>another local service</body>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
}

async function startBrowser(profile: string, token: string): Promise<{ chrome: Bun.Subprocess; page: Page }> {
  const chrome = spawnBrowser(profile);
  try {
    return { chrome, page: await attachToBrowser(chrome, profile, token) };
  } catch (error) {
    // Anything between spawn and a working DevTools session would otherwise
    // leave a headless Chrome running until the job ends (a review's note).
    chrome.kill();
    await chrome.exited;
    throw error;
  }
}

function spawnBrowser(profile: string): Bun.Subprocess {
  return Bun.spawn({
    cmd: [
      findBrowser(),
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "about:blank",
    ],
    stdout: "ignore",
    stderr: "ignore",
  });
}

async function attachToBrowser(chrome: Bun.Subprocess, profile: string, token: string): Promise<Page> {
  let endpoint = "";
  // 60s rather than 15s: a first launch on a cold CI runner has taken longer
  // than the old window, which failed the job with "never published a
  // DevTools endpoint" (observed) rather than anything about the daemon.
  for (let attempt = 0; attempt < 600; attempt++) {
    const lines = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "");
    const [portLine, path] = lines.trim().split("\n");
    if (portLine && path) {
      endpoint = `ws://127.0.0.1:${portLine}${path}`;
      break;
    }
    await sleep(100);
  }
  if (!endpoint) {
    throw new Error(
      `the browser never published a DevTools endpoint (exited: ${chrome.exitCode !== null}); is ${findBrowser()} runnable here?`,
    );
  }

  const client = await Cdp.connect(endpoint);
  const created = await client.send("Target.createTarget", { url: "about:blank" });
  const attached = await client.send("Target.attachToTarget", { targetId: created.targetId as string, flatten: true });
  const session = attached.sessionId as string;
  for (const domain of ["Page", "Runtime", "Network", "Log"]) await client.send(`${domain}.enable`, {}, session);
  await client.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false },
    session,
  );
  // Seed the credential the way a person does: the token the app stores after
  // the auth dialog. Also record CSP violations from the page itself.
  await client.send(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source: `try { localStorage.setItem("wisp_token", ${JSON.stringify(token)}); } catch {}
      window.__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        window.__cspViolations.push(event.violatedDirective + " <- " + event.blockedURI);
      });`,
    },
    session,
  );
  return {
    client,
    session,
    evaluate: async (expression) =>
      (
        (await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session))
          .result as { value?: unknown } | undefined
      )?.value,
  };
}

/**
 * Wait for a page to satisfy `predicate` (a JS expression), instead of
 * sleeping at it. The old fixed sleeps were fine while CI was fast and are
 * exactly what makes a check like this flake later (a review's note).
 */
async function waitInPage(page: Page, predicate: string, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if ((await page.evaluate(predicate)) === true) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await sleep(100);
  }
}

/** 1: the app loads and renders under the content policy, with a clean console. */
async function checkTheAppLoads(page: Page, origin: string): Promise<void> {
  await page.client.send("Page.navigate", { url: `${origin}/` }, page.session);
  // The sidebar heading is the app's own render, not the shell's HTML.
  await waitInPage(page, 'document.body.innerText.includes("PROJECTS")', "the app to render");
  const rendered = String(await page.evaluate("document.body.innerText"));
  check("the app renders", rendered.includes("PROJECTS"), `body text was ${JSON.stringify(rendered.slice(0, 200))}`);
  const violations = JSON.parse(String(await page.evaluate("JSON.stringify(window.__cspViolations ?? [])"))) as string[];
  check("no CSP violation", violations.length === 0, violations.join("; "));
  const consoleErrors = page.client.events
    .filter((event) => event.method === "Log.entryAdded" && (event.params.entry as { level?: string }).level === "error")
    .map((event) => (event.params.entry as { text?: string }).text ?? "");
  check("no console error", consoleErrors.length === 0, consoleErrors.join("; "));
  const exceptions = page.client.events.filter((event) => event.method === "Runtime.exceptionThrown");
  check("no uncaught exception", exceptions.length === 0, JSON.stringify(exceptions).slice(0, 300));
}

/** 2 and 3: no ambient credential anywhere, and the stream authenticates itself. */
async function checkNoAmbientCredential(page: Page, origin: string): Promise<void> {
  const cookies = String(await page.evaluate("document.cookie"));
  const stored = (await page.client.send("Network.getCookies", { urls: [origin] }, page.session)).cookies as unknown[];
  check("the page holds no readable cookie", cookies === "", `document.cookie was ${JSON.stringify(cookies)}`);
  check("the browser stores no cookie for the daemon origin", stored.length === 0, JSON.stringify(stored).slice(0, 300));

  const streams = page.client.events.filter(
    (event) =>
      event.method === "Network.requestWillBeSent" &&
      String((event.params.request as { url?: string }).url).endsWith("/api/events"),
  );
  check("the app opened its event stream", streams.length > 0, "no /api/events request was observed");
  // The header itself, not just "nothing was refused": an EventSource
  // authenticated by a cookie would satisfy the weaker check, which is the
  // regression this file exists to catch (a review's note).
  const authorized = streams.some((event) => {
    const headers = (event.params.request as { headers?: Record<string, string> }).headers ?? {};
    return Object.entries(headers).some(
      ([name, value]) => name.toLowerCase() === "authorization" && value.startsWith("Bearer "),
    );
  });
  check(
    "the event stream carries a bearer header",
    authorized,
    `no Authorization header on any /api/events request (${streams.length} seen)`,
  );
  const refused = page.client.events.filter(
    (event) =>
      event.method === "Network.responseReceived" &&
      [401, 403].includes((event.params.response as { status?: number }).status ?? 0),
  );
  check(
    "nothing was refused",
    refused.length === 0,
    refused
      .map(
        (event) =>
          `${(event.params.response as { status: number }).status} ${(event.params.response as { url: string }).url}`,
      )
      .join("; "),
  );
}

/** Real browser terminal: refusal must never count as positive acceptance. */
async function checkTerminalHandshake(page: Page, origin: string, home: string): Promise<void> {
  // Same-origin document without mounting the app (which auto-attaches a terminal).
  await page.client.send("Page.navigate", { url: `${origin}/api/health` }, page.session);
  await waitInPage(page, 'location.pathname === "/api/health"', "terminal test origin");
  async function attempt(mode: "valid" | "invalid" | "preauth") {
    return await page.evaluate(`new Promise((resolve) => {
      const frames = []; let output = ""; let settled = false;
      const socket = new WebSocket(location.origin.replace("http", "ws") + "/api/tasks/tspike/terminal?shell=0");
      const done = (code) => { if (settled) return; settled = true; clearTimeout(timer); socket.close(); resolve({ frames, output, code }); };
      const timer = setTimeout(() => done("timeout"), 6000);
      socket.onmessage = (event) => {
        const frame = JSON.parse(event.data); frames.push(frame);
        if (frame.type === "auth_required") {
          socket.send(JSON.stringify(${JSON.stringify(mode)} === "preauth" ? { type: "in", data: "echo forbidden\\n" } :
            { type: "auth", token: ${JSON.stringify(mode)} === "invalid" ? "invalid-fixture-token" : localStorage.getItem("wisp_token") }));
        }
        if (frame.type === "hello") socket.send(JSON.stringify({ type: "in", data: "printf 'browser-%s-%s\\n' terminal verified\\n" }));
        if (frame.type === "out") { output += frame.data; if (output.includes("browser-terminal-verified")) done(1000); }
      };
      socket.onclose = event => done(event.code);
      socket.onerror = () => done("error");
    })`) as { frames: { type: string; message?: string }[]; output: string; code: number | string };
  }
  for (const mode of ["preauth", "invalid"] as const) {
    const result = await attempt(mode);
    check(`${mode} terminal input is rejected without starting a shell`,
      result.frames[0]?.type === "auth_required" && result.code === 1008 &&
      result.frames.some(f => f.type === "error" && f.message === (mode === "invalid" ? "unauthorized" : "terminal protocol: this socket must authenticate first")) &&
      !result.frames.some(f => f.type === "hello") && !existsSync(join(home, "shell-starts")), JSON.stringify(result));
  }
  const result = await attempt("valid");
  check("valid terminal authentication produces hello and actual shell output",
    result.frames[0]?.type === "auth_required" && result.frames.some(f => f.type === "hello") &&
    !result.frames.some(f => f.type === "error") && result.output.includes("browser-terminal-verified") &&
    existsSync(join(home, "shell-starts")), JSON.stringify(result));
  const media = await page.evaluate(`(async () => {
    const response = await fetch('/api/tasks/tspike/attachments/1/transport.png', { headers: { Authorization: 'Bearer ' + localStorage.getItem('wisp_token') } });
    const url = URL.createObjectURL(await response.blob());
    try { const image = new Image(); image.src = url; await image.decode(); return { status: response.status, width: image.naturalWidth, cache: response.headers.get('cache-control') }; }
    finally { URL.revokeObjectURL(url); }
  })()`) as { status: number; width: number; cache: string };
  check("authenticated attachment bytes decode in the browser without HTTP caching", media.status === 200 && media.width === 1 && media.cache === "private, no-store", JSON.stringify(media));
}

/** 5: what a page on another local port can get out of the daemon. */
async function checkOtherLocalPort(page: Page, origin: string, attackerOrigin: string, token: string): Promise<void> {
  await page.client.send("Page.navigate", { url: `${attackerOrigin}/` }, page.session);
  await waitInPage(page, 'document.body.innerText.includes("another local service")', "the other service's page");
  const attack = JSON.parse(
    String(
      await page.evaluate(`(async () => {
        const out = {};
        out.leaked = await fetch("/cookies").then((response) => response.json());
        out.write = await fetch("${origin}/api/suffix-prompts", {
          method: "POST",
          credentials: "include",
          mode: "no-cors",
          headers: { "content-type": "text/plain" },
          body: JSON.stringify({ name: "forged-by-browser-check", prompt: "forged" }),
        }).then((response) => ({ type: response.type, status: response.status }))
          .catch((error) => ({ blocked: String(error.message) }));
        out.socket = await new Promise((resolve) => {
          const socket = new WebSocket("${origin.replace("http", "ws")}/api/tasks/tnothere/terminal?shell=0");
          const frames = [];
          socket.onmessage = (event) => frames.push(event.data);
          socket.onopen = () => resolve({ opened: true, frames });
          socket.onerror = () => resolve({ opened: false, frames });
          socket.onclose = (event) => resolve({ opened: false, code: event.code, frames });
          setTimeout(() => resolve({ opened: false, timedOut: true, frames }), 5000);
        });
        return JSON.stringify(out);
      })()`),
    ),
  ) as { leaked: { cookie: string | null }; socket: { opened: boolean; frames: string[] } };

  check(
    "another local port receives no Wisp credential",
    attack.leaked.cookie === null,
    `the other service received Cookie: ${String(attack.leaked.cookie)}`,
  );
  check(
    "a cross-origin terminal upgrade never opens",
    attack.socket.opened === false && attack.socket.frames.length === 0,
    JSON.stringify(attack.socket),
  );
  const prompts = (await (
    await fetch(`${origin}/api/suffix-prompts`, { headers: { authorization: `Bearer ${token}` } })
  ).json()) as { suffixPrompts: { name: string }[] };
  check(
    "a cross-origin write creates nothing",
    !prompts.suffixPrompts.some((prompt) => prompt.name === "forged-by-browser-check"),
    `suffix prompts after the attack: ${JSON.stringify(prompts)}`,
  );
}

/** 6: the app refuses to be framed, and the browser says so. */
async function checkFraming(page: Page, attackerOrigin: string): Promise<void> {
  const before = page.client.events.length;
  await page.client.send("Page.navigate", { url: `${attackerOrigin}/frame` }, page.session);
  // The frame either loads or is refused; either way the decision is made once
  // the iframe element exists and the browser has had a turn at it.
  await waitInPage(page, '!!document.getElementById("f")', "the framing attempt");
  await sleep(1_000);
  const framed = String(
    await page.evaluate(`(() => {
      try {
        const document_ = document.getElementById("f").contentDocument;
        return document_ ? (document_.body?.innerText ?? "empty document") : "no contentDocument";
      } catch (error) { return "cross-origin: " + error.message; }
    })()`),
  );
  const refusal = page.client.events
    .slice(before)
    .filter((event) => event.method === "Log.entryAdded")
    .map((event) => (event.params.entry as { text?: string }).text ?? "")
    .filter((text) => /frame|ancestors/i.test(text));
  // "no contentDocument" is a frame the browser REFUSED. A frame that loaded
  // cross-origin has one this page may not read, which reports a SecurityError
  // instead — that is what an unprotected daemon looks like, and it is why the
  // weaker "did it render?" assertion is not enough.
  check(
    "the app cannot be framed",
    framed === "no contentDocument",
    `the frame reported ${JSON.stringify(framed.slice(0, 200))} instead of being refused outright`,
  );
  check("the browser says why it refused the frame", refusal.length > 0, "no framing refusal was logged");
}

async function main(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "wisp-browser-check-home-"));
  const profile = await mkdtemp(join(tmpdir(), "wisp-browser-check-chrome-"));
  const entry = join(import.meta.dir, "..", "wispd", "src", "index.ts");
  let daemon: Bun.Subprocess | null = null;
  let attacker: Bun.Server<undefined> | null = null;
  let chrome: Bun.Subprocess | null = null;
  let page: Page | null = null;

  try {
    const started = await startDaemon(home, entry);
    daemon = started.daemon;
    const attackerOrigin = `http://127.0.0.1:${started.port + 1}`;
    attacker = startOtherLocalService(started.port + 1, started.origin);
    const browser = await startBrowser(profile, started.token);
    chrome = browser.chrome;
    page = browser.page;

    await checkTerminalHandshake(page, started.origin, home);
    const archived = await fetch(`${started.origin}/api/tasks/tspike/archive`, {
      method: "POST", headers: { authorization: `Bearer ${started.token}`, "content-type": "application/json" }, body: JSON.stringify({ force: true }),
    });
    if (!archived.ok) throw new Error(`fixture archive failed: ${await archived.text()}`);
    // App-load assertions concern its own navigation, not the JSON document's favicon.
    page.client.events.length = 0;
    await checkTheAppLoads(page, started.origin);
    await checkNoAmbientCredential(page, started.origin);
    await checkOtherLocalPort(page, started.origin, attackerOrigin, started.token);
    await checkFraming(page, attackerOrigin);
  } finally {
    page?.client.close();
    if (chrome) {
      chrome.kill();
      await chrome.exited;
    }
    attacker?.stop(true);
    if (daemon) {
      daemon.kill();
      await daemon.exited;
    }
    await rm(profile, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }

  for (const name of passes) console.log(`  ok   ${name}`);
  for (const { check: name, detail } of failures) console.error(`  FAIL ${name}: ${detail}`);
  console.log(`\n${passes.length} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

await main();
