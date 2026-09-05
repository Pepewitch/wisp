import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const APP_ORIGIN = "http://127.0.0.1:8710";
const APP_URL = `${APP_ORIGIN}/?gate=1`;
const DEFAULT_OUTDIR = "/tmp/wisp-captures";
const READY_TIMEOUT_MS = 15_000;

type CdpMessage = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
};

type Pending = {
  method: string;
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

/** A minimal CDP client: one browser WebSocket, with flat target sessions. */
class CdpClient {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      let message: CdpMessage;
      try {
        message = JSON.parse(raw) as CdpMessage;
      } catch {
        return;
      }

      if (message.id === undefined) return; // Events do not have command ids.
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`CDP ${pending.method}: ${message.error.message ?? "command failed"}`));
      } else {
        pending.resolve(message.result ?? {});
      }
    };
    socket.onclose = () => {
      for (const pending of this.pending.values()) pending.reject(new Error("CDP WebSocket closed"));
      this.pending.clear();
    };
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      const fail = () => reject(new Error(`could not connect to Chrome DevTools at ${url}`));
      socket.onopen = () => resolve();
      socket.onerror = fail;
    });
    return new CdpClient(socket);
  }

  /**
   * With flatten:true, target commands still use the browser WebSocket, but
   * carry the attached target's sessionId in each wire message. Responses and
   * events carry that same field; command ids are enough to route our replies.
   */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const message = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      try {
        this.socket.send(JSON.stringify(message));
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readToken(): Promise<string> {
  const configPath = join(homedir(), ".wisp", "config.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(`could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!raw || typeof raw !== "object" || typeof (raw as { token?: unknown }).token !== "string") {
    throw new Error(`${configPath} does not contain a string token`);
  }
  return (raw as { token: string }).token;
}

async function preflightDaemon(): Promise<void> {
  try {
    const response = await fetch(APP_URL, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new Error(`daemon unreachable at ${APP_URL}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

async function devtoolsUrl(profile: string): Promise<string> {
  const activePort = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const lines = (await readFile(activePort, "utf8")).trim().split(/\r?\n/);
      const port = Number(lines[0]);
      const endpoint = lines[1];
      if (Number.isInteger(port) && port > 0 && endpoint) {
        // Chrome writes the ephemeral port, then a browser endpoint path.
        return endpoint.startsWith("ws://") ? endpoint : `ws://127.0.0.1:${port}${endpoint}`;
      }
    } catch {
      // The file appears shortly after Chrome starts.
    }
    await sleep(50);
  }
  throw new Error(`Chrome did not publish ${activePort} within 15s`);
}

async function waitForReady(client: CdpClient, sessionId: string, url: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = "no matching tab yet";
  while (Date.now() < deadline) {
    try {
      const result = await client.send(
        "Runtime.evaluate",
        { expression: "document.querySelector('[role=tab]') !== null", returnByValue: true },
        sessionId,
      );
      if ((result.result as { value?: unknown } | undefined)?.value === true) return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`timed out after 15s waiting for [role=tab] at ${url} (${lastError})`);
}

async function capture(
  client: CdpClient,
  sessionId: string,
  outdir: string,
  name: string,
  url: string,
  width: number,
  height: number,
  mobile: boolean,
): Promise<void> {
  await client.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile }, sessionId);
  await client.send("Page.navigate", { url }, sessionId);
  await waitForReady(client, sessionId, url);
  await sleep(1_000);
  const screenshot = await client.send("Page.captureScreenshot", { format: "png" }, sessionId);
  const data = screenshot.data;
  if (typeof data !== "string") throw new Error(`Chrome returned no PNG data for ${name}`);
  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0) throw new Error(`Chrome returned an empty PNG for ${name}`);
  const output = join(outdir, `app-${name}.png`);
  await writeFile(output, bytes);
  console.log(`wrote ${output}`);
}

async function main(): Promise<void> {
  const outdir = resolve(process.argv[2] ?? DEFAULT_OUTDIR);
  await preflightDaemon();
  const token = await readToken();
  if (!existsSync(CHROME)) throw new Error(`system Chrome not found at ${CHROME}`);
  await mkdir(outdir, { recursive: true });

  let profile: string | undefined;
  let chrome: ReturnType<typeof Bun.spawn> | undefined;
  let client: CdpClient | undefined;
  let targetId: string | undefined;
  try {
    profile = await mkdtemp(join(tmpdir(), "wisp-capture-chrome-"));
    chrome = Bun.spawn(
      [CHROME, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    client = await CdpClient.connect(await devtoolsUrl(profile));

    const created = await client.send("Target.createTarget", { url: "about:blank" });
    targetId = typeof created.targetId === "string" ? created.targetId : undefined;
    if (!targetId) throw new Error("Chrome did not return a target id");
    const attached = await client.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = typeof attached.sessionId === "string" ? attached.sessionId : undefined;
    if (!sessionId) throw new Error("Chrome did not return a target session id");

    await client.send("Page.enable", {}, sessionId);
    await client.send("Runtime.enable", {}, sessionId);
    await client.send("Network.enable", {}, sessionId);
    const cookie = await client.send("Network.setCookie", { name: "wisp_token", value: token, url: APP_ORIGIN }, sessionId);
    if (cookie.success === false) throw new Error("Chrome rejected the wisp_token cookie");

    await capture(client, sessionId, outdir, "desktop", APP_URL, 1280, 900, false);
    await capture(client, sessionId, outdir, "mobile", APP_URL, 390, 844, true);
    await capture(client, sessionId, outdir, "gallery", `${APP_ORIGIN}/#/gallery`, 1280, 900, false);
  } finally {
    if (client && targetId) {
      try {
        await client.send("Target.closeTarget", { targetId });
      } catch {
        // Chrome may already be exiting.
      }
    }
    client?.close();
    if (chrome) {
      try {
        chrome.kill();
        await chrome.exited;
      } catch {
        // Cleanup should not hide the capture error.
      }
    }
    if (profile) await rm(profile, { recursive: true, force: true });
  }
}

await main().catch((error: unknown) => {
  console.error(`capture failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
