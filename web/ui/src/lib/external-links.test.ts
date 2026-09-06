import { beforeEach, describe, expect, it, vi } from "vitest"

import { externalLinkProps, revealFileHandler } from "./external-links"

const isTauri = vi.hoisted(() => vi.fn(() => false))
vi.mock("@tauri-apps/api/core", () => ({ isTauri }))

// The frozen real bridge cannot be spied on, and its only relevance here is
// which URL reaches native code.
const openExternalUrl = vi.hoisted(() => vi.fn<(url: string) => Promise<void>>())
const revealWorktreeFile = vi.hoisted(() =>
  vi.fn<(input: Record<string, string>) => Promise<void>>()
)
vi.mock("./desktop-bridge", () => ({
  desktopBridge: { openExternalUrl, revealWorktreeFile },
}))

/** A click React would deliver, with only what the handler reads. */
function click(modified = false): {
  preventDefault: ReturnType<typeof vi.fn>
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
} {
  return {
    preventDefault: vi.fn(),
    metaKey: modified,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  }
}

type Click = Parameters<NonNullable<ReturnType<typeof externalLinkProps>>["onClick"]>[0]

describe("external link props", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    isTauri.mockReturnValue(false)
    openExternalUrl.mockReset()
    openExternalUrl.mockResolvedValue(undefined)
    revealWorktreeFile.mockReset()
    revealWorktreeFile.mockResolvedValue(undefined)
  })

  it("is an ordinary blank-target anchor, so a link still reads as one", () => {
    expect(externalLinkProps("https://example.test/pull/1")).toMatchObject({
      href: "https://example.test/pull/1",
      target: "_blank",
      rel: "noopener noreferrer",
    })
  })

  /**
   * Agent prose is the least trusted href in the app. A relative path would
   * resolve against the app's own origin and navigate the shell away from
   * itself; a foreign scheme is somebody else's program.
   */
  it("refuses anything that is not an absolute http(s) address", () => {
    for (const href of [
      "web/ui/src/lib/terminal.ts",
      "/etc/passwd",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,hi",
      "",
      null,
      undefined,
    ]) {
      expect(externalLinkProps(href)).toBeNull()
    }
  })

  it("leaves the browser's own anchor behavior alone", () => {
    const event = click()
    externalLinkProps("https://example.test/a")!.onClick(event as unknown as Click)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(openExternalUrl).not.toHaveBeenCalled()
  })

  /**
   * The packaged webview has no new-window handler, so `target="_blank"` is
   * inert there and the click has to be handed to native code instead.
   */
  it("hands the URL to native code in the desktop runtime", () => {
    isTauri.mockReturnValue(true)
    const event = click()
    externalLinkProps("https://example.test/a")!.onClick(event as unknown as Click)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.test/a")
  })

  /** Desktop has no new-tab alternative to defer to, so it takes those too. */
  it("takes a modified click on desktop but not in the browser", () => {
    const browser = click(true)
    externalLinkProps("https://example.test/a")!.onClick(browser as unknown as Click)
    expect(browser.preventDefault).not.toHaveBeenCalled()

    isTauri.mockReturnValue(true)
    const desktop = click(true)
    externalLinkProps("https://example.test/a")!.onClick(desktop as unknown as Click)
    expect(desktop.preventDefault).toHaveBeenCalledOnce()
    expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(
      "https://example.test/a"
    )
  })

  it("reports a refused open rather than throwing into the click", async () => {
    isTauri.mockReturnValue(true)
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    openExternalUrl.mockRejectedValue(
      new Error("only http and https links open outside the app")
    )
    externalLinkProps("https://example.test/a")!.onClick(click() as unknown as Click)
    await Promise.resolve()
    expect(error).toHaveBeenCalled()
  })
})

/**
 * Revealing a file is a this-machine action, so the button's absence is the
 * feature: a browser has no file manager to point at, and a remote daemon's
 * worktree is not on this Mac.
 */
describe("revealFileHandler", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    isTauri.mockReturnValue(true)
    revealWorktreeFile.mockReset()
    revealWorktreeFile.mockResolvedValue(undefined)
  })

  it("is absent in the browser, off Local, and before a worktree exists", () => {
    isTauri.mockReturnValue(false)
    expect(revealFileHandler("local", "/w/task")).toBeUndefined()
    isTauri.mockReturnValue(true)
    expect(revealFileHandler("remote-one", "/w/task")).toBeUndefined()
    expect(revealFileHandler("local", null)).toBeUndefined()
  })

  it("names the connection, the worktree, and the file", () => {
    const reveal = revealFileHandler("local", "/w/task")
    expect(reveal).toBeDefined()
    reveal!(".context/PLAN.md")
    expect(revealWorktreeFile).toHaveBeenCalledExactlyOnceWith({
      connectionId: "local",
      worktreePath: "/w/task",
      path: ".context/PLAN.md",
    })
  })

  it("reports a refused reveal rather than throwing into the click", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    revealWorktreeFile.mockRejectedValue(new Error("only an absolute path can be revealed"))
    revealFileHandler("local", "/w/task")!("PLAN.md")
    await Promise.resolve()
    expect(error).toHaveBeenCalled()
  })
})
