import { useEffect, useState } from "react"

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
}

const cache = new Map<string, CacheEntry>()
const pending = new Map<string, Promise<string>>()

function evictIfNeeded(): void {
  while (cache.size > MAX_CACHED_ASSETS) {
    const oldest = cache.keys().next()
    if (oldest.done) return
    const entry = cache.get(oldest.value)
    cache.delete(oldest.value)
    if (entry) URL.revokeObjectURL(entry.url)
  }
}

/** Test seam: drop every cached blob URL. */
export function clearAssetCache(): void {
  for (const entry of cache.values()) URL.revokeObjectURL(entry.url)
  cache.clear()
  pending.clear()
}

async function loadAsset(
  transport: DaemonTransport,
  key: string,
  path: string
): Promise<string> {
  const inFlight = pending.get(key)
  if (inFlight) return await inFlight
  const request = (async () => {
    const blob = await transport.fetchAsset!(path)
    const url = URL.createObjectURL(blob)
    cache.set(key, { url })
    evictIfNeeded()
    return url
  })().finally(() => pending.delete(key))
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
  const [loaded, setLoaded] = useState<{ key: string; url: string } | null>(null)

  useEffect(() => {
    if (path === null || key === null || direct !== null || cached !== null) return
    let live = true
    void loadAsset(transport, key, path).then(
      (url) => {
        if (live) setLoaded({ key, url })
      },
      () => {
        // A refused or missing attachment renders as its alt text. The
        // manifest, not the bytes, is what tells the user it existed.
      }
    )
    return () => {
      live = false
    }
  }, [transport, path, key, direct, cached])

  return direct ?? cached ?? (loaded?.key === key ? loaded.url : null)
}
