import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import { ApiError, type DaemonTransport } from "@/lib/transport"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { FileViewer, FileViewerProvider } from "./file-viewer"
import { Prose } from "./prose"

/** `request` is whatever the test wants to answer with; the transport's own
 * generic signature is not what a mock is written against. */
function withTransport(node: ReactNode, request: unknown) {
  return render(node, {
    wrapper: runtimeWrapper(
      fakeDaemonTransport("test-connection", {
        request: request as DaemonTransport["request"],
      }),
    ),
  })
}

const PLAN = {
  kind: "text" as const,
  path: ".context/PLAN.md",
  text: "# The plan\n\nStep **one**.\n",
  bytes: 26,
  truncated: false,
}

describe("the worktree file viewer", () => {
  /** A plan is a document. Reading it as source is what the popup exists to avoid. */
  it("renders markdown, and names the file it read", async () => {
    const request = vi.fn().mockResolvedValue(PLAN)
    withTransport(
      <FileViewer taskId="tk9zdy" path=".context/PLAN.md" onClose={() => {}} />,
      request,
    )
    await waitFor(() => expect(screen.getByRole("heading", { name: "The plan" })).toBeInTheDocument())
    expect(screen.getByText("one")).toBeInTheDocument()
    expect(request).toHaveBeenCalledWith("/api/tasks/tk9zdy/file?path=.context%2FPLAN.md")
    expect(screen.getByTestId("file-viewer-path")).toHaveTextContent(".context/PLAN.md")
  })

  it("reads anything else as its own bytes rather than as a document", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ ...PLAN, path: "src/a.ts", text: "export const a = 1\n" })
    withTransport(<FileViewer taskId="tk9zdy" path="src/a.ts" onClose={() => {}} />, request)
    // the source as written, in a pre — not markdown-processed
    const pre = await waitFor(() => screen.getByText(/export const a = 1/))
    expect(pre.tagName).toBe("PRE")
  })

  /** Binary is a state the viewer can talk about, which is why it is not an error. */
  it("says a binary has nothing to read instead of failing", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ kind: "binary", path: "blob.bin", bytes: 2048 })
    withTransport(<FileViewer taskId="tk9zdy" path="blob.bin" onClose={() => {}} />, request)
    await waitFor(() => expect(screen.getByText(/nothing to read here/)).toBeInTheDocument())
  })

  it("shows the daemon's own refusal", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(new ApiError("no such file in this task's worktree", 404))
    withTransport(<FileViewer taskId="tk9zdy" path="gone.md" onClose={() => {}} />, request)
    await waitFor(() =>
      expect(screen.getByText("no such file in this task's worktree")).toBeInTheDocument(),
    )
  })

  /**
   * The reveal is the desktop's extra. In the browser, and on a connection
   * whose paths are on another machine, the button is absent rather than
   * present and broken.
   */
  it("offers a reveal only when the client passed one", async () => {
    const request = vi.fn().mockResolvedValue(PLAN)
    const { unmount } = withTransport(
      <FileViewer taskId="tk9zdy" path=".context/PLAN.md" onClose={() => {}} />,
      request,
    )
    await waitFor(() =>
      expect(screen.getByTestId("file-viewer-path")).toHaveTextContent(".context/PLAN.md"),
    )
    expect(screen.queryByRole("button", { name: "Reveal in Finder" })).toBeNull()
    unmount()

    const onReveal = vi.fn()
    withTransport(
      <FileViewer taskId="tk9zdy" path=".context/PLAN.md" onClose={() => {}} onReveal={onReveal} />,
      request,
    )
    const reveal = await waitFor(() => screen.getByRole("button", { name: "Reveal in Finder" }))
    fireEvent.click(reveal)
    // the canonical path the daemon reported, not the one that was clicked
    expect(onReveal).toHaveBeenCalledWith(".context/PLAN.md")
  })

  it("fetches nothing until a path is opened", () => {
    const request = vi.fn()
    withTransport(<FileViewer taskId="tk9zdy" path={null} onClose={() => {}} />, request)
    expect(request).not.toHaveBeenCalled()
    expect(screen.queryByTestId("file-viewer")).toBeNull()
  })
})

describe("the file viewer's provider", () => {
  /** One popup per task view: prose asks, the provider shows. */
  it("opens the file a link in prose names", async () => {
    const request = vi.fn().mockResolvedValue(PLAN)
    withTransport(
      <FileViewerProvider taskId="tk9zdy">
        <Prose text="the plan is in [PLAN.md](.context/PLAN.md)" />
      </FileViewerProvider>,
      request,
    )
    expect(request).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "PLAN.md" }))
    await waitFor(() => expect(screen.getByRole("heading", { name: "The plan" })).toBeInTheDocument())
  })

  /**
   * A document's own relative link means "next to me". Resolving it against
   * the worktree root would open a file that is not the one it points at.
   */
  it("follows a link inside a document relative to that document", async () => {
    const request = vi.fn(async (path: string) =>
      path.includes("NOTES")
        ? { ...PLAN, path: ".context/NOTES.md", text: "# The notes\n" }
        : { ...PLAN, text: "see [NOTES.md](NOTES.md)\n" },
    )
    withTransport(
      <FileViewerProvider taskId="tk9zdy">
        <Prose text="[PLAN.md](.context/PLAN.md)" />
      </FileViewerProvider>,
      request,
    )
    fireEvent.click(screen.getByRole("button", { name: "PLAN.md" }))
    const nested = await waitFor(() => screen.getByRole("button", { name: "NOTES.md" }))
    fireEvent.click(nested)
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "The notes" })).toBeInTheDocument(),
    )
    expect(request).toHaveBeenLastCalledWith(
      "/api/tasks/tk9zdy/file?path=.context%2FNOTES.md",
    )
  })

  it("leaves a path as text when there is no task behind the prose", () => {
    const request = vi.fn()
    withTransport(
      <FileViewerProvider taskId={null}>
        <Prose text="the plan is in [PLAN.md](.context/PLAN.md)" />
      </FileViewerProvider>,
      request,
    )
    expect(screen.queryByRole("button", { name: "PLAN.md" })).toBeNull()
    expect(screen.getByText(/the plan is in/)).toBeInTheDocument()
  })
})
