/**
 * A zero-dependency Chrome DevTools Protocol client: one browser WebSocket,
 * flat target sessions, events, and a time limit on every command. The
 * protocol layer only; what a capture does with it is capture.ts.
 */

type CdpMessage = {
  id?: number
  method?: string
  params?: Record<string, unknown>
  sessionId?: string
  result?: Record<string, unknown>
  error?: { code?: number; message?: string }
}

type Pending = { method: string; resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void; timer: Timer }

export type CdpEvent = { method: string; params: Record<string, unknown>; sessionId?: string }

export const COMMAND_TIMEOUT_MS = 15_000

export class CdpClient {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<(event: CdpEvent) => void>()
  /** waiters reject when the connection ends, rather than holding their timers until expiry */
  private readonly waiters = new Set<(error: Error) => void>()
  private closedWith: Error | null = null

  private constructor(private readonly socket: WebSocket) {
    socket.onmessage = (event) => this.receive(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer))
    socket.onclose = () => this.fail(new Error("Chrome closed the DevTools connection"))
    socket.onerror = () => this.fail(new Error("the DevTools connection failed"))
  }

  static async connect(url: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<CdpClient> {
    const socket = new WebSocket(url)
    socket.binaryType = "arraybuffer"
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error(`no DevTools connection within ${timeoutMs / 1000}s`)) }, timeoutMs)
      socket.onopen = () => { clearTimeout(timer); resolve() }
      socket.onerror = () => { clearTimeout(timer); reject(new Error(`could not connect to Chrome DevTools at ${url}`)) }
    })
    return new CdpClient(socket)
  }

  /** Every event, for as long as the returned function is not called. */
  on(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The next event that matches, or a rejection after the time limit. */
  waitFor(match: (event: CdpEvent) => boolean, timeoutMs: number, what: string): Promise<CdpEvent> {
    if (this.closedWith) return Promise.reject(this.closedWith)
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); off(); this.waiters.delete(fail) }
      const fail = (error: Error) => { done(); reject(error) }
      const timer = setTimeout(() => fail(new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`)), timeoutMs)
      const off = this.on((event) => {
        if (!match(event)) return
        done()
        resolve(event)
      })
      this.waiters.add(fail)
    })
  }

  /** One command; a target's commands carry its sessionId (flatten: true). */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<Record<string, unknown>> {
    if (this.closedWith) return Promise.reject(this.closedWith)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} took longer than ${timeoutMs / 1000}s`))
      }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      try {
        this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  close(): void {
    this.fail(new Error("the DevTools connection was closed"))
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) this.socket.close()
  }

  private receive(raw: string): void {
    let message: CdpMessage
    try {
      message = JSON.parse(raw) as CdpMessage
    } catch {
      return
    }
    if (message.id === undefined) {
      if (!message.method) return
      const event: CdpEvent = { method: message.method, params: message.params ?? {}, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }
      for (const listener of [...this.listeners]) listener(event)
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) pending.reject(new Error(`CDP ${pending.method}: ${message.error.message ?? "command failed"}`))
    else pending.resolve(message.result ?? {})
  }

  private fail(error: Error): void {
    if (this.closedWith) return
    this.closedWith = error
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    for (const waiter of [...this.waiters]) waiter(error)
  }
}
