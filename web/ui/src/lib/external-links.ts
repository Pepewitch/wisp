import type { MouseEvent } from "react"
import { isTauri } from "@tauri-apps/api/core"

import { desktopBridge } from "./desktop-bridge"
import { safeHttpUrl } from "./paste-links"

/**
 * Making a link leave the app, in both runtimes.
 *
 * `target="_blank"` is enough in a browser and inert in the packaged app: a
 * WKWebView with no new-window handler simply drops the click, so every PR
 * link and every URL in agent prose did nothing there. Desktop hands the URL
 * to a narrow native command instead; the browser keeps the anchor's own
 * behavior, including a middle- or modified-click.
 *
 * The anchor stays a real anchor in both. It is the thing that shows where a
 * link points, carries the URL to a context menu, and answers the keyboard —
 * this only replaces what happens on activation, and only where it is inert.
 *
 * `safeHttpUrl` is the whole policy, and it is deliberately narrow because
 * these hrefs come from agent output: absolute http(s) only. A relative href
 * would resolve against the app's own origin and navigate the shell away from
 * itself with no way back, and a `file:` or custom scheme is somebody else's
 * program. Anything else is not rendered as a link at all.
 */

export interface ExternalLinkProps {
  href: string
  target: "_blank"
  rel: string
  onClick: (event: MouseEvent<HTMLAnchorElement>) => void
}

/**
 * Anchor props for one external href, or `null` when it may not be a link.
 *
 * A lib helper rather than a component so the two call sites keep their own
 * markup and styling, and so the runtime branch stays out of the components.
 */
export function externalLinkProps(
  href: string | null | undefined
): ExternalLinkProps | null {
  const url = safeHttpUrl(href)
  if (!url) return null
  return {
    href: url,
    target: "_blank",
    rel: "noopener noreferrer",
    onClick: (event) => {
      if (!isTauri()) return
      event.preventDefault()
      void desktopBridge.openExternalUrl(url).catch((error: unknown) => {
        // Nothing user-facing to say: the anchor still shows where it points,
        // and no daemon state depends on the click.
        console.error("could not open a link outside the app", error)
      })
    },
  }
}
