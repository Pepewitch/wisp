import { useState } from "react"
import { safeHttpUrl } from "@/lib/paste-links"
import { externalLinkProps } from "@/lib/external-links"
import { Button } from "./primitives"

/** Consent belongs to this exact URL, never to a Markdown position reused by streaming. */
export function RemoteImage({ src, alt }: { src?: string; alt?: string }) {
  const url = src ? safeHttpUrl(src) : null
  return url ? <ImageConsent key={url} url={url} alt={alt ?? "Remote image"} /> : <>{alt}</>
}

function ImageConsent({ url, alt }: { url: string; alt: string }) {
  const [load, setLoad] = useState(false)
  const [failed, setFailed] = useState(false)
  return <span className="mt-2.5 block rounded-md border border-border p-2.5 text-[12px]">
    {!load || failed ? <>
      <span className="block text-fg-secondary">{alt}</span>
      <span className="block break-all text-faint">{url}</span>
      <span className="mt-1 block text-muted-foreground">{failed ? "This image could not load. Check the address or open it in your browser." : "Loading contacts this address and may disclose information in its URL."}</span>
      <Button onClick={() => { setFailed(false); setLoad(true) }}>{failed ? "Retry image" : "Load image"}</Button>
      {failed && <a {...externalLinkProps(url)} className="ml-3 underline">Open image</a>}
    </> : <img src={url} alt={alt} referrerPolicy="no-referrer" onError={() => setFailed(true)} className="max-w-full rounded-md" />}
  </span>
}
