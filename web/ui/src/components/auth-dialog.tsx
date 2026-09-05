import { useState, useSyncExternalStore } from "react"

import { Button, POPOVER_SURFACE } from "@/components/primitives"
import { useMintSession } from "@/hooks/mutations"
import { authStore } from "@/lib/api"
import { cn } from "@/lib/utils"

/**
 * The 401 gate. `api()` parks every in-flight request on requireAuth(); this
 * dialog resolves it by trading the token for the HttpOnly cookie, and the
 * parked requests then retry themselves.
 */
export function AuthDialog() {
  const auth = useSyncExternalStore(authStore.subscribe, authStore.snapshot)
  const [value, setValue] = useState("")
  const mint = useMintSession()
  if (!auth.open) return null

  const submit = () => {
    const token = value.trim()
    if (!token || mint.isPending) return
    mint.mutate(token)
  }
  const error = mint.error instanceof Error ? mint.error.message : null

  return (
    <div className="fixed inset-0 z-(--z-modal) flex items-center justify-center bg-black/65 p-6">
      <div
        role="dialog"
        aria-label="Daemon token"
        className={cn(POPOVER_SURFACE, "w-[400px] rounded-xl p-5 shadow-modal")}
      >
        <h2 className="text-[14.5px] font-semibold tracking-[-0.01em]">This daemon needs a token</h2>
        <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
          Run <code className="rounded bg-accent-wash px-1.5 py-px text-[11.5px] text-accent-soft">wisp token</code> on
          the daemon host and paste it here. It becomes an HttpOnly cookie, so this is once per browser.
        </p>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Paste the token"
          className="mt-4 h-8 w-full rounded-md border border-input bg-surface px-2.5 font-mono text-[12px] text-foreground placeholder:text-faint focus:border-accent-dim focus:ring-2 focus:ring-ring/15 focus:outline-none"
        />
        {error && <p className="mt-2 text-[11.5px] text-destructive">{error}</p>}
        <div className="mt-4 flex justify-end">
          <Button size="lg" tone="primary" onClick={submit} disabled={mint.isPending || value.trim().length === 0}>
            {mint.isPending ? "Connecting…" : "Connect"}
          </Button>
        </div>
      </div>
    </div>
  )
}
