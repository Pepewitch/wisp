/* eslint-disable react-refresh/only-export-components -- context and provider are one native boundary */
import { getCurrentWebview } from "@tauri-apps/api/webview"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

export const DEFAULT_DESKTOP_ZOOM = 100
export const MIN_DESKTOP_ZOOM = 50
export const MAX_DESKTOP_ZOOM = 200
export const DESKTOP_ZOOM_STEP = 10

const DESKTOP_ZOOM_SETTING = "wisp.desktop.zoom-percent"

type ZoomAction = "in" | "out" | "reset"

export interface DesktopZoomContextValue {
  readonly level: number
  readonly canZoomIn: boolean
  readonly canZoomOut: boolean
  zoomIn(): void
  zoomOut(): void
  reset(): void
}

const DesktopZoomContext = createContext<DesktopZoomContextValue | null>(null)

function normalizeZoom(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DESKTOP_ZOOM
  const stepped = Math.round(value / DESKTOP_ZOOM_STEP) * DESKTOP_ZOOM_STEP
  return Math.min(MAX_DESKTOP_ZOOM, Math.max(MIN_DESKTOP_ZOOM, stepped))
}

function currentStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function readZoom(storage: Storage | null): number {
  if (storage === null) return DEFAULT_DESKTOP_ZOOM
  try {
    const stored = storage.getItem(DESKTOP_ZOOM_SETTING)
    return stored === null
      ? DEFAULT_DESKTOP_ZOOM
      : normalizeZoom(Number(stored))
  } catch {
    return DEFAULT_DESKTOP_ZOOM
  }
}

function writeZoom(storage: Storage | null, level: number): void {
  if (storage === null) return
  try {
    storage.setItem(DESKTOP_ZOOM_SETTING, String(level))
  } catch {
    // Zoom still works for this launch when storage is unavailable.
  }
}

function shortcutAction(event: KeyboardEvent): ZoomAction | null {
  if (!event.metaKey || event.altKey) return null
  if (event.key === "+" || event.key === "=") return "in"
  if (event.key === "-") return "out"
  if (event.key === "0") return "reset"
  return null
}

function setCurrentWebviewZoom(scaleFactor: number): Promise<void> {
  return getCurrentWebview().setZoom(scaleFactor)
}

export function DesktopZoomProvider({
  children,
  storage,
  applyZoom = setCurrentWebviewZoom,
}: {
  children: ReactNode
  storage?: Storage | null
  /** Test seam over Tauri's current-webview API. */
  applyZoom?: (scaleFactor: number) => Promise<void>
}) {
  const [resolvedStorage] = useState(() =>
    storage === undefined ? currentStorage() : storage
  )
  const [level, setLevel] = useState(() => readZoom(resolvedStorage))
  const lastApplied = useRef<{
    applyZoom: (scaleFactor: number) => Promise<void>
    level: number
    storage: Storage | null
  } | null>(null)

  const zoomIn = useCallback(() => {
    setLevel((current) => normalizeZoom(current + DESKTOP_ZOOM_STEP))
  }, [])
  const zoomOut = useCallback(() => {
    setLevel((current) => normalizeZoom(current - DESKTOP_ZOOM_STEP))
  }, [])
  const reset = useCallback(() => setLevel(DEFAULT_DESKTOP_ZOOM), [])

  useEffect(() => {
    const previous = lastApplied.current
    if (
      previous?.applyZoom === applyZoom &&
      previous.level === level &&
      previous.storage === resolvedStorage
    )
      return
    lastApplied.current = { applyZoom, level, storage: resolvedStorage }
    writeZoom(resolvedStorage, level)
    void applyZoom(level / 100).catch((error: unknown) => {
      console.error("Could not apply desktop zoom", error)
    })
  }, [applyZoom, level, resolvedStorage])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = shortcutAction(event)
      if (action === null) return
      event.preventDefault()
      if (action === "in") zoomIn()
      else if (action === "out") zoomOut()
      else reset()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [reset, zoomIn, zoomOut])

  const value = useMemo<DesktopZoomContextValue>(
    () => ({
      level,
      canZoomIn: level < MAX_DESKTOP_ZOOM,
      canZoomOut: level > MIN_DESKTOP_ZOOM,
      zoomIn,
      zoomOut,
      reset,
    }),
    [level, reset, zoomIn, zoomOut]
  )

  return (
    <DesktopZoomContext.Provider value={value}>
      {children}
    </DesktopZoomContext.Provider>
  )
}

export function useDesktopZoom(): DesktopZoomContextValue {
  const zoom = useContext(DesktopZoomContext)
  if (!zoom)
    throw new Error("useDesktopZoom must be used inside DesktopZoomProvider")
  return zoom
}
