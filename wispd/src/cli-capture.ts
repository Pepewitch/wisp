/**
 * `wisp capture <url>`: Wisp screenshots a page on this machine's loopback in
 * its own headless Chrome and stores the shot in the running turn. The image
 * comes back as a file the agent can open (with an extension, outside the
 * worktree), whichever harness it runs on.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CaptureBody, CaptureRecord, CaptureResponse } from "../../shared/api/captures"
import { CliApiError, daemonRequest, downloadOutputImage, exitApi } from "./cli-api"
import type { Flags } from "./cli-args"
import { print } from "./cli-print"
import { REVIEW_TOKEN_ENV } from "./turn-input"

/** Longer than the daemon's own capture budget (queue, launch, page), so the daemon's answer always arrives first. */
const CLI_TIMEOUT_MS = 200_000
export const CAPTURE_USAGE = "usage: wisp capture <url> [--area <name>] [--viewport desktop|mobile|<w>x<h>] [--dark] [--selector <css>] [--full-page] [--wait-for <css>] [--wait <ms>] [--script <file.js>] [--allow-port <n>]… [--name <label>] [--json]"

function bodyOf(url: string, flags: Flags, script: string | null): CaptureBody {
  const value = (key: string): string | undefined => (typeof flags[key] === "string" ? flags[key] as string : undefined)
  const ports = Array.isArray(flags["allow-port"]) ? flags["allow-port"].map(Number) : []
  const token = process.env[REVIEW_TOKEN_ENV]
  return {
    url, area: value("area"), name: value("name"), viewport: value("viewport"), dark: flags.dark === true, selector: value("selector"),
    fullPage: flags["full-page"] === true, waitFor: value("wait-for"), waitMs: value("wait") ? Number(value("wait")) : undefined,
    ...(script ? { script } : {}), ...(ports.length > 0 ? { allowPorts: ports } : {}), ...(token ? { token } : {}),
  }
}

function describe(capture: CaptureRecord): string[] {
  const lines = [
    `page: ${capture.finalUrl ?? capture.url} (HTTP ${capture.httpStatus ?? "?"}, ${capture.viewport}${capture.width ? `, ${capture.width}×${capture.height}px` : ""})`,
    `served from: ${capture.servedFrom === "worktree" ? "this task's worktree" : capture.servedFrom === "elsewhere" ? "a process outside this task's worktree (not this PR's code?)" : "unknown"}`,
  ]
  if (!capture.settled) lines.push("note: the network never went quiet (normal for live-reload or streaming pages)")
  if (capture.clipped) lines.push("note: the page was taller than a shot may be, so it was cut")
  if (capture.errors.length > 0) lines.push(`page errors (${capture.errors.length}): ${capture.errors.slice(0, 3).join(" | ")}`)
  if (capture.blocked.length > 0) lines.push(`blocked by Wisp (${capture.blocked.length}): ${capture.blocked.slice(0, 3).join(", ")}${capture.blocked.length > 3 ? ", …" : ""}`)
  return lines
}

/** Flags that take a value: one given bare (at the end, or before another flag) would quietly take a different shot. */
const VALUE_OPTIONS = ["area", "name", "viewport", "selector", "wait-for", "wait", "script", "allow-port"]

export async function captureCommand(positional: string[], flags: Flags): Promise<void> {
  const [url] = positional
  const task = process.env.WISP_TASK_ID
  if (!url) throw new Error(CAPTURE_USAGE)
  const bare = VALUE_OPTIONS.find((key) => flags[key] === true)
  if (bare) throw new Error(`--${bare} needs a value\n${CAPTURE_USAGE}`)
  if (!task) throw new Error("wisp capture runs inside a task's turn (WISP_TASK_ID is not set)")
  const script = typeof flags.script === "string" ? await Bun.file(flags.script).text().catch(() => { throw new Error(`cannot read --script ${flags.script}`) }) : null
  let result: CaptureResponse
  try {
    result = await daemonRequest(`/api/tasks/${task}/capture`, "POST", JSON.stringify(bodyOf(url, flags, script)), "application/json", CLI_TIMEOUT_MS) as CaptureResponse
  } catch (error) {
    if (error instanceof CliApiError && error.status === 422 && error.data?.capture) {
      const capture = error.data.capture as CaptureRecord
      if (flags.json) print(JSON.stringify(error.data))
      else print([`Capture failed (${capture.reason}): ${capture.message}`, ...(capture.reason === "no-chrome" ? ["Make the image another way and publish it with `wisp output add`; Wisp has recorded that it could not capture."] : [])].join("\n"))
      process.exit(1)
    }
    exitApi(error)
  }
  const { capture, imageUrl } = result
  const dir = join(process.env.TMPDIR ?? tmpdir(), "wisp-captures", task)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `${capture.id}.${capture.mediaType === "image/jpeg" ? "jpg" : "png"}`)
  writeFileSync(file, await downloadOutputImage(imageUrl!), { mode: 0o600 })
  if (flags.json) return print(JSON.stringify({ ...result, file }))
  print([
    `Captured ${capture.id}${capture.area ? ` for area ${capture.area}` : ""}: ${file}`,
    ...describe(capture),
    "Look at the file with your image or file-reading tool. If you cannot see images, say so rather than guess.",
  ].join("\n"))
}
