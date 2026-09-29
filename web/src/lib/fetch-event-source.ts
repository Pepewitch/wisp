import { RECONNECT_CAP_MS, reconnectDelay } from "./backoff"
import type { DaemonEventStream } from "./transport"

/**
 * `EventSource`, rebuilt on `fetch` so it can carry an Authorization header.
 *
 * The browser's own `EventSource` cannot send headers. That single limitation
 * is why the daemon used to mint an ambient `wisp_token` cookie whose value
 * was the root token — and cookies are scoped to host, never to port, so every
 * other local HTTP service received a full-control credential (SEC-01). Moving
 * the stream onto `fetch` is what lets the token stay in a header where only
 * this page can put it.
 *
 * What it reproduces, because the app depends on each of them:
 *
 *   * `readyState`, with the same numbers. `CLOSED` specifically means "this
 *     will not come back on its own" — the events bridge and the log pane both
 *     use it to decide whether to re-authenticate and rebuild.
 *   * automatic reconnection with a retry delay for TRANSIENT failures (a
 *     dropped stream, a 502 from a proxy, a slept laptop), and no reconnection
 *     for a refusal (401/403/404), which retrying could not fix.
 *   * `onopen` on every successful (re)connect, `onerror` on every drop, and
 *     named-event dispatch through `addEventListener` alongside `onmessage`.
 *
 * What it deliberately does not reproduce: `Last-Event-ID` resumption. Wisp's
 * streams already re-send what a client needs on reconnect — the log stream
 * replays the current turn's backlog, and the events bridge invalidates every
 * query once — so an id-based resume would add a second, weaker recovery path
 * next to the one the daemon already guarantees.
 */

/** EventSource.CONNECTING */
const CONNECTING = 0
/** EventSource.OPEN */
const OPEN = 1
/** EventSource.CLOSED */
const CLOSED = 2

/** Statuses no amount of retrying will fix; everything else is treated as transient. */
const FATAL_STATUS = new Set([400, 401, 403, 404, 405, 410])

/**
 * Both daemon streams send a heartbeat every 15 s (`wispd/src/routes/stream.ts`),
 * so a stream that has heard nothing for longer than this may be a dead TCP
 * connection that a suspended phone kept looking open.
 */
const QUIET_AFTER_MS = 20_000
/**
 * How long a quiet stream gets, once the page is visible again, to deliver
 * what arrived while the page was suspended — a resumed page reads it only
 * now — before it is treated as dead and replaced.
 */
const RESUME_PROBE_MS = 3_000

export interface FetchEventStreamOptions {
  /** Fresh headers per connect, so a re-minted token is picked up on retry. */
  headers?: () => Record<string, string>
  /** Delay before the first transient reconnect; later ones back off from it. */
  retryMs?: number
  fetchImpl?: typeof fetch
  /** test seam for the reconnect jitter */
  random?: () => number
}

class FetchEventStream implements DaemonEventStream {
  onmessage: ((event: { data: string }) => void) | null = null
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null

  private state: number = CONNECTING
  private readonly listeners = new Map<
    string,
    ((event: { data: string }) => void)[]
  >()
  private controller: AbortController | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private probeTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  /** When this stream last heard from the daemon, or last started trying to. */
  private lastSignal = 0
  /** Transient failures since the last successful open, for the backoff. */
  private failures = 0

  private readonly url: string
  private readonly options: FetchEventStreamOptions

  constructor(url: string, options: FetchEventStreamOptions) {
    this.url = url
    this.options = options
    window.addEventListener("online", this.resume)
    document.addEventListener("visibilitychange", this.resume)
    void this.run()
  }

