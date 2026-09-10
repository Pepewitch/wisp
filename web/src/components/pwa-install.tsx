import { useState } from "react"

import { WispMark } from "@/components/icons"
import { Button, Eyebrow } from "@/components/primitives"
import { installPwa, usePwaInstall, type InstallState } from "@/lib/pwa"

const HINT: Record<Exclude<InstallState, "unavailable">, string> = {
  https: "Open Wisp at your Tailscale HTTPS address to install it on this device. Keep Tailscale connected when using Wisp.",
  ios: "In Safari, open Share, choose Add to Home Screen, then Add. If offered, keep Open as Web App on. Keep Tailscale connected when using Wisp.",
  manual: "Open your browser’s menu and choose Install app or Add to Home Screen. If neither appears, open this address in Safari on iPhone or Chrome on Android.",
  ready: "Keep your tasks one tap away, in their own window. Keep Tailscale connected when using Wisp.",
  installed: "Wisp is running as an app. Keep Tailscale connected to reach your remote daemon.",
}

export function PwaInstall() {
  const state = usePwaInstall()
  if (state === "unavailable") return null
  return <PwaInstallSection state={state} />
}

/** Also rendered in the gallery so installation copy and touch layout stay reviewable. */
export function PwaInstallSection({ state }: { state: Exclude<InstallState, "unavailable"> }) {
  const [error, setError] = useState(false)
  return (
    <section className="mt-4 border-t border-border pt-3.5">
      <div className="flex items-center gap-2">
        <WispMark className="size-5" />
        <Eyebrow>{state === "installed" ? "Home screen app" : "Wisp on your home screen"}</Eyebrow>
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">{HINT[state]}</p>
      {state === "ready" && (
        <Button size="touch" className="mt-3" onClick={() => {
          setError(false)
          void installPwa().catch(() => setError(true))
        }}>Install Wisp</Button>
      )}
      {error && <p role="status" className="mt-2 text-[12.5px] text-muted-foreground">Installation could not open. Try your browser’s install menu.</p>}
    </section>
  )
}
