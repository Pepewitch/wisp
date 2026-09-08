import { Popover } from "@base-ui/react/popover"

import { Minus, Plus, ZoomIn } from "@/components/icons"
import { Button, POPOVER_SURFACE } from "@/components/primitives"
import { useDesktopZoom } from "@/lib/desktop-zoom"
import { cn } from "@/lib/utils"

export function DesktopZoomControl({ mobile = false }: { mobile?: boolean }) {
  const zoom = useDesktopZoom()

  return (
    <Popover.Root>
      <Popover.Trigger
        render={<Button size={mobile ? "lg" : "sm"} icon />}
        aria-label={`Zoom, ${zoom.level}%`}
        title={`Zoom: ${zoom.level}% (⌘+ / ⌘−)`}
      >
        <ZoomIn />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className="z-(--z-menu)"
        >
          <Popover.Popup
            aria-label="Desktop zoom"
            className={cn(
              POPOVER_SURFACE,
              "flex items-center gap-1 rounded-lg p-1.5 outline-none"
            )}
          >
            <Button
              size="sm"
              icon
              disabled={!zoom.canZoomOut}
              aria-label="Zoom out"
              title="Zoom out (⌘−)"
              onClick={zoom.zoomOut}
            >
              <Minus />
            </Button>
            <output
              aria-label="Zoom level"
              aria-live="polite"
              className="w-11 text-center font-mono text-[11px] text-fg-secondary"
            >
              {zoom.level}%
            </output>
            <Button
              size="sm"
              icon
              disabled={!zoom.canZoomIn}
              aria-label="Zoom in"
              title="Zoom in (⌘+)"
              onClick={zoom.zoomIn}
            >
              <Plus />
            </Button>
            <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
            <Button size="sm" onClick={zoom.reset}>
              Reset
            </Button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
