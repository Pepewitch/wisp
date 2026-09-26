import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"

import { useHarnessFeatures, useTaskShells } from "@/hooks/queries"
import { useDaemonRuntime } from "@/lib/runtime"
import { loadShellTabs, saveShellTabs, shellLabels, type ShellTabs } from "@/lib/terminal"
import { ApiError } from "@/lib/transport"
import type { ShellInfo } from "@/lib/types"

/** Matches MAX_SHELLS_PER_TASK in src/terminal.ts — the daemon rejects a higher id. */
export const MAX_SHELLS_PER_TASK = 8

/** A kill the daemon refused because something is running; confirmed, it is retried with force. */
export type PendingKill = { kind: "close" | "restart"; id: number; label: string; reason: string }

/** A daemon too old to name its tabs numbers them by socket id, as before. */
function legacyLabel(id: number): string {
  return `Shell ${id + 1}`
}

function failureOf(error: unknown): string {
  return error instanceof Error ? error.message : "The shell could not be changed."
}

/**
 * The terminal pane's tabs: which exist, which is in front, and the writes
 * that change them.
 *
 * The daemon keeps the list when it can (`features.taskTerminals`), so every
 * window shows the same tabs and a close is what hangs a shell up. Only the
 * front tab is this window's own, remembered per task. A daemon that keeps no
 * list gets the old behaviour: tabs remembered per browser, and a closed tab's
 * shell left running for the next tab to take its id.
 *
 * `reconnect` is how a restarted tab's view is told to attach to its new shell.
 */
