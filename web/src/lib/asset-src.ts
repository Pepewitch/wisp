import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type RefObject } from "react"

import { watchNearViewport } from "./near-viewport"
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
 * URL straight through, synchronously, exactly as before. Its `<img>` keeps
 * the browser's own `loading="lazy"`.
 *
 * Blob URLs are cached per connection and path, so scrolling a transcript back
 * and forth does not refetch. They are NOT revoked on unmount — a thumbnail
 * and the viewer show the same image, and revoking under one would break the
 * other. Eviction at the cap is what releases them.
 *
 * A blob fetch runs in an effect, so `loading="lazy"` never applied to it: a
 * transcript fetched every image it mounted. A `lazy` caller hands the hook
 * its element and the fetch waits until that element is near the scroller's
 * visible area. Only images near it are held against eviction, so the cache
 * stays at its cap however much history is mounted.
 */

/** Enough for a long transcript's visible attachments without unbounded growth. */
const MAX_CACHED_ASSETS = 32
const MAX_CACHED_BYTES = 64 * 1024 * 1024
/** Remembered image shapes; a number each, so this only bounds a very long session. */
const MAX_REMEMBERED_RATIOS = 2_000

interface CacheEntry {
  url: string
  bytes: number
}

const cache = new Map<string, CacheEntry>()
let cachedBytes = 0
/**
 * A URL whose entry was refreshed while an image near the viewport still
 * renders it. It stays on screen until the refetch answers, so a refresh
 * never collapses a card, and is revoked as soon as it is replaced.
 */
const stale = new Map<string, string>()
/** Paths the daemon refused (a 404 or 410): rendered as unavailable, not refetched while shown. */
const failures = new Set<string>()
const pending = new Map<string, Promise<string>>()
/** Width over height of each image the last time it loaded, so an unloaded card keeps its box. */
const ratios = new Map<string, number>()
/**
 * How many components need each asset now: mounted and, for a lazy one, near
 * the viewport. Kept separately from the cache because a component needs it
 * (and must be protected) BEFORE its fetch resolves and creates the entry.
 */
const heldAssets = new Map<string, number>()
/** Each key's own subscribers, so one image loading re-renders only its own cards. */
const listeners = new Map<string, Set<() => void>>()
/** Bumped per key on a change nothing else in its snapshot shows: a cancelled request. */
const versions = new Map<string, number>()
let clock = 0

function changed(key: string): void {
  const set = listeners.get(key)
  if (!set) return
  versions.set(key, ++clock)
  for (const fn of set) fn()
}

/**
 * Everything a card renders from, so a change between its render and its
 * subscription is still seen.
 */
function snapshotOf(key: string): string {
  return `${versions.get(key) ?? 0}\n${cache.get(key)?.url ?? ""}\n${stale.get(key) ?? ""}\n${failures.has(key)}`
}

function subscribeTo(key: string, fn: () => void): () => void {
  let set = listeners.get(key)
  if (!set) listeners.set(key, (set = new Set()))
  set.add(fn)
  return () => {
    set.delete(fn)
    if (set.size > 0) return
    listeners.delete(key)
    versions.delete(key)
    // Nothing shows it any more: a later mount asks the daemon again.
    failures.delete(key)
  }
}

function drop(key: string): void {
  const entry = cache.get(key)
  if (!entry) return
  cache.delete(key)
  cachedBytes -= entry.bytes
  URL.revokeObjectURL(entry.url)
}

function dropStale(key: string): void {
  const url = stale.get(key)
  if (url === undefined) return
  stale.delete(key)
  URL.revokeObjectURL(url)
}

/**
 * Evict past the cap — but never revoke a URL something near the viewport is
 * still rendering.
 *
 * The first version revoked the oldest entry unconditionally, which in a long
 * transcript could blank a thumbnail that was still on screen (a review's
 * note). A held entry is skipped and stays cached; the cap is therefore a
 * target rather than a hard bound, which is the right trade: the alternative
 * is a visibly broken image. A mounted image far off screen is not held: it
 * falls back to its remembered box and fetches again on the way back.
 */
