/* eslint-disable react-refresh/only-export-components -- context and provider are one native boundary */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

import {
  desktopBridge,
  type DesktopBridge,
  type DesktopUpdateStatus,
} from "@/lib/desktop-bridge"

const AUTO_CHECK_SETTING = "wisp.desktop.check-updates-after-launch"
const MIN_LAUNCH_CHECK_DELAY_MS = 2_000
const LAUNCH_CHECK_JITTER_MS = 4_000

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readAutoCheck(): boolean {
  try {
    return window.localStorage.getItem(AUTO_CHECK_SETTING) !== "0"
  } catch {
    return true
  }
}

export interface DesktopUpdaterContextValue {
  readonly status: DesktopUpdateStatus | null
  readonly pending: boolean
  readonly error: string | null
  readonly checkAfterLaunch: boolean
  check(): Promise<void>
  installAndRelaunch(confirmedVersion: string): Promise<void>
  relaunch(): Promise<void>
  setCheckAfterLaunch(enabled: boolean): void
}

const DesktopUpdaterContext =
  createContext<DesktopUpdaterContextValue | null>(null)

export function useDesktopUpdater(): DesktopUpdaterContextValue | null {
  return useContext(DesktopUpdaterContext)
}

export function DesktopUpdaterProvider({
  children,
  bridge = desktopBridge,
  launchCheckDelay,
}: {
  children: ReactNode
  bridge?: DesktopBridge
  /** Test seam; production intentionally jitters the one launch check. */
  launchCheckDelay?: number
}) {
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null)
  const [resolvedLaunchCheckDelay] = useState(
    () =>
      launchCheckDelay ??
      MIN_LAUNCH_CHECK_DELAY_MS + Math.random() * LAUNCH_CHECK_JITTER_MS
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checkAfterLaunch, setCheckAfterLaunchState] = useState(readAutoCheck)

  const check = useCallback(async () => {
    setPending(true)
    setError(null)
    try {
      setStatus(await bridge.checkDesktopUpdate())
    } catch (cause) {
      setError(message(cause))
      throw cause
    } finally {
      setPending(false)
    }
  }, [bridge])

  const relaunch = useCallback(async () => {
    setPending(true)
    setError(null)
    try {
      await bridge.relaunchDesktop()
    } catch (cause) {
      setError(message(cause))
      throw cause
    } finally {
      setPending(false)
    }
  }, [bridge])

  const installAndRelaunch = useCallback(
    async (confirmedVersion: string) => {
      setPending(true)
      setError(null)
      try {
        setStatus(await bridge.installDesktopUpdate(confirmedVersion))
        await bridge.relaunchDesktop()
      } catch (cause) {
        setError(message(cause))
        throw cause
      } finally {
        setPending(false)
      }
    },
    [bridge]
  )

  const setCheckAfterLaunch = useCallback((enabled: boolean) => {
    setCheckAfterLaunchState(enabled)
    try {
      window.localStorage.setItem(AUTO_CHECK_SETTING, enabled ? "1" : "0")
    } catch {
      // The setting is a convenience. A blocked storage write must not break
      // manual checks or change update trust.
    }
  }, [])

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let unlisten: (() => void) | null = null
    void bridge
      .onDesktopUpdateStatus((next) => {
        if (alive) setStatus(next)
      })
      .then((stop) => {
        if (alive) unlisten = stop
        else stop()
      })
      .catch((cause) => {
        if (alive) setError(message(cause))
      })
    void bridge
      .desktopUpdateStatus()
      .then((initial) => {
        if (!alive) return
        setStatus(initial)
        if (checkAfterLaunch && initial.configured) {
          timer = setTimeout(() => {
            void check().catch(() => {
              // Launch discovery is intentionally quiet outside the update
              // surface. The provider retains the failure for that surface.
            })
          }, resolvedLaunchCheckDelay)
        }
      })
      .catch((cause) => {
        if (alive) setError(message(cause))
      })
    return () => {
      alive = false
      if (timer !== null) clearTimeout(timer)
      unlisten?.()
    }
  }, [bridge, check, checkAfterLaunch, resolvedLaunchCheckDelay])

  const value = useMemo<DesktopUpdaterContextValue>(
    () => ({
      status,
      pending,
      error,
      checkAfterLaunch,
      check,
      installAndRelaunch,
      relaunch,
      setCheckAfterLaunch,
    }),
    [
      status,
      pending,
      error,
      checkAfterLaunch,
      check,
      installAndRelaunch,
      relaunch,
      setCheckAfterLaunch,
    ]
  )

  return (
    <DesktopUpdaterContext.Provider value={value}>
      {children}
    </DesktopUpdaterContext.Provider>
  )
}
