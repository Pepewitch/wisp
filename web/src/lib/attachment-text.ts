import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"

import { useAssetSrc } from "./asset-src"
import { parseDelimited, type DelimitedTable, type Delimiter } from "./delimited"
import { useDaemonRuntime } from "./runtime"

/**
 * The most of one text attachment a preview reads: the same 512 KB budget the
 * daemon gives a worktree file in the viewer. A text attachment may be 20 MB,
 * and a preview has no business holding all of it.
 */
export const ATTACHMENT_PREVIEW_BYTES = 512 * 1024

export interface AttachmentText {
  text: string
  /** the file is longer than what was read */
  truncated: boolean
}

/**
 * Read at most `limit` bytes of `url` as utf-8, then stop the transfer.
 *
 * `stream: true` on the final decode holds back a character split by the cap
 * instead of printing a replacement glyph at the edge.
 */
export async function readTextPrefix(
  url: string,
  limit: number,
  signal?: AbortSignal,
): Promise<AttachmentText> {
  const response = await fetch(url, { credentials: "omit", redirect: "error", signal })
  if (!response.ok) throw new Error(`attachment error: ${response.status}`)
  const decoder = new TextDecoder("utf-8")
  const reader = response.body?.getReader()
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    const truncated = bytes.length > limit
    return { text: decoder.decode(bytes.subarray(0, limit), { stream: truncated }), truncated }
  }
  let text = ""
  let read = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return { text: text + decoder.decode(), truncated: false }
    const room = limit - read
    if (value.length > room) {
      text += decoder.decode(value.subarray(0, room), { stream: true })
      await reader.cancel()
      return { text, truncated: true }
    }
    read += value.length
    text += decoder.decode(value, { stream: true })
  }
}

/**
 * A sent text attachment's contents, for a preview.
 *
 * The bytes come through `useAssetSrc`, so this costs no second credentialed
 * request: in the browser the source is the blob URL the download link already
 * holds, and in Desktop it is the proxy URL whose hop carries the credential.
 * The text is only ever rendered as text nodes, never as markup, which is why
 * this does not contradict the daemon serving the file as a download.
 */
export function useAttachmentText(path: string | null) {
  const { qk } = useDaemonRuntime()
  const src = useAssetSrc(path)
  return useQuery({
    queryKey: qk.attachmentText(path ?? ""),
    enabled: path !== null && src !== null,
    // a stored attachment never changes under its path
    staleTime: Infinity,
    queryFn: ({ signal }) => readTextPrefix(src!, ATTACHMENT_PREVIEW_BYTES, signal),
  })
}

/** Parse what a preview read, dropping the last record when the read stopped mid-file. */
export function useDelimitedTable(
  data: AttachmentText | undefined,
  delimiter: Delimiter | null,
): DelimitedTable | null {
  return useMemo(
    () => (data && delimiter ? parseDelimited(data.text, delimiter, { complete: !data.truncated }) : null),
    [data, delimiter],
  )
}