  /**
   * The page came back, or the network did. A stream that is already waiting
   * to retry tries now. A network change replaces the stream. A tab that was
   * only hidden keeps a stream that has heard from the daemon recently: tearing
   * it down would make every client resync and every log pane replay its
   * backlog on each tab switch. A quiet one gets a moment to prove it is alive.
   */
  private resume = (event: Event): void => {
    if (this.closed || this.state === CLOSED || document.visibilityState === "hidden") return
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
      void this.run()
      return
    }
    if (event.type === "online") {
      this.replace()
      return
    }
    if (Date.now() - this.lastSignal < QUIET_AFTER_MS || this.probeTimer !== null) return
    const quietSince = this.lastSignal
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null
      if (this.closed || this.state === CLOSED || this.lastSignal !== quietSince) return
      this.replace()
    }, RESUME_PROBE_MS)
  }

  /** Give up on the current connection: report the drop and open a new one now. */
  private replace(): void {
    this.controller?.abort()
    this.state = CONNECTING
    this.onerror?.()
    if (!this.closed) void this.run()
  }

  private detachLifecycle(): void {
    window.removeEventListener("online", this.resume)
    document.removeEventListener("visibilitychange", this.resume)
  }

  get readyState(): number {
    return this.state
  }

  addEventListener(
    type: string,
    listener: (event: { data: string }) => void
  ): void {
    const existing = this.listeners.get(type)
    if (existing) existing.push(listener)
    else this.listeners.set(type, [listener])
  }

  close(): void {
    this.detachLifecycle()
    this.closed = true
    this.state = CLOSED
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (this.probeTimer !== null) clearTimeout(this.probeTimer)
    this.probeTimer = null
    this.controller?.abort()
    this.controller = null
  }

  /**
   * A drop we intend to recover from: report it, stay CONNECTING, come back —
   * sooner after a first drop than after the tenth, and never on the same
   * beat as every other client of a daemon that just restarted.
   */
  private retryLater(): void {
    if (this.closed) return
    this.state = CONNECTING
    this.onerror?.()
    if (this.closed || this.retryTimer !== null) return
    const delay = reconnectDelay(this.failures++, this.options.retryMs ?? 3_000, RECONNECT_CAP_MS, this.options.random)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.run()
    }, delay)
  }

  /** A refusal: CLOSED first, so an onerror handler sees a state that will not change. */
  private fail(): void {
    if (this.closed) return
    this.detachLifecycle()
    this.state = CLOSED
    this.onerror?.()
  }

  private async run(): Promise<void> {
    if (this.closed) return
    const controller = new AbortController()
    this.controller = controller
    this.lastSignal = Date.now()
    const doFetch = this.options.fetchImpl ?? fetch
    let response: Response
    try {
      response = await doFetch(this.url, {
        headers: { accept: "text/event-stream", ...(this.options.headers?.() ?? {}) },
        signal: controller.signal,
        cache: "no-store",
        // The bearer header is the only credential this stream has, and it
        // must not follow a redirect to somewhere we did not choose.
        credentials: "omit",
        redirect: "error",
      })
    } catch {
      // An abort from close() must not look like a network failure.
      if (!this.closed && this.controller === controller) this.retryLater()
      return
    }
    if (this.closed || this.controller !== controller) {
      void response.body?.cancel().catch(() => undefined)
      return
    }
    if (!response.ok || response.body === null) {
      // Drain the refusal so the connection can be reused rather than reset.
      void response.body?.cancel().catch(() => undefined)
      if (FATAL_STATUS.has(response.status)) this.fail()
      else this.retryLater()
      return
    }
    this.state = OPEN
    this.failures = 0
    this.lastSignal = Date.now()
    this.onopen?.()
    try {
      await this.pump(response.body, controller)
    } catch {
      // a torn stream reads exactly like a dropped one
    }
    // The daemon closed the stream (restart, sleep, proxy hangup): reconnect,
    // which is what EventSource would have done.
    if (this.controller === controller) this.retryLater()
  }

  private async pump(body: ReadableStream<Uint8Array>, controller: AbortController): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done || this.closed || this.controller !== controller) return
        // any bytes, a heartbeat included, prove the connection is alive
        this.lastSignal = Date.now()
        buffer += decoder.decode(value, { stream: true })
        // Frames are separated by a blank line. \r\n is legal in the wire
        // format even though this daemon writes \n.
        for (;;) {
          const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer)
          if (!match) break
          const frame = buffer.slice(0, match.index)
          buffer = buffer.slice(match.index + match[0].length)
          this.dispatch(frame)
          if (this.closed) return
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  private dispatch(frame: string): void {
    let event = "message"
    const data: string[] = []
    for (const rawLine of frame.split(/\r\n|\n|\r/)) {
      // A comment: the daemon's heartbeats arrive as `:` lines and carry
      // nothing, but they still prove the stream is alive.
      if (rawLine.startsWith(":")) continue
      const colon = rawLine.indexOf(":")
      const field = colon === -1 ? rawLine : rawLine.slice(0, colon)
      const rest = colon === -1 ? "" : rawLine.slice(colon + 1)
      const value = rest.startsWith(" ") ? rest.slice(1) : rest
      if (field === "event") event = value
      else if (field === "data") data.push(value)
      // `id` and `retry` are accepted and ignored: see the note on
      // Last-Event-ID above, and the retry delay is this client's policy.
    }
    if (data.length === 0) return
    const payload = { data: data.join("\n") }
    if (event === "message") this.onmessage?.(payload)
    for (const listener of this.listeners.get(event) ?? []) listener(payload)
  }
}

/**
 * Wrap a real `EventSource` in the same interface. The desktop runtime keeps
 * using the browser's implementation — its native proxy authenticates the hop —
 * and this only reconciles the handler signatures, since `EventSource` types
 * its handlers with full DOM events.
 */
export function adaptEventSource(source: EventSource): DaemonEventStream {
  return {
    get onmessage() {
      return source.onmessage as ((event: { data: string }) => void) | null
    },
    set onmessage(handler: ((event: { data: string }) => void) | null) {
      source.onmessage = handler as EventSource["onmessage"]
    },
    get onopen() {
      return source.onopen as (() => void) | null
    },
    set onopen(handler: (() => void) | null) {
      source.onopen = handler as EventSource["onopen"]
    },
    get onerror() {
      return source.onerror as (() => void) | null
    },
    set onerror(handler: (() => void) | null) {
      source.onerror = handler as EventSource["onerror"]
    },
    get readyState() {
      return source.readyState
    },
    addEventListener: (type: string, listener: (event: { data: string }) => void) => {
      source.addEventListener(type, listener as unknown as EventListener)
    },
    close: () => source.close(),
  }
}

/** Open an authenticated event stream. Mirrors `new EventSource(url)`. */
export function openFetchEventStream(
  url: string,
  options: FetchEventStreamOptions = {}
): DaemonEventStream {
  return new FetchEventStream(url, options)
}
