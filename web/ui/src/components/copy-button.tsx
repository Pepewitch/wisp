import { useEffect, useRef, useState } from "react"

import { Check, Copy } from "@/components/icons"
import { cn } from "@/lib/utils"

export function CopyButton({
  text,
  label = "Copy",
  copiedLabel = "Copied",
  className,
}: {
  text: string
  label?: string
  copiedLabel?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const mounted = useRef(true)
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (reset.current) clearTimeout(reset.current)
    }
  }, [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      if (!mounted.current) return
      setCopied(true)
      if (reset.current) clearTimeout(reset.current)
      reset.current = setTimeout(() => setCopied(false), 1_200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button
      type="button"
      aria-label={copied ? copiedLabel : label}
      title={copied ? "Copied" : "Copy message"}
      onClick={() => void copy()}
      className={cn(
        // Icons carry no size classes of their own: the container sizes them,
        // so a caller that wants a bigger glyph passes ONE class rather than
        // reaching inside this button. `BUBBLE_ACTION` is the one that does.
        "inline-flex items-center justify-center rounded-sm p-0.5 text-faint transition-colors",
        "hover:text-foreground [&>svg]:size-3",
        className,
      )}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
    </button>
  )
}
