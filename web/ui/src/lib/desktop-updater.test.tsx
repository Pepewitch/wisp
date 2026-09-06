import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { DesktopBridge, DesktopUpdateStatus } from "@/lib/desktop-bridge"
import {
  DesktopUpdaterProvider,
  useDesktopUpdater,
} from "@/lib/desktop-updater"

function updateStatus(
  overrides: Partial<DesktopUpdateStatus> = {}
): DesktopUpdateStatus {
  return {
    channel: "alpha",
    configured: true,
    currentVersion: "0.4.0-alpha.9",
    latestVersion: null,
    phase: "idle",
    releaseNotes: null,
    publishedAt: null,
    checkedAt: null,
    downloadedBytes: 0,
    totalBytes: null,
    message: null,
    ...overrides,
  }
}

function updateBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    desktopUpdateStatus: vi.fn(async () => updateStatus()),
    checkDesktopUpdate: vi.fn(async () =>
      updateStatus({ phase: "up-to-date" })
    ),
    installDesktopUpdate: vi.fn(async (version: string) =>
      updateStatus({
        phase: "ready-to-relaunch",
        latestVersion: version,
      })
    ),
    relaunchDesktop: vi.fn(async () => undefined),
    onDesktopUpdateStatus: vi.fn(async () => () => undefined),
    ...overrides,
  } as DesktopBridge
}

function Consumer() {
  const updater = useDesktopUpdater()!
  return (
    <>
      <span>{updater.status?.phase ?? "loading"}</span>
      <button onClick={() => void updater.install("0.4.0-alpha.10")}>
        update
      </button>
    </>
  )
}

afterEach(() => {
  vi.useRealTimers()
  window.localStorage.clear()
})

describe("DesktopUpdaterProvider", () => {
  it("performs one configured launch check after the supplied delay", async () => {
    vi.useFakeTimers()
    const bridge = updateBridge()
    render(
      <DesktopUpdaterProvider bridge={bridge} launchCheckDelay={50}>
        <Consumer />
      </DesktopUpdaterProvider>
    )
    await act(async () => undefined)
    expect(bridge.checkDesktopUpdate).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(50))
    expect(bridge.checkDesktopUpdate).toHaveBeenCalledTimes(1)
  })

  it("respects the launch-check opt-out without disabling manual updates", async () => {
    vi.useFakeTimers()
    window.localStorage.setItem("wisp.desktop.check-updates-after-launch", "0")
    const bridge = updateBridge()
    render(
      <DesktopUpdaterProvider bridge={bridge} launchCheckDelay={0}>
        <Consumer />
      </DesktopUpdaterProvider>
    )
    await act(async () => vi.runAllTimersAsync())
    expect(bridge.checkDesktopUpdate).not.toHaveBeenCalled()
  })

  it("applies native status events", async () => {
    let emit: ((status: DesktopUpdateStatus) => void) | undefined
    const bridge = updateBridge({
      onDesktopUpdateStatus: vi.fn(async (listener) => {
        emit = listener
        return () => undefined
      }),
    })
    render(
      <DesktopUpdaterProvider bridge={bridge}>
        <Consumer />
      </DesktopUpdaterProvider>
    )
    await waitFor(() => expect(emit).toBeDefined())
    act(() => emit?.(updateStatus({ phase: "downloading" })))
    expect(screen.getByText("downloading")).toBeInTheDocument()
  })

  it("installs the confirmed version without owning relaunch arbitration", async () => {
    const bridge = updateBridge()
    render(
      <DesktopUpdaterProvider bridge={bridge}>
        <Consumer />
      </DesktopUpdaterProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "update" }))
    await waitFor(() =>
      expect(bridge.installDesktopUpdate).toHaveBeenCalledWith("0.4.0-alpha.10")
    )
    expect(bridge.relaunchDesktop).not.toHaveBeenCalled()
  })
})
