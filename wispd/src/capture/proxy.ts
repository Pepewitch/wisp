/**
 * One capture's way out: Chrome is started with this as its proxy for every
 * scheme and host, loopback included, so frames, workers, service workers,
 * popups, WebSockets and redirects all pass the same check. It resolves a name
 * itself and dials the address it checked, so a name that answers loopback
 * once and the LAN the next time gains nothing.
 */
import { lookup } from "node:dns/promises"
import { connect, createServer, isIP, type Server, type Socket } from "node:net"
import { mayReach, type ReachPolicy } from "./policy"

/** A request head larger than this is refused: Chrome's are a few kilobytes. */
const HEAD_MAX = 64 * 1024
const DIAL_TIMEOUT_MS = 10_000
/** Marks the proxy's own refusal, so the page's watcher can tell it from the app's 403. */
export const REFUSED_HEADER = "X-Wisp-Capture-Refused"

export interface CaptureProxy {
  port: number
  /** every refusal, as "host:port (reason)", in order; capped */
  refused: string[]
  close(): Promise<void>
}

type Resolve = (host: string) => Promise<string[]>

const resolveHost: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address)

/** Start a proxy on 127.0.0.1 for one capture. */
export async function startCaptureProxy(policy: ReachPolicy, options: { resolve?: Resolve } = {}): Promise<CaptureProxy> {
  const refused: string[] = []
  const sockets = new Set<Socket>()
  const resolve = options.resolve ?? resolveHost
  const server: Server = createServer((client) => {
    sockets.add(client)
    client.on("close", () => sockets.delete(client))
    client.on("error", () => client.destroy())
    void serve(client, policy, resolve, (line) => { if (refused.length < 50) refused.push(line) }, sockets)
  })
  await new Promise<void>((done, fail) => {
    server.once("error", fail)
    server.listen(0, "127.0.0.1", () => done())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("the capture proxy has no port")
  return {
    port: address.port,
    refused,
    close: () => new Promise<void>((done) => {
      for (const socket of sockets) socket.destroy()
      server.close(() => done())
    }),
  }
}

/** Read one request head: the bytes up to and including the blank line, and any that came after it. */
function readHead(client: Socket): Promise<{ head: string; rest: Buffer } | null> {
  return new Promise((done) => {
    let buffered = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf("\r\n\r\n")
      if (end === -1 && buffered.length <= HEAD_MAX) return
      client.off("data", onData)
      client.pause()
      if (end === -1) return done(null)
      done({ head: buffered.subarray(0, end + 4).toString("latin1"), rest: buffered.subarray(end + 4) })
    }
    client.on("data", onData)
    client.once("end", () => done(null))
  })
}

/** Where a request goes: CONNECT's authority, or an absolute-form URL's host and port. */
function targetOf(head: string): { connect: boolean; host: string; port: number; path: string } | null {
  const [method, target] = head.split("\r\n", 1)[0]!.split(" ")
  if (!method || !target) return null
  if (method === "CONNECT") {
    const match = target.match(/^\[?([^\]]+?)\]?:(\d+)$/)
    return match ? { connect: true, host: match[1]!, port: Number(match[2]), path: "" } : null
  }
  try {
    const url = new URL(target)
    if (url.protocol !== "http:" && url.protocol !== "ws:") return null
    const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname
    return { connect: false, host, port: url.port ? Number(url.port) : 80, path: `${url.pathname}${url.search}` }
  } catch {
    return null
  }
}

/** The address this proxy dials for a host: loopback names never go to DNS. */
async function addressOf(host: string, resolve: Resolve): Promise<string | null> {
  const lower = host.toLowerCase()
  if (lower === "localhost" || lower.endsWith(".localhost")) return "127.0.0.1"
  if (isIP(host)) return host
  try {
    const addresses = await resolve(host)
    return addresses[0] ?? null
  } catch {
    return null
  }
}

async function serve(client: Socket, policy: ReachPolicy, resolve: Resolve, refuse: (line: string) => void, sockets: Set<Socket>): Promise<void> {
  const request = await readHead(client)
  const target = request ? targetOf(request.head) : null
  if (!request || !target) return void client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
  const address = await addressOf(target.host, resolve)
  const decision = address ? mayReach(policy, address, target.port) : { allow: false as const, reason: "the name did not resolve" }
  if (!decision.allow || !address) {
    refuse(`${target.host}:${target.port} (${decision.allow ? "the name did not resolve" : decision.reason})`)
    return void client.end(`HTTP/1.1 403 Forbidden\r\n${REFUSED_HEADER}: 1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  }
  const upstream = connect({ host: address, port: target.port, timeout: DIAL_TIMEOUT_MS })
  sockets.add(upstream)
  upstream.on("close", () => { sockets.delete(upstream); client.destroy() })
  client.on("close", () => upstream.destroy())
  upstream.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"))
  upstream.on("timeout", () => upstream.destroy())
  upstream.once("connect", () => {
    upstream.setTimeout(0)
    if (target.connect) {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
    } else {
      // origin-form to the server, and one request per connection: a later
      // request on a reused connection could name another host. An upstream
      // that ignores Connection: close could still be sent such a request,
      // but only that already-allowed upstream: nothing reaches a refused one,
      // so the client side is not cut (that would mean parsing request bodies)
      upstream.write(originForm(request.head, target.path))
    }
    if (request.rest.length > 0) upstream.write(request.rest)
    client.pipe(upstream)
    upstream.pipe(client)
    client.resume()
  })
}

/** A proxied request head rewritten for the server: origin-form, no proxy headers, closed after one response. */
function originForm(head: string, path: string): string {
  const lines = head.slice(0, -4).split("\r\n")
  const [method, , version] = lines[0]!.split(" ")
  const upgrade = lines.some((line) => /^upgrade:/i.test(line))
  const kept = lines.slice(1).filter((line) => !/^(proxy-connection|proxy-authorization|connection|keep-alive):/i.test(line))
  // a WebSocket keeps its connection by design; anything else is closed after one response
  const connection = upgrade ? "Connection: Upgrade" : "Connection: close"
  return [`${method} ${path || "/"} ${version}`, ...kept, connection, "", ""].join("\r\n")
}
