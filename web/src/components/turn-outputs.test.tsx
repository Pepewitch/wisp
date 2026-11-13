import { QueryClient } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { OutputImage } from "../../../shared/api/outputs"
import { clearAssetCache } from "@/lib/asset-src"
import { createDesktopTransport } from "@/lib/desktop-transport"
import { createConnectionQueryKeys } from "@/lib/query"
import { connectEventsBridge, type SseLike } from "@/lib/sse"
import { LOCAL_CONNECTION_ID } from "@/lib/transport"
import type { WispEvent } from "@/lib/types"
import { completeAuth, sameOriginWebTransport } from "@/lib/web-transport"
import { runtimeWrapper } from "@/test/runtime"
import { OutputImagePreview, TurnOutputs } from "./turn-outputs"

const download = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock("@/lib/output-download", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/output-download")>()
  return { ...original, saveOutputImage: (...args: Parameters<typeof original.saveOutputImage>) =>
    download.save.getMockImplementation() ? download.save(...args) : original.saveOutputImage(...args) }
})

const image: OutputImage = { id: "a".repeat(64), name: "plot.png", size: 489, mediaType: "image/png", source: "native" }
const path = `/api/tasks/tfixture/outputs/2/${image.id}`

afterEach(() => { clearAssetCache(); localStorage.clear(); download.save.mockReset(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it("preserves the native Save panel's string failure reason so the user can recover", async () => {
  const reason = "Could not save the file. Check available space and choose a writable folder, then retry."
  download.save.mockRejectedValue(reason)
  render(<OutputImagePreview image={image} src="blob:output-preview" />, { wrapper: runtimeWrapper(sameOriginWebTransport) })
  fireEvent.click(screen.getByRole("button", { name: "Download" }))
  expect(await screen.findByRole("alert")).toHaveTextContent(reason)
})

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

/**
 * A running task announces every state change. Each one used to revoke the
 * open task's blobs, so every image on screen refetched and collapsed while it
 * did; an output's path is its content hash, so none of them can have changed.
 */
it("Browser keeps an image on screen, without refetching, through task and message events", async () => {
  completeAuth("synthetic-output-token")
  const fetch = vi.fn().mockImplementation(async () => new Response("synthetic png", { headers: { "content-type": "image/png" } }))
  vi.stubGlobal("fetch", fetch)
  let blobs = 0
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:output-${++blobs}`)
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
  const stream: SseLike = { onmessage: null, onopen: null, onerror: null, readyState: 1, addEventListener() {}, close() {} }
  const close = connectEventsBridge({
    client: new QueryClient(),
    qk: createConnectionQueryKeys(LOCAL_CONNECTION_ID),
    transport: { ensureReady: () => Promise.resolve(), openEventStream: () => stream },
    getSelectedId: () => "tfixture",
    tasksDebounceMs: 0, statusDebounceMs: 0, detailDebounceMs: 0,
  })
  render(<TurnOutputs taskId="tfixture" turn={2} outputs={[image]} />, { wrapper: runtimeWrapper(sameOriginWebTransport) })
  await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", "blob:output-1"))

  const emit = (event: WispEvent) => act(() => stream.onmessage?.({ data: JSON.stringify(event) }))
  emit({ type: "task", taskId: "tfixture", state: "running", stateDetail: null, seq: 2 })
  emit({ type: "message", taskId: "tfixture", messageId: "m1" })
  emit({ type: "turn", taskId: "tfixture", n: 3, status: "running" })

  expect(screen.getByRole("img")).toHaveAttribute("src", "blob:output-1")
  expect(fetch).toHaveBeenCalledTimes(1)
  close()
})

it("keeps a box for an image whose bytes have not arrived", () => {
  render(<OutputImagePreview image={image} src={null} ratio={2} />, { wrapper: runtimeWrapper(sameOriginWebTransport) })
  expect(screen.getByRole("img")).toHaveStyle({ aspectRatio: "2" })
})

it("old archives retain a named placeholder and never request removed image bytes", () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch)
  render(<TurnOutputs taskId="tfixture" turn={2} outputs={[image]} removed />, { wrapper: runtimeWrapper(sameOriginWebTransport) })
  expect(screen.getByText(/plot.png · removed when this task was archived/)).toBeInTheDocument()
  expect(screen.queryByRole("img")).not.toBeInTheDocument()
  expect(fetch).not.toHaveBeenCalled()
})