export function useShellTabs({
  taskId,
  available,
  reconnect,
}: {
  taskId: string | null
  /** the task has a worktree a shell can run in */
  available: boolean
  reconnect: (id: number) => void
}) {
  const runtime = useDaemonRuntime()
  const queryClient = useQueryClient()
  const features = useHarnessFeatures()
  const daemonTabs = features.data?.taskTerminals === true
  // Nothing attaches until the daemon has said which kind it is: a tab opened
  // the legacy way first would be a shell the daemon's list then has to adopt,
  // and closing it would leave its shell running. Only a daemon with no such
  // route at all is old; any other failure is waited out, not guessed from.
  const featuresMissing = features.error instanceof ApiError && features.error.status === 404
  const featuresKnown = features.data !== undefined || featuresMissing

  const taskIdentity = `${runtime.connectionId}:${taskId ?? ""}`
  // Every write names its task up front and checks this when it lands, so a
  // late answer never changes the next task's tabs.
  const currentIdentity = useRef(taskIdentity)
  useEffect(() => {
    currentIdentity.current = taskIdentity
  }, [taskIdentity])
  const stillOn = (identity: string) => currentIdentity.current === identity

  // A task switch swaps the remembered tabs during RENDER, so no tab ever
  // paints pointed at the previous task's worktree.
  const [tabs, setTabsState] = useState<ShellTabs>(() =>
    taskId ? loadShellTabs(runtime.connectionId, taskId) : { ids: [0], active: 0 },
  )
  const [seenTask, setSeenTask] = useState(taskIdentity)
  if (seenTask !== taskIdentity) {
    setSeenTask(taskIdentity)
    setTabsState(taskId ? loadShellTabs(runtime.connectionId, taskId) : { ids: [0], active: 0 })
  }
  // one writer, so no code path can change the tabs without recording them
  const setTabs = (next: ShellTabs) => {
    setTabsState(next)
    if (taskId) saveShellTabs(runtime.connectionId, taskId, next)
  }

  const [pendingKill, setPendingKill] = useState<PendingKill | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const shellsQuery = useTaskShells(taskId, daemonTabs && available)
  // With no list to show, an empty strip would claim the task has no shells,
  // and a new one would be opened beside the ones still running.
  const listFailed = daemonTabs && available && shellsQuery.isError && shellsQuery.data === undefined
  const infos: ShellInfo[] = daemonTabs ? (shellsQuery.data ?? []) : []
  const shells: number[] = !featuresKnown ? [] : daemonTabs ? infos.map((shell) => shell.id) : tabs.ids
  const activeId = shells.includes(tabs.active) ? tabs.active : (shells[shells.length - 1] ?? tabs.active)
  const labels = daemonTabs ? shellLabels(infos) : null
  const labelOf = (id: number) => labels?.get(id) ?? legacyLabel(id)

  const activate = (id: number, ids: number[] = shells) =>
    setTabs({ ids: ids.includes(id) ? ids : [...ids, id], active: id })

  const shellsKey = runtime.qk.terminals(taskId ?? "")
  const patchShells = (change: (list: ShellInfo[]) => ShellInfo[]) =>
    queryClient.setQueryData<ShellInfo[]>(shellsKey, (current) => change(current ?? []))
  const terminalsPath = `/api/tasks/${taskId}/terminals`

  /**
   * POST a new tab and list it at once, rather than waiting for the event.
   * `ifEmpty` takes the task's first tab if another window already made one.
   */
  const createTab = async (ifEmpty = false): Promise<ShellInfo> => {
    const path = ifEmpty ? `${terminalsPath}?ifEmpty=1` : terminalsPath
    const shell = await runtime.transport.request<ShellInfo>(path, { method: "POST" })
    queryClient.setQueryData<ShellInfo[]>(shellsKey, (current = []) =>
      current.some((item) => item.id === shell.id) ? current : [...current, shell].sort((a, b) => a.number - b.number),
    )
    return shell
  }

  const openTab = async () => {
    setFailure(null)
    if (!featuresKnown || listFailed) return
    if (!daemonTabs) {
      // The smallest FREE id, not max+1: on a daemon that keeps no tab list,
      // reusing a closed tab's id reattaches to the shell still running
      // under it, which is how that shell is ever reached again.
      let id = 0
      while (shells.includes(id)) id++
      if (id < MAX_SHELLS_PER_TASK) activate(id, [...shells, id])
      return
    }
    const identity = taskIdentity
    try {
      const shell = await createTab()
      if (stillOn(identity)) activate(shell.id)
    } catch (error) {
      if (stillOn(identity)) setFailure(failureOf(error))
    }
  }

  // A task nobody has opened a shell in yet gets one. Only when the list is
  // EMPTY: the last tab is never closed from here, and a last shell that
  // exited stays listed until it is restarted.
  const autoOpening = useRef<string | null>(null)
  const listEmpty = daemonTabs && available && shellsQuery.isSuccess && shellsQuery.data.length === 0
  useEffect(() => {
    if (!listEmpty || autoOpening.current === taskIdentity) return
    autoOpening.current = taskIdentity
    const identity = taskIdentity
    createTab(true)
      .catch((error: unknown) => {
        if (stillOn(identity)) setFailure(failureOf(error))
      })
      .finally(() => {
        if (autoOpening.current === identity) autoOpening.current = null
      })
    // createTab and stillOn are derived from taskIdentity and the runtime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listEmpty, taskIdentity])

  /**
   * DELETE or restart one tab. A 409 is the daemon saying a program is running
   * in it; that becomes the confirmation, and confirming sends it with force.
   */
  const kill = async (kind: PendingKill["kind"], id: number, force: boolean): Promise<ShellInfo | null | "stop"> => {
    const identity = taskIdentity
    const query = force ? "?force=1" : ""
    try {
      if (kind === "close") {
        await runtime.transport.request(`${terminalsPath}/${id}${query}`, { method: "DELETE" })
        return stillOn(identity) ? null : "stop"
      }
      const shell = await runtime.transport.request<ShellInfo>(`${terminalsPath}/${id}/restart${query}`, {
        method: "POST",
      })
      return stillOn(identity) ? shell : "stop"
    } catch (error) {
      if (!stillOn(identity)) return "stop"
      if (error instanceof ApiError && error.status === 409) {
        setPendingKill({ kind, id, label: labelOf(id), reason: error.message })
        return "stop"
      }
      // someone else closed it first, which is the outcome asked for
      if (kind === "close" && error instanceof ApiError && error.status === 404) return null
      setFailure(failureOf(error))
      return "stop"
    }
  }

  const closeTab = async (id: number, force = false) => {
    setFailure(null)
    if (shells.length <= 1) return // never leave the pane shell-less
    if (daemonTabs && (await kill("close", id, force)) === "stop") return
    const index = shells.indexOf(id)
    const rest = shells.filter((x) => x !== id)
    patchShells((list) => list.filter((shell) => shell.id !== id))
    // the neighbour to the right takes the front, as a browser's tabs do
    if (id === activeId) activate(rest[Math.min(index, rest.length - 1)]!, rest)
    else if (!daemonTabs) setTabs({ ids: rest, active: activeId })
  }

  const restartTab = async (id: number, force = false) => {
    setFailure(null)
    if (!daemonTabs) return
    const shell = await kill("restart", id, force)
    if (shell === "stop" || shell === null) return
    patchShells((list) => list.map((item) => (item.id === shell.id ? shell : item)))
    reconnect(id)
  }

  const renameTab = async (id: number, name: string) => {
    const info = infos.find((shell) => shell.id === id)
    const next = name.trim() || null
    if (!daemonTabs || !info || next === info.name) return
    const identity = taskIdentity
    // shown at once; the daemon's answer (and its event) confirms it
    patchShells((list) => list.map((item) => (item.id === id ? { ...item, name: next } : item)))
    try {
      const shell = await runtime.transport.request<ShellInfo>(`${terminalsPath}/${id}`, {
        method: "PATCH",
        body: { name: next },
      })
      if (stillOn(identity)) patchShells((list) => list.map((item) => (item.id === id ? shell : item)))
    } catch (error) {
      if (!stillOn(identity)) return
      patchShells((list) => list.map((item) => (item.id === id ? info : item)))
      setFailure(failureOf(error))
    }
  }

  const confirmKill = () => {
    const pending = pendingKill
    setPendingKill(null)
    if (!pending) return
    if (pending.kind === "close") void closeTab(pending.id, true)
    else void restartTab(pending.id, true)
  }

  const loadError = listFailed ? shellsQuery.error : features.isError && !featuresKnown ? features.error : null

  return {
    daemonTabs,
    /** the tab list is known, so a new tab cannot be a duplicate of one not shown */
    canOpen: featuresKnown && !listFailed,
    shells,
    activeId,
    infoOf: (id: number) => infos.find((shell) => shell.id === id),
    labelOf,
    activate,
    openTab,
    closeTab,
    restartTab,
    renameTab,
    pendingKill,
    confirmKill,
    cancelKill: () => setPendingKill(null),
    failure: failure ?? (loadError ? `Could not load this task's shells: ${failureOf(loadError)}` : null),
  }
}
