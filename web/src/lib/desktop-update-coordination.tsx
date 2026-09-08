/* eslint-disable react-refresh/only-export-components -- context and provider are one application-global boundary */
import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react"

import type { DaemonUpdateOperation } from "@/lib/update"

export interface DesktopUpdateCoordination {
  readonly daemonError: string | null
  readonly daemonOperation: DaemonUpdateOperation | null
  readonly checkingDaemon: boolean
  readonly daemonOperationRef: RefObject<DaemonUpdateOperation | null>
  readonly desktopOperationRef: RefObject<boolean>
  readonly checkOperationRef: RefObject<boolean>
  readonly setDaemonError: Dispatch<SetStateAction<string | null>>
  readonly setDaemonOperation: Dispatch<
    SetStateAction<DaemonUpdateOperation | null>
  >
  readonly setCheckingDaemon: Dispatch<SetStateAction<boolean>>
}

const DesktopUpdateCoordinationContext =
  createContext<DesktopUpdateCoordination | null>(null)

/**
 * Update controls are application chrome, so their locks and progress must
 * outlive the active daemon tree that Desktop deliberately remounts per tab.
 */
export function DesktopUpdateCoordinationProvider({
  children,
}: {
  children: ReactNode
}) {
  const [daemonError, setDaemonError] = useState<string | null>(null)
  const [daemonOperation, setDaemonOperation] =
    useState<DaemonUpdateOperation | null>(null)
  const [checkingDaemon, setCheckingDaemon] = useState(false)
  const daemonOperationRef = useRef<DaemonUpdateOperation | null>(null)
  const desktopOperationRef = useRef(false)
  const checkOperationRef = useRef(false)
  const value = useMemo<DesktopUpdateCoordination>(
    () => ({
      daemonError,
      daemonOperation,
      checkingDaemon,
      daemonOperationRef,
      desktopOperationRef,
      checkOperationRef,
      setDaemonError,
      setDaemonOperation,
      setCheckingDaemon,
    }),
    [daemonError, daemonOperation, checkingDaemon]
  )
  return (
    <DesktopUpdateCoordinationContext.Provider value={value}>
      {children}
    </DesktopUpdateCoordinationContext.Provider>
  )
}

export function useDesktopUpdateCoordination(): DesktopUpdateCoordination | null {
  return useContext(DesktopUpdateCoordinationContext)
}
