/* eslint-disable react-refresh/only-export-components -- context and provider are one native boundary */
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

import {
  desktopBridge,
  type DesktopBridge,
  type DesktopUpdateStatus,
} from "@/lib/desktop-bridge"

// The key predates periodic checks; it now covers every automatic check.
const AUTO_CHECK_SETTING = "wisp.desktop.check-updates-after-launch"
const MIN_LAUNCH_CHECK_DELAY_MS = 2_000
const LAUNCH_CHECK_JITTER_MS = 4_000
const PERIODIC_CHECK_INTERVAL_MS = 6 * 60 * 60_000
const PERIODIC_CHECK_JITTER_MS = 30 * 60_000

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
  /** Automatic discovery: once after launch, then every few hours while open. */
  readonly checkAfterLaunch: boolean
  /** A check the person asked for; native code reads the channel fresh. */
  check(): Promise<void>
  install(confirmedVersion: string): Promise<void>
  relaunch(): Promise<void>
  setCheckAfterLaunch(enabled: boolean): void
}

export function desktopUpdateBlocksDaemon(
  status: DesktopUpdateStatus | null,
  pending: boolean
): boolean {
  return (
    pending ||
    status?.phase === "checking" ||
    status?.phase === "downloading" ||
    status?.phase === "installing" ||
    status?.phase === "ready-to-relaunch"
  )
}

/**
 * Whether a periodic check may run now. It only discovers: it never replaces
 * an update already found, an install in progress or awaiting relaunch, or a
 * failed install the person can retry, and it never overlaps another call.
 */
export function periodicDesktopCheckMayRun(
  status: DesktopUpdateStatus | null,
  pending: boolean
): boolean {
  if (pending || !status?.configured) return false
  if (status.phase === "idle" || status.phase === "up-to-date") return true
  return status.phase === "failed" && status.latestVersion === null
}

const DesktopUpdaterContext = createContext<DesktopUpdaterContextValue | null>(
  null
)

export function useDesktopUpdater(): DesktopUpdaterContextValue | null {
  return useContext(DesktopUpdaterContext)
}

export function DesktopUpdaterProvider({
  children,
  bridge = desktopBridge,
  launchCheckDelay,
  periodicCheckInterval,
}: {
  children: ReactNode
  bridge?: DesktopBridge
  /** Test seam; production intentionally jitters the one launch check. */
  launchCheckDelay?: number
  /** Test seam; production checks every six hours plus up to 30 minutes. */
  periodicCheckInterval?: number
}) {
  const [status, setStatusState] = useState<DesktopUpdateStatus | null>(null)
  const [resolvedLaunchCheckDelay] = useState(
    () =>
      launchCheckDelay ??
      MIN_LAUNCH_CHECK_DELAY_MS + Math.random() * LAUNCH_CHECK_JITTER_MS
  )
  const [pending, setPendingState] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checkAfterLaunch, setCheckAfterLaunchState] = useState(readAutoCheck)
  // Timers read the latest state without re-arming on every status event.
  const statusRef = useRef<DesktopUpdateStatus | null>(null)
  const pendingRef = useRef(false)

  const setStatus = useCallback((next: DesktopUpdateStatus) => {
    statusRef.current = next
    setStatusState(next)
  }, [])
  const setPending = useCallback((next: boolean) => {
    pendingRef.current = next
    setPendingState(next)
  }, [])

  const runCheck = useCallback(
    async (explicit: boolean) => {
      setPending(true)
      setError(null)
      try {
        setStatus(await bridge.checkDesktopUpdate(explicit))
      } catch (cause) {
        setError(message(cause))
        throw cause
      } finally {
        setPending(false)
      }
    },
    [bridge, setPending, setStatus]
  )

  const check = useCallback(() => runCheck(true), [runCheck])

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
  }, [bridge, setPending])

  const install = useCallback(
    async (confirmedVersion: string) => {
      setPending(true)
      setError(null)
      try {
        setStatus(await bridge.installDesktopUpdate(confirmedVersion))
      } catch (cause) {
        setError(message(cause))
        throw cause
      } finally {
        setPending(false)
      }
    },
    [bridge, setPending, setStatus]
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
    // Automatic discovery is intentionally quiet outside the update surface.
    // The provider retains a failure for that surface.
    const automaticCheckAfter = (delay: number) => {
      timer = setTimeout(() => {
        timer = null
        const next = () => {
          if (alive)
            automaticCheckAfter(
              periodicCheckInterval ??
                PERIODIC_CHECK_INTERVAL_MS +
                  Math.random() * PERIODIC_CHECK_JITTER_MS
            )
        }
        if (!periodicDesktopCheckMayRun(statusRef.current, pendingRef.current)) {
          next()
          return
        }
        void runCheck(false)
          .catch(() => undefined)
          .finally(next)
      }, delay)
    }
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
        if (checkAfterLaunch && initial.configured)
          automaticCheckAfter(resolvedLaunchCheckDelay)
      })
      .catch((cause) => {
        if (alive) setError(message(cause))
      })
    return () => {
      alive = false
      if (timer !== null) clearTimeout(timer)
      unlisten?.()
    }
  }, [
    bridge,
    runCheck,
    setStatus,
    checkAfterLaunch,
    resolvedLaunchCheckDelay,
    periodicCheckInterval,
  ])

  const value = useMemo<DesktopUpdaterContextValue>(
    () => ({
      status,
      pending,
      error,
      checkAfterLaunch,
      check,
      install,
      relaunch,
      setCheckAfterLaunch,
    }),
    [
      status,
      pending,
      error,
      checkAfterLaunch,
      check,
      install,
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