function evictIfNeeded(): void {
  for (const key of cache.keys()) {
    if (cache.size <= MAX_CACHED_ASSETS && cachedBytes <= MAX_CACHED_BYTES) return
    if ((heldAssets.get(key) ?? 0) > 0) continue
    drop(key)
    changed(key)
  }
}

/** Hold an asset while a component needs it, so eviction cannot revoke it. */
function retain(key: string): void {
  heldAssets.set(key, (heldAssets.get(key) ?? 0) + 1)
}

function release(key: string): void {
  const next = (heldAssets.get(key) ?? 0) - 1
  if (next > 0) {
    heldAssets.set(key, next)
    return
  }
  heldAssets.delete(key)
  if (stale.has(key)) {
    // its refetch waits for the way back; the old bytes are not kept for it
    dropStale(key)
    changed(key)
  }
  evictIfNeeded()
}

function matcher(connectionId: string | undefined, pathPrefix: string) {
  return (key: string) => connectionId === undefined || key.startsWith(`${connectionId}\n${pathPrefix}`)
}

function forget(matches: (key: string) => boolean, touched: Set<string>): void {
  for (const key of failures) if (matches(key)) { failures.delete(key); touched.add(key) }
  // a response already on its way cannot repopulate what was invalidated
  for (const key of pending.keys()) if (matches(key)) { pending.delete(key); touched.add(key) }
}

/**
 * Revoke now, on screen included: the bytes may no longer be the reader's to
 * see (a credential change, a permanent deletion, an archive that removed
 * them). Pending responses cannot repopulate it.
 */
export function clearAssetCache(connectionId?: string, pathPrefix = ""): void {
  const matches = matcher(connectionId, pathPrefix)
  const touched = new Set<string>()
  for (const key of cache.keys()) if (matches(key)) { drop(key); touched.add(key) }
  for (const key of stale.keys()) if (matches(key)) { dropStale(key); touched.add(key) }
  forget(matches, touched)
  for (const key of touched) changed(key)
}

/**
 * Ask again, without blanking: an image near the viewport keeps its current
 * bytes until the refetch answers, then swaps, or turns unavailable when the
 * daemon refuses. Anything else just drops its entry and fetches on its next
 * way into view. `skip` keeps paths whose bytes cannot change, such as a
 * content-addressed output; one that failed has no bytes to keep, so it is
 * asked again all the same (a fetch that met the daemon going down).
 */
export function refreshAssets(connectionId: string, pathPrefix = "", skip?: (path: string) => boolean): void {
  const prefixed = matcher(connectionId, pathPrefix)
  const matches = (key: string) => prefixed(key) && !skip?.(key.slice(connectionId.length + 1))
  const touched = new Set<string>()
  for (const key of failures) if (prefixed(key)) { failures.delete(key); touched.add(key) }
  for (const [key, entry] of cache) {
    if (!matches(key)) continue
    if ((heldAssets.get(key) ?? 0) > 0) {
      cache.delete(key)
      cachedBytes -= entry.bytes
      dropStale(key)
      stale.set(key, entry.url)
    } else {
      drop(key)
    }
    touched.add(key)
  }
  forget(matches, touched)
  for (const key of touched) changed(key)
}

async function loadAsset(
  transport: DaemonTransport,
  key: string,
  path: string
): Promise<string> {
  const inFlight = pending.get(key)
  if (inFlight) return await inFlight
  const request: Promise<string> = Promise.resolve().then(async () => {
    if (pending.get(key) !== request) throw new Error("Asset request invalidated")
    const blob = await transport.fetchAsset!(path)
    if (pending.get(key) !== request) throw new Error("Asset request invalidated")
    const url = URL.createObjectURL(blob)
    drop(key)
    cache.set(key, { url, bytes: blob.size })
    cachedBytes += blob.size
    dropStale(key)
    evictIfNeeded()
    changed(key)
    return url
  }).catch((error: unknown) => {
    if (pending.get(key) === request) {
      // A refused or missing attachment renders as its alt text. The
      // manifest, not the bytes, is what tells the user it existed.
      failures.add(key)
      dropStale(key)
      changed(key)
    }
    throw error
  }).finally(() => { if (pending.get(key) === request) pending.delete(key) })
  pending.set(key, request)
  return await request
}

