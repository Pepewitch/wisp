import { fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import type { TurnAttachment } from "@/lib/types"
import type { DaemonTransport } from "@/lib/transport"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { TurnAttachments } from "./turn-attachments"

/**
 * A1a's read side: a past turn's images come back from the daemon by path, open
 * large on click, and — when the task is archived and the bytes are gone — say
 * so instead of rendering a thumbnail that 410s.
 */

const IMAGES: TurnAttachment[] = [
  { name: "cramped.png", size: 12 * 1024, mediaType: "image/png" },
  { name: "spacing shot.png", size: 1_258_291, mediaType: "image/png" },
]

function mount(node: ReactNode, transport = fakeDaemonTransport()) {
  return render(node, { wrapper: runtimeWrapper(transport) })
}

describe("TurnAttachments", () => {
  it("renders nothing at all for a turn that carried no images", () => {
    const { container } = mount(<TurnAttachments taskId="tk9zdy" turn={2} attachments={[]} archived={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders one thumbnail per image, addressed at the turn's bytes route", () => {
    mount(<TurnAttachments taskId="tk9zdy" turn={2} attachments={IMAGES} archived={false} />)
    const thumbs = screen.getAllByRole("img")
    expect(thumbs).toHaveLength(2)
    expect(thumbs[0]!.getAttribute("src")).toBe("/api/tasks/tk9zdy/attachments/2/cramped.png")
    // a space in a name is a path segment on the wire and must be encoded
    expect(thumbs[1]!.getAttribute("src")).toBe("/api/tasks/tk9zdy/attachments/2/spacing%20shot.png")
  })

  it("routes every thumbnail through the active connection's asset namespace", () => {
    const assetUrl = vi.fn((path: string) => `/connections/remote-one${path}`)
    const transport = fakeDaemonTransport("remote-one", {
      assetUrl: assetUrl as DaemonTransport["assetUrl"],
    })

    mount(<TurnAttachments taskId="duplicate-task" turn={2} attachments={IMAGES} archived={false} />, transport)

    expect(screen.getAllByRole("img").map((image) => image.getAttribute("src"))).toEqual([
      "/connections/remote-one/api/tasks/duplicate-task/attachments/2/cramped.png",
      "/connections/remote-one/api/tasks/duplicate-task/attachments/2/spacing%20shot.png",
    ])
    expect(assetUrl).toHaveBeenCalledTimes(2)
  })

  it("names the file and its size on hover, without a chip or a badge", () => {
    mount(<TurnAttachments taskId="tk9zdy" turn={2} attachments={IMAGES} archived={false} />)
    expect(screen.getByLabelText("View cramped.png")).toHaveAttribute("title", "cramped.png · 12 KB")
    expect(screen.getByLabelText("View spacing shot.png")).toHaveAttribute("title", "spacing shot.png · 1.2 MB")
  })

  it("clicking a thumbnail opens the presentation view on THAT image", () => {
    mount(<TurnAttachments taskId="tk9zdy" turn={2} attachments={IMAGES} archived={false} />)
    expect(screen.queryByTestId("image-viewer")).toBeNull()

    fireEvent.click(screen.getByLabelText("View spacing shot.png"))
    const viewer = screen.getByTestId("image-viewer")
    expect(viewer).toBeTruthy()
    // the caption names the clicked image, not the first one
    expect(viewer.textContent).toContain("spacing shot.png")
    expect(viewer.textContent).toContain("1.2 MB")
    expect(viewer.textContent).toContain("2 of 2")
  })

  it("left and right step through the rest of the turn's images, wrapping", () => {
    mount(<TurnAttachments taskId="tk9zdy" turn={2} attachments={IMAGES} archived={false} />)
    fireEvent.click(screen.getByLabelText("View cramped.png"))
    expect(screen.getByTestId("image-viewer").textContent).toContain("1 of 2")

    fireEvent.keyDown(window, { key: "ArrowRight" })
    expect(screen.getByTestId("image-viewer").textContent).toContain("2 of 2")

    // wrapping forward returns to the first, so there is no dead end
    fireEvent.keyDown(window, { key: "ArrowRight" })
    expect(screen.getByTestId("image-viewer").textContent).toContain("1 of 2")

    fireEvent.keyDown(window, { key: "ArrowLeft" })
    expect(screen.getByTestId("image-viewer").textContent).toContain("2 of 2")
  })

  it("an archived turn names its images and says they were removed — no thumbnail, not silence", () => {
    mount(<TurnAttachments taskId="tk9zdy" turn={2} attachments={IMAGES} archived />)
    expect(screen.queryAllByRole("img")).toHaveLength(0)
    expect(screen.queryAllByRole("button")).toHaveLength(0)
    expect(screen.getByTestId("turn-attachments-removed").textContent).toBe(
      "cramped.png, spacing shot.png — removed when this task was archived",
    )
  })
})
