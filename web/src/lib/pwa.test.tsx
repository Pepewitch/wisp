import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { initPwa } from "./pwa"
import { PwaInstall } from "@/components/pwa-install"

let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); dispose = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks() })

function browser({ secure = true, ios = false, standalone = false } = {}) {
  vi.stubGlobal("isSecureContext", secure)
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: standalone, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ios ? "iPhone" : "Chrome")
  dispose = initPwa()
}

describe("browser installation", () => {
  it("is absent in Desktop, whose entry point never initializes PWA", () => {
    render(<PwaInstall />)
    expect(screen.queryByText(/home screen/i)).not.toBeInTheDocument()
  })
  it("gives HTTPS guidance on a remote HTTP origin", () => {
    browser({ secure: false })
    render(<PwaInstall />)
    expect(screen.getByText(/Tailscale HTTPS address/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Install Wisp" })).not.toBeInTheDocument()
  })
  it("explains the Safari home-screen flow", () => {
    browser({ ios: true })
    render(<PwaInstall />)
    expect(screen.getByText(/In Safari, open Share/)).toBeInTheDocument()
  })
  it("uses each browser prompt once and reflects completed installation", async () => {
    browser()
    render(<PwaInstall />)
    const prompt = vi.fn().mockResolvedValue({ outcome: "dismissed" })
    const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), { prompt })
    act(() => { window.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(true)
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Install Wisp" })) })
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("button", { name: "Install Wisp" })).not.toBeInTheDocument()
    act(() => { window.dispatchEvent(new Event("appinstalled")) })
    expect(screen.getByText(/Wisp is running as an app/)).toBeInTheDocument()
  })
  it("does not offer reinstallation in a standalone window", () => {
    browser({ standalone: true })
    render(<PwaInstall />)
    expect(screen.getByText(/Wisp is running as an app/)).toBeInTheDocument()
  })
});
