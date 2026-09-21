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

export interface WorktreeFileTarget {
  path: string
  line?: number
  endLine?: number
}

/**
 * The worktree file and source lines an href names, or null when it is not one.
 *
 * Agents commonly copy compiler-style `path:42` locations, while source hosts
 * use `path#L42` and `path#L42-L50`. Lines are presentation metadata: only the
 * path goes to the daemon, so its containment check still owns the boundary.
 */
export function worktreeFileTarget(
  href: string | null | undefined,
): WorktreeFileTarget | null {
  if (!href) return null
  const trimmed = href.trim()
  if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("//")) return null
  if (safeHttpUrl(trimmed)) return null

  const hash = trimmed.indexOf("#")
  const fragment = hash === -1 ? "" : trimmed.slice(hash + 1)
  const beforeFragment = hash === -1 ? trimmed : trimmed.slice(0, hash)
  const query = beforeFragment.indexOf("?")
  let path = query === -1 ? beforeFragment : beforeFragment.slice(0, query)

  const githubLines = /^L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(fragment)
  const diagnosticLine = /^(.*?):([1-9]\d*)(?::\d+)?$/.exec(path)
  let line: number | undefined
  let endLine: number | undefined
  if (githubLines) {
    line = Number(githubLines[1])
    endLine = githubLines[2] === undefined ? undefined : Number(githubLines[2])
  } else if (diagnosticLine) {
    const candidate = diagnosticLine[1]!
    // Preserve ordinary schemes and host:port links. Compiler locations carry
    // an unambiguous path marker; bare filenames can use GitHub's `#L42`.
    if (candidate.includes("/") || candidate.startsWith(".")) {
      path = candidate
      line = Number(diagnosticLine[2])
    }
  }

  // any scheme at all: mailto:, vscode:, and whatever a model invents
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null
  if (path === "") return null
  if (endLine !== undefined && endLine < line!) endLine = line
  return { path, line, endLine }
}

/**
 * The worktree path an href names, without any source location.
 *
 * Kept as the small path-only API for callers that do not present a viewer.
 */
export function worktreeFilePath(href: string | null | undefined): string | null {
  return worktreeFileTarget(href)?.path ?? null
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
  /** One-based source line requested by the link that opened the file. */
  line?: number
  /** Inclusive end of a GitHub-style source-line range. */
  endLine?: number
}

export type WorktreeFileOpener = (path: string, options?: WorktreeFileOpenOptions) => void

export const WorktreeFileContext = createContext<WorktreeFileOpener | null>(null)

export function useWorktreeFileOpener(): WorktreeFileOpener | null {
  return useContext(WorktreeFileContext)
}
