import { useSyncExternalStore } from "react"

interface InstallPrompt extends Event {
  prompt(): Promise<{ outcome: "accepted" | "dismissed" }>
}

export type InstallState = "unavailable" | "https" | "ios" | "manual" | "ready" | "installed"

let state: InstallState = "unavailable"
let prompt: InstallPrompt | null = null
const listeners = new Set<() => void>()

function publish(next: InstallState) {
  state = next
  for (const listener of listeners) listener()
}

function installed(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
}

/** Only called by the browser entry point; the packaged Desktop app has no PWA. */
export function initPwa(): () => void {
  const links: HTMLLinkElement[] = []
  for (const [rel, href] of [["manifest", "/manifest.webmanifest"], ["apple-touch-icon", "/apple-touch-icon.png"]] as const) {
    const link = document.createElement("link")
    link.rel = rel
    link.href = href
    document.head.append(link)
    links.push(link)
  }
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  const fallback = (): InstallState => installed() ? "installed" :
    !window.isSecureContext ? "https" : ios ? "ios" : "manual"
  publish(fallback())
  const beforeInstall = (event: Event) => {
    event.preventDefault()
    prompt = event as InstallPrompt
    publish("ready")
  }
  const didInstall = () => { prompt = null; publish("installed") }
  const mode = window.matchMedia("(display-mode: standalone)")
  const modeChanged = () => publish(fallback())
  window.addEventListener("beforeinstallprompt", beforeInstall)
  window.addEventListener("appinstalled", didInstall)
  mode.addEventListener("change", modeChanged)

  // The worker has no application cache and never reloads a running client.
  // Check on foregrounding so long-lived home-screen windows get fixes too.
  let registration: ServiceWorkerRegistration | undefined
  if (window.isSecureContext && "serviceWorker" in navigator && import.meta.env.PROD) {
    void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((value) => { registration = value })
      .catch(() => { /* Browsing still works if installation is blocked. */ })
  }
  const foreground = () => {
    if (document.visibilityState === "visible") void registration?.update().catch(() => undefined)
  }
  document.addEventListener("visibilitychange", foreground)
  return () => {
    for (const link of links) link.remove()
    window.removeEventListener("beforeinstallprompt", beforeInstall)
    window.removeEventListener("appinstalled", didInstall)
    mode.removeEventListener("change", modeChanged)
    document.removeEventListener("visibilitychange", foreground)
    prompt = null
    publish("unavailable")
  }
}

export async function installPwa(): Promise<void> {
  const pending = prompt
  if (!pending) return
  prompt = null
  publish("manual")
  // A prompt is single-use. Dismissal leaves the browser-menu instructions.
  await pending.prompt()
}

export function usePwaInstall(): InstallState {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    () => state,
    () => "unavailable",
  )
}
