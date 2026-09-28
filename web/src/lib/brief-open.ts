import { useCallback, useSyncExternalStore } from "react"

/**
 * Whether the task brief band shows its body or only its one line.
 *
 * Pure presentation, so it is client-local and global like the theme — not
 * connection-scoped, and never sent to the daemon: collapsing a brief must not
 * be able to change whether one is generated (frontend reference §5k). One
 * remembered answer for every task, because "do I want this open" is about the
 * reader, not about any one task.
 *
 * Until someone chooses, a pointer shell opens it and a touch shell does not:
 * on a phone the open band takes the whole chat, and the one-line form already
 * says the most important thing.
 */
const STORAGE_KEY = "wisp_brief_open"

type Stored = "open" | "closed" | null

function read(): Stored {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === "open" || value === "closed" ? value : null
  } catch {
    return null
  }
}

let stored = read()
const listeners = new Set<() => void>()
let watching = false

function announce(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!watching && typeof window !== "undefined") {
    watching = true
    // another tab chose; this one follows without a reload
    window.addEventListener("storage", (event) => {
      if (event.key !== null && event.key !== STORAGE_KEY) return
      stored = read()
      announce()
    })
  }
  return () => {
    listeners.delete(listener)
  }
}

export function setBriefOpen(open: boolean): void {
  stored = open ? "open" : "closed"
  try {
    localStorage.setItem(STORAGE_KEY, stored)
  } catch {
    // private mode: the choice holds for this window only
  }
  announce()
}

/** `touch` decides only the default, before anyone has chosen. */
export function useBriefOpen(touch: boolean): [boolean, (open: boolean) => void] {
  const value = useSyncExternalStore(subscribe, () => stored, () => null)
  const set = useCallback((open: boolean) => setBriefOpen(open), [])
  return [value === null ? !touch : value === "open", set]
}

/** Tests only: forget the choice. */
export function resetBriefOpenForTests(): void {
  stored = null
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // nothing stored
  }
  announce()
}
