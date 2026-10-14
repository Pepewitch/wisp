/**
 * Whose server a captured page came from: the process listening on its
 * loopback port, and whether that process runs inside the reviewer's own
 * worktree. A dev server the author left running, or one a previous task
 * left on a reused port, serves code that is not this PR's head; a capture
 * of it is shown to the person, but it does not count as this review's proof.
 */
import { realpathSync } from "node:fs"
import { sep } from "node:path"
import { runBounded } from "../subprocess"

export type ServedFrom = "worktree" | "elsewhere" | "unknown"

const LSOF_TIMEOUT_MS = 5_000

/** The pids listening on a TCP port on this machine, from lsof (macOS and Linux). */
async function listeners(port: number): Promise<number[] | null> {
  const run = await runBounded({ cmd: ["lsof", "-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], timeoutMs: LSOF_TIMEOUT_MS, maxBytes: 64 * 1024 })
    .catch(() => null)
  // lsof exits 1 when nothing matched; anything else unreadable is "unknown"
  if (!run || run.timedOut || (run.exitCode !== 0 && run.exitCode !== 1)) return null
  return run.out.split("\n").filter((line) => line.startsWith("p")).map((line) => Number(line.slice(1))).filter((pid) => pid > 0)
}

async function cwdOf(pid: number): Promise<string | null> {
  const run = await runBounded({ cmd: ["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"], timeoutMs: LSOF_TIMEOUT_MS, maxBytes: 64 * 1024 }).catch(() => null)
  if (!run || run.exitCode !== 0) return null
  const line = run.out.split("\n").find((entry) => entry.startsWith("n"))
  return line ? line.slice(1) : null
}

function inside(path: string, root: string): boolean {
  const real = (value: string) => { try { return realpathSync(value) } catch { return value } }
  const child = real(path), parent = real(root)
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
}

/** Where the page on this loopback port is served from, as far as this machine can say. */
export async function servedFrom(port: number, worktree: string | null): Promise<ServedFrom> {
  if (!worktree) return "unknown"
  const pids = await listeners(port)
  if (!pids || pids.length === 0) return "unknown"
  const cwds = await Promise.all(pids.map(cwdOf))
  if (cwds.some((cwd) => cwd === null)) return "unknown"
  return cwds.every((cwd) => inside(cwd!, worktree)) ? "worktree" : "elsewhere"
}