function rememberRatio(key: string, image: HTMLImageElement): void {
  if (!image.naturalWidth || !image.naturalHeight) return
  ratios.delete(key)
  ratios.set(key, image.naturalWidth / image.naturalHeight)
  if (ratios.size > MAX_REMEMBERED_RATIOS) ratios.delete(ratios.keys().next().value!)
}

/**
 * The scroller a lazy image measures "near" against. Without one the
 * window's viewport is the root, whose margin a nested scroller clips away.
 */
export const AssetScrollRoot = createContext<RefObject<HTMLElement | null> | null>(null)

const unsubscribed = () => {}
const unobserved = () => {}

export interface AssetStatus {
  /** The src to render, or null while it is not loaded or after it failed. */
  src: string | null
  failed: boolean
  /** Width over height when this image last loaded, or null when it never has. */
  ratio: number | null
  /** The `<img>` a lazy caller renders; it decides when to fetch and measures the shape. */
  ref: (element: HTMLImageElement | null) => void
}

/**
 * A caller renders the `<img>` whether or not `src` is ready: an empty src
 * shows its alt text, which is the attachment's filename.
 */
export function useAssetStatus(path: string | null, { lazy = false }: { lazy?: boolean } = {}): AssetStatus {
  const transport = useDaemonTransport()
  const scrollRoot = useContext(AssetScrollRoot)
  // A transport whose own hop is credentialed (the desktop proxy) needs no
  // fetch at all, so the URL is the answer during render.
  const direct =
    path !== null && transport.fetchAsset === undefined
      ? transport.assetUrl(path)
      : null
  const key = path === null || direct !== null ? null : `${transport.connectionId}\n${path}`
  const subscribe = useCallback((fn: () => void) => (key === null ? unsubscribed : subscribeTo(key, fn)), [key])
  const snapshot = useSyncExternalStore(subscribe, () => (key === null ? "" : snapshotOf(key)))
  const fresh = key === null ? null : (cache.get(key)?.url ?? null)
  const shown = fresh ?? (key === null ? null : (stale.get(key) ?? null))
  const failed = key !== null && fresh === null && failures.has(key)

  const [element, setElement] = useState<HTMLImageElement | null>(null)
  // Without an IntersectionObserver (an old engine, or jsdom) everything is near.
  const [near, setNear] = useState(() => !lazy || typeof IntersectionObserver === "undefined")
  useEffect(() => {
    if (!lazy || key === null || element === null) return
    return watchNearViewport(element, scrollRoot?.current ?? null, setNear)
  }, [lazy, key, element, scrollRoot])
  useEffect(() => {
    if (key === null || element === null) return
    const measure = () => rememberRatio(key, element)
    if (element.complete) measure()
    element.addEventListener("load", measure)
    return () => element.removeEventListener("load", measure)
  }, [key, element])

  const needed = key !== null && (!lazy || near)
  useEffect(() => {
    if (!needed || key === null) return
    retain(key)
    return () => release(key)
  }, [key, needed])

  useEffect(() => {
    if (!needed || key === null || path === null || fresh !== null || failures.has(key)) return
    void loadAsset(transport, key, path).catch(() => {})
  }, [transport, path, key, needed, fresh, snapshot])

  return {
    src: direct ?? shown,
    failed,
    ratio: key === null ? null : (ratios.get(key) ?? null),
    // a direct URL has nothing to watch: no state, so no second render
    ref: key === null ? unobserved : setElement,
  }
}

export function useAssetSrc(path: string | null): string | null {
  return useAssetStatus(path).src
}
