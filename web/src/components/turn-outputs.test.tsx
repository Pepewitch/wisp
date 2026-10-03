import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { OutputImage } from "../../../shared/api/outputs"
import { clearAssetCache } from "@/lib/asset-src"
import { createDesktopTransport } from "@/lib/desktop-transport"
import { completeAuth, sameOriginWebTransport } from "@/lib/web-transport"
import { runtimeWrapper } from "@/test/runtime"
import { TurnOutputs } from "./turn-outputs"

const image: OutputImage = { id: "a".repeat(64), name: "plot.png", size: 489, mediaType: "image/png", source: "native" }
const path = `/api/tasks/tfixture/outputs/2/${image.id}`

afterEach(() => { clearAssetCache(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it("Browser fetches output bytes with its bearer, previews inline, expands and downloads the same blob", async () => {
  completeAuth("synthetic-output-token")
  const fetch = vi.fn().mockResolvedValue(new Response("synthetic png", { headers: { "content-type": "image/png" } }))
  vi.stubGlobal("fetch", fetch)
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:output-preview")
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
  render(<TurnOutputs taskId="tfixture" turn={2} outputs={[image]} />, { wrapper: runtimeWrapper(sameOriginWebTransport) })
  await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", "blob:output-preview"))
  expect(fetch).toHaveBeenCalledWith(path, expect.objectContaining({ headers: { authorization: "Bearer synthetic-output-token" }, credentials: "omit", redirect: "error" }))
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.href).toBe("blob:output-preview")
    expect(this.download).toBe("plot.png")
  })
  fireEvent.click(screen.getByRole("button", { name: "Download" }))
  await waitFor(() => expect(click).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole("button", { name: "Expand plot.png" }))
  expect(screen.getByTestId("attachment-viewer").querySelector("img")).toHaveAttribute("src", "blob:output-preview")
  expect(fetch).toHaveBeenCalledTimes(1)
})

it("Desktop previews and downloads through its connection-qualified native proxy", () => {
  const transport = createDesktopTransport("http://127.0.0.1:45123/synthetic-capability", "remote-one", 7)
  render(<TurnOutputs taskId="tfixture" turn={2} outputs={[image]} />, { wrapper: runtimeWrapper(transport) })
  const qualified = `http://127.0.0.1:45123/synthetic-capability/connections/remote-one/7${path}`
  expect(screen.getByRole("img")).toHaveAttribute("src", qualified)
  expect(screen.getByRole("button", { name: "Download" })).toBeEnabled()
  fireEvent.click(screen.getByRole("button", { name: "Expand plot.png" }))
  expect(screen.getByTestId("attachment-viewer").querySelector("img")).toHaveAttribute("src", qualified)
})

it("reports a missing Browser image and disables actions instead of hiding its manifest", async () => {
  completeAuth("synthetic-output-token")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("gone", { status: 410 })))
  render(<TurnOutputs taskId="tfixture" turn={2} outputs={[image]} />, { wrapper: runtimeWrapper(sameOriginWebTransport) })
  await screen.findByText("Image unavailable")
  expect(screen.getByRole("button", { name: "Expand plot.png" })).toBeDisabled()
  expect(screen.queryByRole("button", { name: "Download" })).not.toBeInTheDocument()
})

it("old archives retain a named placeholder and never request removed image bytes", () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch)
  render(<TurnOutputs taskId="tfixture" turn={2} outputs={[image]} removed />, { wrapper: runtimeWrapper(sameOriginWebTransport) })
  expect(screen.getByText(/plot.png · removed when this task was archived/)).toBeInTheDocument()
  expect(screen.queryByRole("img")).not.toBeInTheDocument()
  expect(fetch).not.toHaveBeenCalled()
})
