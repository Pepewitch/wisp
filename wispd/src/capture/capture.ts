/**
 * One capture, end to end: a proxy, a fresh Chrome behind it, the page opened
 * and settled, the agent's script run, the shot taken within every size limit,
 * and everything torn down whatever happened. What it returns is what Wisp
 * itself saw; a page that failed to load is never stored as evidence.
 */
import { randomBytes } from "node:crypto"
import { CdpClient, type CdpEvent } from "./cdp"
import { launchChrome, stopChrome } from "./chrome"
import { portOf, sanitizeUrl } from "./policy"
import { REFUSED_HEADER, startCaptureProxy } from "./proxy"

/** Why a capture failed, as the attempt record keeps it. */
export type CaptureReason = "no-chrome" | "launch-failed" | "unreachable" | "http-error" | "refused" | "timeout" | "script-error" | "busy" | "cancelled" | "no-element" | "browser-error"

export class CaptureFailure extends Error {
  constructor(readonly reason: CaptureReason, message: string) { super(message) }
}

export type Viewport = { width: number; height: number; mobile: boolean }
export const VIEWPORTS: Record<"desktop" | "mobile", Viewport> = {
  desktop: { width: 1280, height: 900, mobile: false },
  mobile: { width: 390, height: 844, mobile: true },
}
export const MAX_VIEWPORT = 2560
/** Every side of a stored shot stays under the image APIs' limit. */
export const MAX_SIDE_PX = 7680
/** Every shot fits the smallest attachment path (5 MiB) so it can reach any author. */
export const MAX_SHOT_BYTES = 5 * 1024 * 1024
export const SCRIPT_MAX_BYTES = 64 * 1024
export const PAGE_TIMEOUT_MS = 30_000
export const SCRIPT_TIMEOUT_MS = 10_000
const QUIET_MS = 500
const QUIET_CAP_MS = 5_000
const MAX_TARGETS = 8
const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

export interface CaptureRequest {
  url: URL
  viewport: Viewport
  dark: boolean
  selector: string | null
  fullPage: boolean
  waitFor: string | null
  waitMs: number
  script: string | null
}

export interface CaptureContext {
  chromePath: string
  daemonPort: number
  /** loopback ports beyond the page's own: the task's PORT range and --allow-port */
  ports: number[]
  publicAllowed: boolean
  signal?: AbortSignal
}

export interface CaptureShot {
  bytes: Uint8Array
  mediaType: "image/png" | "image/jpeg"
  width: number
  height: number
  dpr: number
  finalUrl: string
  status: number
  errors: string[]
  blocked: string[]
  settled: boolean
  clipped: boolean
}

