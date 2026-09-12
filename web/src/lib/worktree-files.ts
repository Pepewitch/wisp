import { createContext, useContext } from "react"

import type { DiffFile } from "./diff"

import { safeHttpUrl } from "./paste-links"

/**
 * Turning a path an agent wrote into something you can read.
 *
 * Agents link two kinds of thing in prose: web addresses, which belong to the
 * browser, and repository paths, which belong to the task's worktree. This
 * module owns the second half — deciding what counts as a path, and letting
 * `Prose` ask for it to be opened without knowing who shows it.
 *
 * Nothing here reads a file. The daemon that owns the worktree does, and its
 * containment check is the real boundary: this only decides which hrefs are
 * worth asking about, so a fragment link inside a rendered document does not
 * turn into a file request.
 */

/**
 * The worktree path an href names, or null when it is not one.
 *
 * A web address is not a file, a `#section` is a place in the current
 * document, and any other scheme belongs to a program we are not. What
 * survives is a plain path — which may still be absolute, or may not exist:
 * the daemon answers that, on click.
 */
export function worktreeFilePath(href: string | null | undefined): string | null {
  if (!href) return null
  const trimmed = href.trim()
  if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("//")) return null
  if (safeHttpUrl(trimmed)) return null
  // any scheme at all: mailto:, vscode:, and whatever a model invents
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null
  const path = trimmed.split("#", 1)[0]!.split("?", 1)[0]!
  return path === "" ? null : path
}

/**
 * `relative` resolved against the directory `from` sits in.
 *
 * Only needed because a rendered document can itself contain relative links,
 * and they mean "next to me", not "at the top of the worktree". Absolute paths
 * and `..` are passed through for the daemon to resolve and refuse — doing that
 * arithmetic twice is how the two copies come to disagree.
 */
export function resolveAgainst(from: string, relative: string): string {
  if (relative.startsWith("/")) return relative
  const dir = from.slice(0, from.lastIndexOf("/") + 1)
  return `${dir}${relative}`
}

/**
 * Ask for a worktree file to be shown. Absent outside a task view — the
 * gallery and the probe panel render prose with no worktree behind it, and a
 * path there is text.
 */
export interface WorktreeFileOpenOptions {
  /** The parsed patch for a row opened from Changes. */
  diff?: DiffFile
  /** The diff payload itself hit the daemon's byte cap. */
  diffTruncated?: boolean
}

export type WorktreeFileOpener = (path: string, options?: WorktreeFileOpenOptions) => void

export const WorktreeFileContext = createContext<WorktreeFileOpener | null>(null)

export function useWorktreeFileOpener(): WorktreeFileOpener | null {
  return useContext(WorktreeFileContext)
}
