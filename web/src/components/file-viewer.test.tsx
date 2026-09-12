import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import { ApiError, type DaemonTransport } from "@/lib/transport"
import { parseDiff } from "@/lib/diff"
import { PROSE_HIGHLIGHT_LIMIT } from "@/lib/prose-highlight"
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
      .mockResolvedValue({ ...PLAN, path: "notes.txt", text: "# just words\n" })
    withTransport(<FileViewer taskId="tk9zdy" path="notes.txt" onClose={() => {}} />, request)
    // the source as written, in a pre — not markdown-processed
    const pre = await waitFor(() => screen.getByText(/just words/))
    expect(pre.tagName).toBe("PRE")
    // the dialog's own title is an h2; a "# line" read as markdown would be an h1
    expect(screen.getByTestId("file-viewer").querySelector("h1")).toBeNull()
  })

  /** Source with a known extension keeps its bytes AND gets prose's colours. */
  it("highlights a code file with the same palette a transcript fence wears", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ ...PLAN, path: "src/a.ts", text: "export const a = 1\n" })
    withTransport(<FileViewer taskId="tk9zdy" path="src/a.ts" onClose={() => {}} />, request)
    // the viewer is a portal, so queries scope to it, not to render's container
    const viewer = await screen.findByTestId("file-viewer")
    await waitFor(() => expect(viewer.querySelector(".hljs-keyword")).not.toBeNull())
    expect(viewer.querySelector(".hljs-keyword")?.textContent).toBe("export")
    expect(viewer).toHaveTextContent("export const a = 1")
    // read as source: nothing in it was interpreted as markdown
    const pre = viewer.querySelector("pre")
    expect(pre).not.toBeNull()
    // Prose normally gives fences their own horizontal scroller. In the file
    // viewer that nested scroller traps vertical wheel events because
    // `scroll-slim` contains overscroll, so the viewer must own both axes.
    expect(pre?.parentElement?.parentElement).toHaveClass("[&_pre]:overflow-visible")
    expect(viewer.querySelector("h1")).toBeNull()
  })

  it("shows an editor-style full-file diff without hiding unchanged lines", async () => {
    const request = vi.fn().mockResolvedValue({
      ...PLAN,
      path: "src/a.ts",
      text: "const before = 1\nconst value = 2\nconst after = 3\n",
    })
    const diff = parseDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -2,1 +2,1 @@
-const value = 1
+const value = 2
`).files[0]!
    withTransport(
      <FileViewer taskId="tk9zdy" path="src/a.ts" onClose={() => {}} diff={diff} />,
      request,
    )
    const viewer = await screen.findByTestId("file-viewer")
    fireEvent.click(screen.getByRole("tab", { name: "Diff" }))
    expect(viewer).toHaveTextContent("const before = 1")
    expect(viewer).toHaveTextContent("const after = 3")
    expect(viewer.querySelector('[data-diff-line="del"]')).toHaveTextContent("const value = 1")
    expect(viewer.querySelector('[data-diff-line="del"]')).toHaveClass("bg-diff-del-bg")
    expect(viewer.querySelector('[data-diff-line="add"]')).toHaveTextContent("const value = 2")
    expect(viewer.querySelector('[data-diff-line="add"]')).toHaveClass("bg-diff-add-bg")
    expect(screen.getByRole("tab", { name: "Diff" })).toHaveAttribute("aria-selected", "true")

    fireEvent.click(screen.getByRole("tab", { name: "File" }))
    await waitFor(() => expect(viewer.querySelector(".hljs-keyword")).not.toBeNull())
  })

  it("labels both safety caps and skips expensive highlighting", async () => {
    const text = "export const value = 1\n".repeat(
      Math.ceil((PROSE_HIGHLIGHT_LIMIT + 1) / 23),
    )
    const request = vi.fn().mockResolvedValue({
      ...PLAN,
      path: "src/large.ts",
      text,
      bytes: 900_000,
      truncated: true,
    })
    withTransport(<FileViewer taskId="tk9zdy" path="src/large.ts" onClose={() => {}} />, request)
    const viewer = await screen.findByTestId("file-viewer")
    await waitFor(() => expect(viewer).toHaveTextContent("export const value = 1"))
    expect(viewer.querySelector(".hljs-keyword")).toBeNull()
    expect(viewer).toHaveTextContent("preview capped")
    expect(viewer).toHaveTextContent("highlighting off for performance")
  })

  /** A fence IN the file is text, not the end of the block it is shown in. */
  it("shows a file's own fences as content, never as structure", async () => {
    const request = vi.fn().mockResolvedValue({
      ...PLAN,
      path: "src/b.md.ts",
      text: "const doc = `# not a heading\n```\n`\n",
    })
    withTransport(<FileViewer taskId="tk9zdy" path="src/b.md.ts" onClose={() => {}} />, request)
    const viewer = await screen.findByTestId("file-viewer")
    await waitFor(() => expect(viewer.querySelector(".hljs-keyword")).not.toBeNull())
    expect(viewer).toHaveTextContent("# not a heading")
    expect(viewer.querySelector("h1")).toBeNull()
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
