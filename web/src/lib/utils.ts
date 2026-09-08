import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** How much daemon-supplied prose any one muted note is allowed to render. */
export const NOTE_CAP = 180

/**
 * One line, capped — the pane's OWN ceiling on text the daemon sent.
 *
 * The daemon already sanitizes git's stderr to its first line, and this exists
 * anyway: the reported bug was ~40 lines of `git diff` usage rendered verbatim
 * in the Changes pane, and no future git failure should be able to do that again
 * just because it reached the browser.
 */
export function oneLine(text: string, cap = NOTE_CAP): string {
  const first = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "")
  if (first === undefined) return ""
  return first.length > cap ? `${first.slice(0, cap)}…` : first
}
