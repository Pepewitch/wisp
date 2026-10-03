import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { TurnAttachment } from "@/lib/types"
import type { DaemonTransport } from "@/lib/transport"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { TurnAttachments } from "./turn-attachments"

/**
 * A1a's read side: a past turn's attachments come back from the daemon by path,
 * open large on click, and — when the task is archived and the bytes are gone —
 * say so instead of rendering a thumbnail that 410s. A1d added the kinds that
 * have no thumbnail to draw.
 */

const IMAGES: TurnAttachment[] = [
  { name: "cramped.png", size: 12 * 1024, mediaType: "image/png" },
  { name: "spacing shot.png", size: 1_258_291, mediaType: "image/png" },
]

function mount(node: ReactNode, transport = fakeDaemonTransport()) {
  return render(node, { wrapper: runtimeWrapper(transport) })
}

describe("TurnAttachments", () => {
  it("renders nothing at all for a turn that carried no attachments", () => {
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
    expect(screen.queryByTestId("attachment-viewer")).toBeNull()

    fireEvent.click(screen.getByLabelText("View spacing shot.png"))
    const viewer = screen.getByTestId("attachment-viewer")
    expect(viewer).toBeTruthy()
    // the caption names the clicked image, not the first one
    expect(viewer.textContent).toContain("spacing shot.png")
    expect(viewer.textContent).toContain("1.2 MB")
    expect(viewer.textContent).toContain("2 of 2")
  })

  it("left and right step through the rest of the turn's images, wrapping", () => {
    mount(<TurnAttachments taskId="tk9zdy" turn={2} attachments={IMAGES} archived={false} />)
    fireEvent.click(screen.getByLabelText("View cramped.png"))
    expect(screen.getByTestId("attachment-viewer").textContent).toContain("1 of 2")

    fireEvent.keyDown(window, { key: "ArrowRight" })
    expect(screen.getByTestId("attachment-viewer").textContent).toContain("2 of 2")

    // wrapping forward returns to the first, so there is no dead end
    fireEvent.keyDown(window, { key: "ArrowRight" })
    expect(screen.getByTestId("attachment-viewer").textContent).toContain("1 of 2")

    fireEvent.keyDown(window, { key: "ArrowLeft" })
    expect(screen.getByTestId("attachment-viewer").textContent).toContain("2 of 2")
  })

  it("A1d: a video opens in the same viewer; a pdf is a download", () => {
    const mixed: TurnAttachment[] = [
      { name: "clip.mp4", size: 47 * 1024 * 1024, mediaType: "video/mp4" },
      { name: "spec.pdf", size: 2048, mediaType: "application/pdf" },
    ]
    mount(<TurnAttachments taskId="tk9zdy" turn={3} attachments={mixed} archived={false} />)

    // a pdf is a link that SAVES — the daemon serves it as an attachment
    const pdf = screen.getByTitle("Download spec.pdf")
    expect(pdf.getAttribute("href")).toBe("/api/tasks/tk9zdy/attachments/3/spec.pdf")
    expect(pdf.getAttribute("download")).toBe("spec.pdf")
    expect(pdf.textContent).toBe("spec.pdf · pdf · 2 KB")

    fireEvent.click(screen.getByLabelText("View clip.mp4"))
    const viewer = screen.getByTestId("attachment-viewer")
    expect(viewer.textContent).toContain("clip.mp4")
    expect(screen.getByTestId("attachment-video").getAttribute("src")).toBe(
      "/api/tasks/tk9zdy/attachments/3/clip.mp4",
    )
  })

  describe("text attachments", () => {
    const served = new Map<string, string>()
    beforeEach(() => {
      served.clear()
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          served.has(url) ? new Response(served.get(url)) : new Response("gone", { status: 404 }),
        ),
      )
    })
    afterEach(() => vi.unstubAllGlobals())

    const path = (name: string) => `/api/tasks/tk9zdy/attachments/3/${encodeURIComponent(name)}`

    it("a text file's row opens the reading popup on its text, with a download", async () => {
      served.set(path("notes.txt"), "first line\nsecond line\n")
      mount(
        <TurnAttachments
          taskId="tk9zdy"
          turn={3}
          attachments={[{ name: "notes.txt", size: 23, mediaType: "text/plain" }]}
          archived={false}
        />,
      )
      const row = screen.getByRole("button", { name: "Preview notes.txt" })
      expect(row.textContent).toBe("notes.txt · text · 23 B")
      expect(screen.queryByTestId("attachment-text-viewer")).toBeNull()

      fireEvent.click(row)
      const viewer = await screen.findByTestId("attachment-text-viewer")
      await waitFor(() => expect(viewer.textContent).toContain("second line"))
      expect(within(viewer).getByText("Download").closest("a")).toHaveAttribute("download", "notes.txt")
      // a plain text file has nothing to tabulate
      expect(within(viewer).queryByRole("tab")).toBeNull()
    })

    it("a csv shows its first five rows inline, and View all opens Table and Raw", async () => {
      const csv = ["sku,qty", ...Array.from({ length: 8 }, (_, i) => `S-${i + 1},${i + 1}`)].join("\n")
      served.set(path("orders.csv"), csv)
      mount(
        <TurnAttachments
          taskId="tk9zdy"
          turn={3}
          attachments={[{ name: "orders.csv", size: csv.length, mediaType: "text/plain" }]}
          archived={false}
        />,
      )
      const card = await screen.findByTestId("attachment-table")
      expect(within(card).getAllByRole("row")).toHaveLength(1 + 5)
      expect(card.textContent).toContain("8 rows × 2 cols")
      expect(within(card).queryByText("S-6")).toBeNull()

      fireEvent.click(within(card).getByRole("button", { name: "Preview orders.csv" }))
      const viewer = await screen.findByTestId("attachment-text-viewer")
      expect(within(viewer).getAllByRole("row")).toHaveLength(1 + 8)
      expect(within(viewer).getByRole("tab", { name: "Table" })).toHaveAttribute("aria-selected", "true")

      fireEvent.click(within(viewer).getByRole("tab", { name: "Raw" }))
      expect(within(viewer).queryByRole("table")).toBeNull()
      expect(viewer.textContent).toContain("S-8,8")
    })

    it("a table wider than twelve columns draws twelve and says how many it left out", async () => {
      const header = Array.from({ length: 20 }, (_, i) => `c${i + 1}`).join("\t")
      const row = Array.from({ length: 20 }, (_, i) => `v${i + 1}`).join("\t")
      const tsv = `${header}\n${row}\n`
      served.set(path("wide.tsv"), tsv)
      mount(
        <TurnAttachments
          taskId="tk9zdy"
          turn={3}
          attachments={[{ name: "wide.tsv", size: tsv.length, mediaType: "text/plain" }]}
          archived={false}
        />,
      )
      const card = await screen.findByTestId("attachment-table")
      expect(within(card).getAllByRole("columnheader")).toHaveLength(12 + 1)
      expect(within(card).getByTestId("table-hidden-columns").textContent).toBe("+8 cols")
      expect(within(card).getByTestId("table-columns-shown").textContent).toBe("(12 shown)")
      expect(within(card).queryByText("c13")).toBeNull()

      fireEvent.click(within(card).getByRole("button", { name: "Preview wide.tsv" }))
      const viewer = await screen.findByTestId("attachment-text-viewer")
      expect(within(viewer).getByTestId("table-hidden-columns").textContent).toBe("+8 cols")
      expect(viewer.textContent).toContain("first 12 cols shown")
    })

    it("a csv whose bytes never arrive stays the plain row, never an empty card", async () => {
      mount(
        <TurnAttachments
          taskId="tk9zdy"
          turn={3}
          attachments={[{ name: "missing.csv", size: 10, mediaType: "text/plain" }]}
          archived={false}
        />,
      )
      await waitFor(() => expect(fetch).toHaveBeenCalled())
      expect(screen.queryByTestId("attachment-table")).toBeNull()
      expect(screen.getByRole("button", { name: "Preview missing.csv" }).textContent).toBe("missing.csv · text · 10 B")
    })
  })

  it("an archived turn names its attachments and says they were removed — no thumbnail, not silence", () => {
    mount(<TurnAttachments taskId="tk9zdy" turn={2} attachments={IMAGES} archived />)
    expect(screen.queryAllByRole("img")).toHaveLength(0)
    expect(screen.queryAllByRole("button")).toHaveLength(0)
    expect(screen.getByTestId("turn-attachments-removed").textContent).toBe(
      "cramped.png, spacing shot.png — removed when this task was archived",
    )
  })
})
