import { useEffect, useState, type ReactNode } from "react"

import { WispMark } from "@/components/icons"
import { Button } from "@/components/primitives"
import type { DesktopBootstrap } from "@/lib/desktop-bridge"

export function DesktopBootstrapScreen({
  promise,
  children,
}: {
  promise: Promise<DesktopBootstrap>
  children: (bootstrap: DesktopBootstrap) => ReactNode
}) {
  const [result, setResult] = useState<{
    bootstrap?: DesktopBootstrap
    error?: string
  }>({})
  useEffect(() => {
    let live = true
    void promise.then(
      (bootstrap) => live && setResult({ bootstrap }),
      (error: unknown) =>
        live &&
        setResult({
          error: error instanceof Error ? error.message : String(error),
        })
    )
    return () => {
      live = false
    }
  }, [promise])

  if (result.bootstrap) return children(result.bootstrap)
  return (
    <div className="flex h-dvh items-center justify-center bg-background text-foreground">
      <div className="flex max-w-sm flex-col items-center px-6 text-center">
        <span role="img" aria-label="Wisp">
          <WispMark className="size-7" />
        </span>
        {result.error ? (
          <>
            <h1 className="mt-4 text-[14.5px] font-semibold">
              Could not start Wisp Desktop
            </h1>
            <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
              {result.error}
            </p>
            <Button
              size="lg"
              className="mt-4"
              onClick={() => window.location.reload()}
            >
              Retry
            </Button>
          </>
        ) : (
          <p className="mt-3 text-[12px] text-muted-foreground">
            Starting desktop connections…
          </p>
        )}
      </div>
    </div>
  )
}