export async function capturePage(request: CaptureRequest, context: CaptureContext): Promise<CaptureShot> {
  const proxy = await startCaptureProxy({
    loopbackPorts: new Set([portOf(request.url), ...context.ports]), daemonPort: context.daemonPort, publicAllowed: context.publicAllowed,
  })
  let chrome: Awaited<ReturnType<typeof launchChrome>> | null = null
  let client: CdpClient | null = null
  try {
    try {
      chrome = await launchChrome(context.chromePath, `c${randomBytes(6).toString("hex")}`, proxy.port, context.signal)
      client = await CdpClient.connect(chrome.endpoint)
    } catch (error) {
      if (context.signal?.aborted) throw new CaptureFailure("cancelled", "the capture was cancelled")
      throw new CaptureFailure("launch-failed", error instanceof Error ? error.message : String(error))
    }
    try {
      return await withDeadline(shoot(client, request), PAGE_TIMEOUT_MS + SCRIPT_TIMEOUT_MS + 15_000, context.signal)
    } catch (error) {
      // whatever the browser threw is still a recorded attempt, never an unhandled error
      if (error instanceof CaptureFailure) throw error
      throw new CaptureFailure("browser-error", `the browser failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  } finally {
    client?.close()
    if (chrome) await stopChrome(chrome).catch(() => {})
    await proxy.close()
  }
}

/** The page's work, bounded as a whole: a hang anywhere ends as a timeout, a cancel as a cancel. */
function withDeadline<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CaptureFailure("timeout", `the page did not finish within ${ms / 1000}s`)), ms)
    const cancel = () => reject(new CaptureFailure("cancelled", "the capture was cancelled"))
    signal?.addEventListener("abort", cancel, { once: true })
    work.then(resolve, reject).finally(() => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", cancel)
    })
  })
}

async function shoot(client: CdpClient, request: CaptureRequest): Promise<CaptureShot> {
  await client.send("Browser.setDownloadBehavior", { behavior: "deny" })
  await limitTargets(client)
  const { targetId } = await client.send("Target.createTarget", { url: "about:blank" }) as { targetId: string }
  const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true }) as { sessionId: string }
  const send = (method: string, params: Record<string, unknown> = {}, timeoutMs?: number) => client.send(method, params, sessionId, timeoutMs)
  const page = watchPage(client, sessionId)
  try {
    for (const domain of ["Page", "Runtime", "Network"]) await send(`${domain}.enable`)
    await send("Network.setCacheDisabled", { cacheDisabled: true })
    await send("Network.setBypassServiceWorker", { bypass: true })
    await emulate(send, request)
    const loaded = client.waitFor((event) => event.sessionId === sessionId && event.method === "Page.loadEventFired", PAGE_TIMEOUT_MS, "the page to load")
    const navigated = await send("Page.navigate", { url: request.url.toString() }, PAGE_TIMEOUT_MS) as { errorText?: string; frameId?: string }
    if (navigated.errorText) {
      loaded.catch(() => {})
      throw new CaptureFailure("unreachable", `could not open ${request.url.host}: ${navigated.errorText} (is the app running on that port?)`)
    }
    await loaded
    if (page.status() >= 400) throw new CaptureFailure("http-error", `the page answered HTTP ${page.status()}`)
    // --wait-for and --wait describe the state to shoot: after the script when there is one
    let settled = await settle(send, page, request.script ? { waitFor: null, waitMs: 0 } : request)
    if (request.script) {
      await runScript(send, request.script)
      settled = await settle(send, page, request) && settled
    }
    const finalUrl = String((await evaluate(send, "location.href")) ?? request.url)
    const image = await screenshot(send, request)
    return { ...image, finalUrl, status: page.status(), errors: page.errors(), blocked: page.blocked(), settled }
  } finally {
    page.stop()
  }
}

/** Popups beyond a handful are closed as they open. */
async function limitTargets(client: CdpClient): Promise<void> {
  let pages = 0
  client.on((event) => {
    if (event.method !== "Target.targetCreated") return
    const info = event.params.targetInfo as { targetId: string; type: string }
    if (info.type === "page" && ++pages > MAX_TARGETS) void client.send("Target.closeTarget", { targetId: info.targetId }).catch(() => {})
  })
  await client.send("Target.setDiscoverTargets", { discover: true })
}

async function emulate(send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>, request: CaptureRequest): Promise<void> {
  const { width, height, mobile } = request.viewport
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile })
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: request.dark ? "dark" : "light" }] })
  if (mobile) {
    await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 })
    await send("Emulation.setUserAgentOverride", { userAgent: MOBILE_UA, platform: "iPhone" })
  }
}

/**
 * The main document's status, the page's errors, what of the page's own the
 * proxy refused (Chrome's background calls are not the page's), and how many
 * requests are in flight.
 */
function watchPage(client: CdpClient, sessionId: string) {
  let status = 0
  let inflight = 0
  let lastActivity = Date.now()
  const errors: string[] = []
  const blocked = new Set<string>()
  const urls = new Map<string, string>()
  const note = (text: string) => { if (errors.length < 20) errors.push(text.slice(0, 300)) }
  const stop = client.on((event: CdpEvent) => {
    if (event.sessionId !== sessionId) return
    const params = event.params
    if (event.method === "Network.responseReceived") {
      const response = params.response as { status?: number; url?: string; headers?: Record<string, string> }
      // a refusal of plain http arrives as the proxy's own 403, a tunnel's as a failed connection (below)
      if (Object.keys(response.headers ?? {}).some((name) => name.toLowerCase() === REFUSED_HEADER.toLowerCase())) {
        if (blocked.size < 20) blocked.add(sanitizeUrl(response.url ?? ""))
      } else if (params.type === "Document" && status === 0) {
        status = Number(response.status ?? 0)
      }
    }
    if (event.method === "Network.requestWillBeSent") {
      inflight++
      lastActivity = Date.now()
      urls.set(String(params.requestId), String((params.request as { url?: string }).url ?? ""))
    }
    if (event.method === "Network.loadingFinished" || event.method === "Network.loadingFailed") { inflight = Math.max(0, inflight - 1); lastActivity = Date.now() }
    // the proxy's 403 reaches the page as a failed tunnel or connection
    if (event.method === "Network.loadingFailed" && /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(String(params.errorText)) && blocked.size < 20) {
      blocked.add(sanitizeUrl(urls.get(String(params.requestId)) ?? ""))
    }
    if (event.method === "Runtime.exceptionThrown") note(String((params.exceptionDetails as { exception?: { description?: string }; text?: string }).exception?.description ?? (params.exceptionDetails as { text?: string }).text ?? "an exception"))
    if (event.method === "Runtime.consoleAPICalled" && params.type === "error") note((params.args as { value?: unknown; description?: string }[]).map((arg) => String(arg.value ?? arg.description ?? "")).join(" "))
  })
  return { status: () => status, errors: () => [...errors], blocked: () => [...blocked], quietFor: () => (inflight === 0 ? Date.now() - lastActivity : 0), stop }
}

type Send = (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>

async function evaluate(send: Send, expression: string): Promise<unknown> {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true }) as { result?: { value?: unknown } }
  return result.result?.value
}

/** --wait-for, then --wait, then the network quiet for a moment (capped: SSE and HMR never go quiet). */
async function settle(send: Send, page: ReturnType<typeof watchPage>, request: Pick<CaptureRequest, "waitFor" | "waitMs">): Promise<boolean> {
  if (request.waitFor) {
    const deadline = Date.now() + PAGE_TIMEOUT_MS
    while ((await evaluate(send, `document.querySelector(${JSON.stringify(request.waitFor)}) !== null`)) !== true) {
      if (Date.now() > deadline) throw new CaptureFailure("timeout", `nothing matched ${request.waitFor} within ${PAGE_TIMEOUT_MS / 1000}s`)
      await Bun.sleep(100)
    }
  }
  if (request.waitMs > 0) await Bun.sleep(request.waitMs)
  const cap = Date.now() + QUIET_CAP_MS
  while (page.quietFor() < QUIET_MS) {
    if (Date.now() > cap) return false
    await Bun.sleep(50)
  }
  return true
}

async function runScript(send: Send, script: string): Promise<void> {
  // Runtime.evaluate's own timeout bounds only synchronous work; an awaited promise is bounded by the command's
  const result = await send("Runtime.evaluate", {
    expression: `(async () => {\n${script}\n})()`, awaitPromise: true, returnByValue: true, timeout: SCRIPT_TIMEOUT_MS,
  }, SCRIPT_TIMEOUT_MS).catch(() => {
    throw new CaptureFailure("script-error", `the --script did not finish within ${SCRIPT_TIMEOUT_MS / 1000}s`)
  }) as { exceptionDetails?: { exception?: { description?: string }; text?: string } }
  if (result.exceptionDetails) {
    const said = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "it threw"
    throw new CaptureFailure("script-error", `the --script failed: ${said.split("\n")[0]!.slice(0, 300)}`)
  }
}

/** The shot, within every limit: ≤ MAX_SIDE_PX a side and ≤ MAX_SHOT_BYTES, PNG when it fits, else JPEG, else smaller. */
async function screenshot(send: Send, request: CaptureRequest): Promise<{ bytes: Uint8Array; mediaType: "image/png" | "image/jpeg"; width: number; height: number; dpr: number; clipped: boolean }> {
  let clip = { x: 0, y: 0, width: request.viewport.width, height: request.viewport.height }
  let clipped = false
  if (request.selector) {
    const box = await evaluate(send, `(() => { const r = document.querySelector(${JSON.stringify(request.selector)})?.getBoundingClientRect(); return r ? { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height } : null })()`) as typeof clip | null
    if (!box || box.width < 1 || box.height < 1) throw new CaptureFailure("no-element", `nothing visible matched ${request.selector}`)
    clip = box
  } else if (request.fullPage) {
    const metrics = await send("Page.getLayoutMetrics") as { cssContentSize?: { width: number; height: number } }
    clip.height = Math.max(clip.height, Math.ceil(metrics.cssContentSize?.height ?? clip.height))
  }
  if (clip.height > MAX_SIDE_PX) { clip.height = MAX_SIDE_PX; clipped = true }
  if (clip.width > MAX_SIDE_PX) { clip.width = MAX_SIDE_PX; clipped = true }
  const attempts: { format: "png" | "jpeg"; scale: number }[] = [{ format: "png", scale: 2 }, { format: "jpeg", scale: 2 }, { format: "jpeg", scale: 1 }]
  for (const attempt of attempts) {
    const scale = Math.min(attempt.scale, MAX_SIDE_PX / Math.max(clip.width, clip.height))
    const shot = await send("Page.captureScreenshot", {
      format: attempt.format, ...(attempt.format === "jpeg" ? { quality: 85 } : {}), captureBeyondViewport: clip.height > request.viewport.height,
      clip: { ...clip, scale },
    }, PAGE_TIMEOUT_MS) as { data?: string }
    const bytes = Buffer.from(shot.data ?? "", "base64")
    if (bytes.length === 0) throw new CaptureFailure("timeout", "Chrome returned an empty screenshot")
    if (bytes.length <= MAX_SHOT_BYTES) {
      return { bytes, mediaType: attempt.format === "png" ? "image/png" : "image/jpeg", width: Math.round(clip.width * scale), height: Math.round(clip.height * scale), dpr: scale, clipped }
    }
  }
  throw new CaptureFailure("timeout", `the shot stays over ${MAX_SHOT_BYTES / 1024 / 1024} MiB even as a small JPEG: capture less (--selector, no --full-page)`)
}
