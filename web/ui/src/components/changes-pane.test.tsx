import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

const mocks = vi.hoisted(() => ({ api: vi.fn() }))

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: mocks.api,
}))

import { ChangesPane } from "./changes-pane"

const TRACKED = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,2 @@
 line
+TRACKED_ADD
`

const UNTRACKED = `diff --git a/scratch.txt b/scratch.txt
new file mode 100644
--- /dev/null
+++ b/scratch.txt
@@ -0,0 +1 @@
+UNTRACKED_CONTENT
`

function withClient(node: ReactNode) {
  return render(node, {
    wrapper: runtimeWrapper(fakeDaemonTransport("test-connection", { request: mocks.api })),
  })
}

function okDiff(over: { diff?: string; untracked?: string[]; truncated?: boolean } = {}) {
  mocks.api.mockResolvedValue({
    diff: over.diff ?? `${TRACKED}${UNTRACKED}`,
    truncated: over.truncated ?? false,
    untracked: over.untracked ?? ["scratch.txt"],
    base: "8f2a1c9",
    worktreeReason: null,
  })
}

describe("the Changes pane's untracked files", () => {
  it("lists an untracked path once, labelled untracked, and shows nothing until click", async () => {
    okDiff()
    withClient(<ChangesPane taskId="tk9zdy" archived={false} />)
    await waitFor(() => expect(screen.getByText("scratch.txt")).toBeInTheDocument())
    expect(screen.getAllByText("scratch.txt")).toHaveLength(1)
    expect(screen.getByText("untracked")).toBeInTheDocument()
    expect(screen.queryByText(/UNTRACKED_CONTENT/)).toBeNull()
    expect(screen.queryByText(/TRACKED_ADD/)).toBeNull()
  })

  it("clicking an untracked file shows its contents as a new-file diff", async () => {
    okDiff()
    withClient(<ChangesPane taskId="tk9zdy" archived={false} />)
    await waitFor(() => expect(screen.getByText("scratch.txt")).toBeInTheDocument())
    fireEvent.click(screen.getByText("scratch.txt"))
    expect(screen.getByText(/UNTRACKED_CONTENT/)).toBeInTheDocument()
    expect(screen.queryByText(/TRACKED_ADD/)).toBeNull()
    expect(screen.getByText("scratch.txt").closest("button")).toHaveClass("bg-accent")
  })

  it("clicking a tracked file still shows that file, not the untracked patch", async () => {
    okDiff()
    withClient(<ChangesPane taskId="tk9zdy" archived={false} />)
    await waitFor(() => expect(screen.getByText("a.ts")).toBeInTheDocument())
    fireEvent.click(screen.getByText("a.ts"))
    expect(screen.getByText(/TRACKED_ADD/)).toBeInTheDocument()
    expect(screen.queryByText(/UNTRACKED_CONTENT/)).toBeNull()
  })

  it("an untracked file with no patch is a muted note, not silence", async () => {
    okDiff({ diff: TRACKED, untracked: ["scratch.txt"] })
    withClient(<ChangesPane taskId="tk9zdy" archived={false} />)
    await waitFor(() => expect(screen.getByText("scratch.txt")).toBeInTheDocument())
    fireEvent.click(screen.getByText("scratch.txt"))
    expect(screen.getByText("Untracked file — nothing to show")).toBeInTheDocument()
    expect(screen.getByText("scratch.txt").closest("button")).toHaveClass("bg-accent")
  })

  it("an untracked binary file uses the same empty register as a tracked binary", async () => {
    okDiff({
      diff: `diff --git a/logo.png b/logo.png
new file mode 100644
Binary files /dev/null and b/logo.png differ
`,
      untracked: ["logo.png"],
    })
    withClient(<ChangesPane taskId="tk9zdy" archived={false} />)
    await waitFor(() => expect(screen.getByText("logo.png")).toBeInTheDocument())
    fireEvent.click(screen.getByText("logo.png"))
    expect(screen.getByText("Binary file — nothing to show")).toBeInTheDocument()
  })

  it("an empty untracked file says so rather than rendering an empty hunk box", async () => {
    okDiff({
      diff: `diff --git a/empty.txt b/empty.txt
new file mode 100644
index 0000000..e69de29
`,
      untracked: ["empty.txt"],
    })
    withClient(<ChangesPane taskId="tk9zdy" archived={false} />)
    await waitFor(() => expect(screen.getByText("empty.txt")).toBeInTheDocument())
    fireEvent.click(screen.getByText("empty.txt"))
    expect(screen.getByText("Empty file — nothing to show")).toBeInTheDocument()
  })
})
