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
      <button onClick={() => void updater.check().catch(() => undefined)}>
        check
      </button>
      <button onClick={() => updater.setCheckAfterLaunch(false)}>
        auto off
      </button>
    </>
  )
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

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
    await act(async () => vi.advanceTimersByTimeAsync(7 * HOUR))
    expect(bridge.checkDesktopUpdate).not.toHaveBeenCalled()
  })

  it("keeps automatic checks on the fixed channel and marks Check now explicit", async () => {
    vi.useFakeTimers()
    const bridge = updateBridge()
    render(
      <DesktopUpdaterProvider bridge={bridge} launchCheckDelay={50}>
        <Consumer />
      </DesktopUpdaterProvider>
    )
    await act(async () => vi.advanceTimersByTimeAsync(50))
    expect(bridge.checkDesktopUpdate).toHaveBeenLastCalledWith(false)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "check" }))
    })
    expect(bridge.checkDesktopUpdate).toHaveBeenLastCalledWith(true)
  })

  it("keeps discovering about every six hours while the app stays open", async () => {
    vi.useFakeTimers()
    const bridge = updateBridge()
    render(
      <DesktopUpdaterProvider bridge={bridge} launchCheckDelay={50}>
        <Consumer />
      </DesktopUpdaterProvider>
    )
    await act(async () => vi.advanceTimersByTimeAsync(50))
    expect(bridge.checkDesktopUpdate).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(6 * HOUR - 1))
    expect(bridge.checkDesktopUpdate).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(30 * MINUTE + 1))
    expect(bridge.checkDesktopUpdate).toHaveBeenCalledTimes(2)
    expect(bridge.checkDesktopUpdate).toHaveBeenLastCalledWith(false)
    await act(async () => vi.advanceTimersByTimeAsync(6.5 * HOUR))
    expect(bridge.checkDesktopUpdate).toHaveBeenCalledTimes(3)
    expect(bridge.installDesktopUpdate).not.toHaveBeenCalled()
  })

  it("keeps discovering after a failed automatic check", async () => {
    vi.useFakeTimers()
    const bridge = updateBridge({
      checkDesktopUpdate: vi.fn(async () => {
        throw new Error("the update host did not respond")
      }),
    })
    render(
      <DesktopUpdaterProvider
        bridge={bridge}
        launchCheckDelay={50}
        periodicCheckInterval={1_000}
      >
        <Consumer />
      </DesktopUpdaterProvider>
    )
    await act(async () => vi.advanceTimersByTimeAsync(50))
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(bridge.checkDesktopUpdate).toHaveBeenCalledTimes(2)
  })

  it.each([
    ["available", { phase: "available", latestVersion: "0.4.0-alpha.10" }],
    [
      "installed and awaiting relaunch",
      { phase: "ready-to-relaunch", latestVersion: "0.4.0-alpha.10" },
    ],
    [
      "a retryable failed install",
      { phase: "failed", latestVersion: "0.4.0-alpha.10" },
    ],
  ] as const)(
    "does not re-check periodically while an update is %s",
    async (_label, found) => {
      vi.useFakeTimers()
      const bridge = updateBridge({
        checkDesktopUpdate: vi.fn(async () => updateStatus(found)),
      })
      render(
        <DesktopUpdaterProvider
          bridge={bridge}
          launchCheckDelay={50}
          periodicCheckInterval={1_000}
        >
          <Consumer />
        </DesktopUpdaterProvider>
      )
      await act(async () => vi.advanceTimersByTimeAsync(50))
      await act(async () => vi.advanceTimersByTimeAsync(5_000))
      expect(bridge.checkDesktopUpdate).toHaveBeenCalledTimes(1)
    }
  )

  it("skips a periodic check while another check is still running", async () => {
    vi.useFakeTimers()
    let finish: (() => void) | undefined
    let calls = 0
    const bridge = updateBridge({
      checkDesktopUpdate: vi.fn(() => {
        calls += 1
        if (calls !== 2) return Promise.resolve(updateStatus({ phase: "up-to-date" }))
        return new Promise<DesktopUpdateStatus>((resolve) => {
          finish = () => resolve(updateStatus({ phase: "up-to-date" }))
        })
      }),
    })
    render(
      <DesktopUpdaterProvider
        bridge={bridge}
        launchCheckDelay={50}
        periodicCheckInterval={1_000}
      >
        <Consumer />
      </DesktopUpdaterProvider>
    )
    await act(async () => vi.advanceTimersByTimeAsync(500))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "check" }))
    })
    expect(bridge.checkDesktopUpdate).toHaveBeenCalledTimes(2)
    await act(async () => vi.advanceTimersByTimeAsync(600))
    expect(bridge.checkDesktopUpdate).toHaveBeenCalledTimes(2)
    await act(async () => finish?.())
    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(bridge.checkDesktopUpdate).toHaveBeenCalledTimes(3)
  })

  it("stops automatic checks when the setting is turned off or the app unmounts", async () => {
    vi.useFakeTimers()
    const bridge = updateBridge()
    const view = render(
      <DesktopUpdaterProvider
        bridge={bridge}
        launchCheckDelay={50}
        periodicCheckInterval={1_000}
      >
        <Consumer />
      </DesktopUpdaterProvider>
    )
    await act(async () => vi.advanceTimersByTimeAsync(1_050))
    expect(bridge.checkDesktopUpdate).toHaveBeenCalledTimes(2)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "auto off" }))
    })
    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(bridge.checkDesktopUpdate).toHaveBeenCalledTimes(2)
    view.unmount()
    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(bridge.checkDesktopUpdate).toHaveBeenCalledTimes(2)
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
