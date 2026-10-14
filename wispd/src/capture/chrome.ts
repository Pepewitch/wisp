/**
 * Finding Chrome, starting one for a single capture, and making sure it is
 * gone afterwards. Each browser runs in its own process group with a fresh
 * profile under ~/.wisp/browser/<id>/ (never under a task, so exports and
 * retention never see cookies), and records that group so a daemon that died
 * mid-capture kills it on its next start.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { join } from "node:path"
import { WISP_HOME } from "../config"
import { processGroupEnded, signalProcessGroup } from "../process-tree"

export const BROWSER_DIR = join(WISP_HOME, "browser")
export const LAUNCH_TIMEOUT_MS = 60_000

const MAC_APPS = ["Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser"].map((name) => `${name}.app/Contents/MacOS/${name}`)
const LINUX_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]

export type ChromeFound = { path: string } | { reason: string }

/** The Chrome a capture uses: config, then CHROME_PATH, then where browsers usually live. Snap builds are refused (they cannot read ~/.wisp). */
export function findChrome(configured: string | undefined, env: Record<string, string | undefined> = process.env): ChromeFound {
  const named = configured ?? env.CHROME_PATH
  if (named) return existsSync(named) ? usable(named) : { reason: `${configured ? "chromePath" : "CHROME_PATH"} names ${named}, which does not exist` }
  const candidates = platform() === "darwin"
    ? MAC_APPS.flatMap((app) => [join("/Applications", app), join(homedir(), "Applications", app)])
    : LINUX_NAMES.flatMap((name) => (env.PATH ?? "").split(":").filter(Boolean).map((dir) => join(dir, name)))
  const found = candidates.find((candidate) => existsSync(candidate))
  return found ? usable(found) : { reason: "no Chrome, Chromium, Edge or Brave found: install one, or set chromePath in config.json" }
}

/** Whether `wisp capture` can run here: what the prompts teach depends on it. */
export function captureAvailable(chromePath: string | undefined): boolean {
  return "path" in findChrome(chromePath)
}

function usable(path: string): ChromeFound {
  if (path.startsWith("/snap/")) return { reason: `${path} is a snap build, which cannot use profiles under ~/.wisp: install Chrome from a .deb or set chromePath` }
  if (process.getuid?.() === 0) return { reason: "Wisp runs as root, and Chrome refuses its sandbox as root: run Wisp as a normal user" }
  return { path }
}

export interface LaunchedChrome {
  id: string
  pid: number
  profile: string
  /** the browser's DevTools WebSocket URL */
  endpoint: string
}

/** The flags every capture browser runs with: headless, private, quiet, and behind the capture's proxy. */
export function chromeArgs(profile: string, proxyPort: number): string[] {
  return [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-networking",
    "--disable-component-update", "--disable-default-apps", "--mute-audio", "--hide-scrollbars",
    // Chrome's own calls home would only show up as refusals the page never made
    "--disable-client-side-phishing-detection", "--disable-domain-reliability", "--no-pings", "--safebrowsing-disable-auto-update",
    "--disable-features=Translate,OptimizationHints,OptimizationGuideModelDownloading,MediaRouter,DialMediaRouteProvider,AutofillServerCommunication,CertificateTransparencyComponentUpdater",
    platform() === "darwin" ? "--use-mock-keychain" : "--password-store=basic",
    `--proxy-server=http://127.0.0.1:${proxyPort}`, "--proxy-bypass-list=<-loopback>",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "about:blank",
  ]
}

/** Start Chrome in its own process group and wait for its DevTools endpoint. */
export async function launchChrome(path: string, id: string, proxyPort: number, signal?: AbortSignal): Promise<LaunchedChrome> {
  const profile = join(BROWSER_DIR, id)
  const launched = { id, pid: 0, profile, endpoint: "" }
  try {
    mkdirSync(profile, { recursive: true, mode: 0o700 })
    // output ignored: an undrained pipe would stall a chatty Chrome
    const child = Bun.spawn([path, ...chromeArgs(profile, proxyPort)], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true })
    launched.pid = child.pid
    writeFileSync(join(BROWSER_DIR, `${id}.pgid`), String(child.pid))
    launched.endpoint = await devtoolsEndpoint(profile, child, signal)
    return launched
  } catch (error) {
    // whatever was acquired goes: a started browser, its profile, its record
    await stopChrome(launched)
    throw error
  }
}

/**
 * Whether a process is still the capture browser that profile belongs to. A
 * recorded pid can be reused by anything after a crash and a reboot, so a
 * process is signalled only while its own command line names that profile.
 */
export function isCaptureChrome(pid: number, profile: string): boolean {
  const ps = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" })
  return ps.exitCode === 0 && ps.stdout.toString().includes(`--user-data-dir=${profile}`)
}

async function devtoolsEndpoint(profile: string, child: Bun.Subprocess, signal?: AbortSignal): Promise<string> {
  const file = join(profile, "DevToolsActivePort")
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("the capture was cancelled while Chrome started")
    if (child.exitCode !== null) throw new Error(`Chrome exited during start (code ${child.exitCode}): run \`wisp doctor\` to see why`)
    try {
      const [port, path] = readFileSync(file, "utf8").trim().split(/\r?\n/)
      if (Number(port) > 0 && path) return `ws://127.0.0.1:${Number(port)}${path}`
    } catch {
      // the file appears once Chrome is listening
    }
    await Bun.sleep(50)
  }
  throw new Error(`Chrome did not start within ${LAUNCH_TIMEOUT_MS / 1000}s`)
}

/** TERM the browser's group, KILL it after 3 s, then remove its profile and record. */
export async function stopChrome(chrome: Pick<LaunchedChrome, "id" | "pid">, verify = false): Promise<void> {
  // verified only for a record left by another daemon; this daemon's own child is known to be ours
  const ours = () => !verify || isCaptureChrome(chrome.pid, join(BROWSER_DIR, chrome.id))
  if (chrome.pid > 1 && ours()) {
    signalProcessGroup(chrome.pid, "SIGTERM")
    if (!(await processGroupEnded(chrome.pid, 3_000)) && ours()) {
      signalProcessGroup(chrome.pid, "SIGKILL")
      await processGroupEnded(chrome.pid, 2_000)
    }
  }
  rmSync(join(BROWSER_DIR, chrome.id), { recursive: true, force: true })
  rmSync(join(BROWSER_DIR, `${chrome.id}.pgid`), { force: true })
}

/** At daemon start: every capture browser a previous daemon left behind is killed and its profile removed. */
export async function sweepCaptureBrowsers(): Promise<number> {
  if (!existsSync(BROWSER_DIR)) return 0
  let swept = 0
  for (const entry of readdirSync(BROWSER_DIR)) {
    const full = join(BROWSER_DIR, entry)
    if (entry.endsWith(".pgid")) {
      const pid = Number(readFileSync(full, "utf8").trim())
      if (Number.isInteger(pid) && pid > 1) await stopChrome({ id: entry.slice(0, -".pgid".length), pid }, true)
      else rmSync(full, { force: true })
      swept++
    } else if (statSync(full).isDirectory() && !existsSync(`${full}.pgid`)) {
      rmSync(full, { recursive: true, force: true })
    }
  }
  return swept
}
