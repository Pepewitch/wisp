import { useEffect, useState, useSyncExternalStore } from "react"

import { useDaemonTransport } from "./runtime"
import type { DaemonTransport } from "./transport"

/**
 * An `<img src>` for a daemon-protected asset.
 *
 * Attachments used to load as bare relative URLs, authenticated by the
 * ambient `wisp_token` cookie — the same cookie every other HTTP service on
 * the host received (SEC-01). Without it, an `<img>` carries no credential at
 * all, so the browser runtime fetches the bytes with its bearer header and
 * renders them from a blob URL.
 *
 * The desktop runtime is unchanged: its native proxy injects the credential on
 * the media hop, so its transport has no `fetchAsset` and this hook hands the
 * URL straight through, synchronously, exactly as before.
 *
 * Blob URLs are cached per connection and path, so scrolling a transcript back
 * and forth does not refetch. They are NOT revoked on unmount — a thumbnail
 * and the viewer show the same image, and revoking under one would break the
 * other. Eviction at the cap is what releases them.
 */

/** Enough for a long transcript's visible attachments without unbounded growth. */
const MAX_CACHED_ASSETS = 32

interface CacheEntry {
  url: string
  bytes: number
}

let revision = 0
const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
const snapshot = () => revision
const notify = () => { revision++; for (const fn of listeners) fn() }
const MAX_CACHED_BYTES = 64 * 1024 * 1024
const cache = new Map<string, CacheEntry>()
const pending = new Map<string, Promise<string>>()
/**
 * How many mounted components are rendering each asset. Kept separately from
 * the cache because a component mounts (and must be protected) BEFORE its
 * fetch resolves and creates the entry.
 */
const mountedAssets = new Map<string, number>()

/**
 * Evict past the cap — but never revoke a URL something is still rendering.
 *
 * The first version revoked the oldest entry unconditionally, which in a long
 * transcript could blank a thumbnail that was still on screen (a review's
 * note). A mounted entry is skipped and stays cached; the cap is therefore a
 * target rather than a hard bound, which is the right trade: the alternative
 * is a visibly broken image.
 */
function evictIfNeeded(): void {
  for (const [key, entry] of cache) {
    if (cache.size <= MAX_CACHED_ASSETS && [...cache.values()].reduce((n, e) => n + e.bytes, 0) <= MAX_CACHED_BYTES) return
    if ((mountedAssets.get(key) ?? 0) > 0) continue
    cache.delete(key)
    URL.revokeObjectURL(entry.url)
  }
}

/** Hold an asset while a component renders it, so eviction cannot revoke it. */
function retain(key: string): void {
  mountedAssets.set(key, (mountedAssets.get(key) ?? 0) + 1)
}

function release(key: string): void {
  const next = (mountedAssets.get(key) ?? 0) - 1
  if (next > 0) mountedAssets.set(key, next)
  else mountedAssets.delete(key)
  evictIfNeeded()
}

/** Invalidate only the originating connection/task; pending responses cannot repopulate it. */
export function clearAssetCache(connectionId?: string, pathPrefix = ""): void {
  const matches = (key: string) => connectionId === undefined || key.startsWith(`${connectionId}\n${pathPrefix}`)
  for (const [key, entry] of cache) if (matches(key)) { URL.revokeObjectURL(entry.url); cache.delete(key) }
  for (const key of pending.keys()) if (matches(key)) pending.delete(key)
  notify()
}

async function loadAsset(
  transport: DaemonTransport,
  key: string,
  path: string
): Promise<string> {
  const inFlight = pending.get(key)
  if (inFlight) return await inFlight
  const request = Promise.resolve().then(async () => {
    if (pending.get(key) !== request) throw new Error("Asset request invalidated")
    const blob = await transport.fetchAsset!(path)
    if (pending.get(key) !== request) throw new Error("Asset request invalidated")
    const url = URL.createObjectURL(blob)
    cache.set(key, { url, bytes: blob.size })
    evictIfNeeded()
    return url
  }).finally(() => { if (pending.get(key) === request) pending.delete(key) })
  pending.set(key, request)
  return await request
}

/**
 * The src to render, or null while it is loading or after it failed. A caller
 * renders the `<img>` either way: an empty src shows its alt text, which is
 * the attachment's filename.
 */
export function useAssetSrc(path: string | null): string | null {
  const transport = useDaemonTransport()
  const generation = useSyncExternalStore(subscribe, snapshot, snapshot)
  // A transport whose own hop is credentialed (the desktop proxy) needs no
  // fetch at all, so the URL is the answer during render.
  const direct =
    path !== null && transport.fetchAsset === undefined
      ? transport.assetUrl(path)
      : null
  const key = path === null ? null : `${transport.connectionId}\n${path}`
  const cached = key === null ? null : (cache.get(key)?.url ?? null)
  // Tagged with its key, so a resolved URL is never rendered for the image
  // that replaced it.
  const [, setLoaded] = useState<{ key: string; url: string } | null>(null)

  useEffect(() => {
    if (key === null || direct !== null) return
    retain(key)
    return () => release(key)
  }, [key, direct])

  useEffect(() => {
    if (path === null || key === null || direct !== null) return
    // Retained for as long as this component renders it — before the fetch
    // resolves, too, since that is when the entry appears. Eviction may drop
    // an unmounted entry; it may not revoke one that is on screen.
    let live = true
    if (cached === null) {
      void loadAsset(transport, key, path).then(
        (url) => {
          if (live) setLoaded({ key, url })
        },
        () => {
          // A refused or missing attachment renders as its alt text. The
          // manifest, not the bytes, is what tells the user it existed.
        }
      )
    }
    return () => {
      live = false
    }
  }, [transport, path, key, direct, cached, generation])

  return direct ?? cached
}
