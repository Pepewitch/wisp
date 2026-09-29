import { render, screen } from "@testing-library/react"
import type { ComponentProps } from "react"
import { describe, expect, it, vi } from "vitest"

import { fakeDaemonTransport } from "@/test/runtime"

// The terminal's code arrives when the test says so, the way a chunk does.
const chunk = vi.hoisted(() => {
  let arrive!: () => void
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve
  })
  return { arrived, arrive }
})
vi.mock("@/components/shell-view", async () => {
  await chunk.arrived
  return {
    ShellView: ({ shellId, active }: { shellId: number; active: boolean }) => (
      <div data-testid="xterm" data-active={active}>
        shell {shellId}
      </div>
    ),
  }
})

import { LazyShellView } from "./lazy-shell-view"

const props = (): ComponentProps<typeof LazyShellView> => ({
  transport: fakeDaemonTransport(),
  taskId: "t1",
  shellId: 3,
  active: true,
  register: vi.fn(),
  apple: true,
  daemonScreen: true,
  finding: null,
  onFind: vi.fn(),
  onFindClose: vi.fn(),
  touch: false,
})

describe("a shell tab whose terminal code is still arriving", () => {
  it("looks like a tab that is connecting, then becomes the terminal with the same props", async () => {
    const view = render(<LazyShellView {...props()} />)
    expect(screen.getByText("connecting…")).toBeInTheDocument()
    expect(screen.queryByTestId("xterm")).toBeNull()
    // the frame a loaded tab paints in, so nothing moves when xterm arrives
    expect(view.container.firstElementChild).toHaveClass("absolute", "inset-0", "flex", "flex-col")

    chunk.arrive()

    expect(await screen.findByTestId("xterm")).toHaveTextContent("shell 3")
    expect(screen.queryByText("connecting…")).toBeNull()
    // every later tab, on any task, mounts as the terminal straight away
    view.unmount()
    render(<LazyShellView {...props()} taskId="t2" shellId={4} active={false} />)
    expect(screen.queryByText("connecting…")).toBeNull()
    expect(screen.getByTestId("xterm")).toHaveTextContent("shell 4")
    expect(screen.getByTestId("xterm")).toHaveAttribute("data-active", "false")
  })
})
