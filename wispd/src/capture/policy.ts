/**
 * What a daemon-launched browser may reach, and how a captured page's URL is
 * written down. The agent holds a shell and the daemon's token, so none of
 * this is a boundary against the agent: it keeps hostile page content (the
 * app under review, a dependency it loads) away from the LAN, metadata hosts,
 * other local services and Wisp itself, and keeps secrets in a URL out of what
 * Wisp stores and shows.
 */
import { isIP } from "node:net"

export class CaptureUrlError extends Error {}

/** The page a capture opens: http(s) on this machine's loopback, nothing else. */
export function parseCaptureUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new CaptureUrlError(`not a URL: ${raw.slice(0, 200)}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CaptureUrlError(`only http and https pages can be captured (serve a static build on 127.0.0.1 instead of ${url.protocol})`)
  }
  if (url.username || url.password) throw new CaptureUrlError("a capture URL may not carry a user name or password")
  if (url.hostname === "0.0.0.0" || url.hostname === "[::]") {
    throw new CaptureUrlError(`${url.hostname} is where a server listens, not an address to open: use 127.0.0.1`)
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new CaptureUrlError(`only an app on this machine's loopback can be captured (localhost, *.localhost, 127.0.0.1, [::1]), not ${url.hostname}`)
  }
  return url
}

/** The port a URL talks to, defaults included. */
export function portOf(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80
}

/** A loopback host as WHATWG URL parsing leaves it (so `127.1` and `0x7f.1` are already `127.0.0.1`). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  if (host === "localhost" || host.endsWith(".localhost")) return true
  const bare = host.startsWith("[") ? host.slice(1, -1) : host
  return isIP(bare) !== 0 && loopbackAddress(bare)
}

function v4(address: string): number[] | null {
  const parts = address.split(".").map(Number)
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null
}

/** An IPv6 address's embedded IPv4 (::ffff:a.b.c.d, or its hex form), if it has one. */
function mappedV4(address: string): string | null {
  const lower = address.toLowerCase()
  const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) return dotted[1]!
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (!hex) return null
  const high = parseInt(hex[1]!, 16), low = parseInt(hex[2]!, 16)
  return [high >> 8, high & 255, low >> 8, low & 255].join(".")
}

export function loopbackAddress(address: string): boolean {
  const four = v4(mappedV4(address) ?? address)
  if (four) return four[0] === 127
  return address === "::1" || /^0*:0*:0*:0*:0*:0*:0*:0*1$/.test(address)
}

/** Why an address that is not loopback is refused, or null when it is a public one. */
export function privateAddressReason(address: string): string | null {
  const four = v4(mappedV4(address) ?? address)
  return four ? privateV4Reason(four) : privateV6Reason(address.toLowerCase())
}

function privateV4Reason(four: number[]): string | null {
  const [a, b] = four as [number, number, number, number]
  if (a === 0) return "an unspecified address"
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "a private network"
  if (a === 100 && b >= 64 && b <= 127) return "a carrier-grade NAT network"
  if (a === 169 && b === 254) return "a link-local or metadata address"
  if (a === 192 && b === 0) return "a reserved network"
  if (a === 198 && (b === 18 || b === 19)) return "a benchmarking network"
  if (a >= 224) return "a multicast or reserved address"
  return null
}

function privateV6Reason(lower: string): string | null {
  if (lower === "::" || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return "a link-local address"
  if (lower.startsWith("fc") || lower.startsWith("fd")) return "a private network"
  if (lower.startsWith("ff")) return "a multicast address"
  if (lower.startsWith("64:ff9b:") || lower.startsWith("2001:db8")) return "a reserved network"
  return null
}

/** Where one capture's browser may go. */
export interface ReachPolicy {
  /** loopback ports the page may use: the page's own, the task's PORT range, and any the agent named */
  loopbackPorts: ReadonlySet<number>
  /** Wisp's own port, never reachable whatever else is allowed */
  daemonPort: number
  /** whether public internet hosts (fonts, CDNs) may be loaded */
  publicAllowed: boolean
}

export type ReachDecision = { allow: true } | { allow: false; reason: string }

/** May the browser connect to this address and port? The address is the one the proxy resolved and will dial. */
export function mayReach(policy: ReachPolicy, address: string, port: number): ReachDecision {
  if (loopbackAddress(address)) {
    if (port === policy.daemonPort) return { allow: false, reason: "Wisp's own port" }
    return policy.loopbackPorts.has(port) ? { allow: true } : { allow: false, reason: `local port ${port} is not this capture's (add --allow-port ${port})` }
  }
  const reason = privateAddressReason(address)
  if (reason) return { allow: false, reason }
  return policy.publicAllowed ? { allow: true } : { allow: false, reason: "public hosts are off for this project" }
}

/** Query and fragment keys that may hold a credential. */
const CREDENTIAL = /token|key|secret|code|pass|session|auth|sig|cred/i

/**
 * A URL as Wisp stores and shows it: no user name or password, every query
 * value replaced with `*`, and a fragment kept (hash routes are what a page *is*)
 * unless one of its pairs looks like a credential.
 */
export function sanitizeUrl(raw: string | URL): string {
  let url: URL
  try {
    url = new URL(String(raw))
  } catch {
    return "(not a URL)"
  }
  url.username = ""
  url.password = ""
  const keys = [...new Set(url.searchParams.keys())]
  url.search = keys.length > 0 ? `?${keys.map((key) => `${encodeURIComponent(key)}=*`).join("&")}` : ""
  const pairs = url.hash.slice(1).split(/[&?]/).filter((pair) => pair.includes("="))
  if (pairs.some((pair) => CREDENTIAL.test(pair.split("=")[0]!))) url.hash = "#redacted"
  return url.toString()
}
