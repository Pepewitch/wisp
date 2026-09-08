import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { DesktopUpdateStatus } from "@/lib/desktop-bridge"
import type { DesktopUpdaterContextValue } from "@/lib/desktop-updater"
import type { UpdateStatus } from "@/lib/types"

import { UpdateCenter, WispUpdateControl } from "./update-control"

const DAEMON_STATUS: UpdateStatus = {
  currentVersion: "0.4.0-alpha.8",
  latestVersion: "0.4.0-alpha.9",
  currentApiProtocolVersion: 1,
  latestApiProtocolVersion: 1,
  state: "available",
  installMethod: "homebrew",
  canAutoUpdate: true,
  message: null,
  checkedAt: "2026-09-06T12:00:00Z",
}

const DESKTOP_STATUS: DesktopUpdateStatus = {
  channel: "alpha",
  configured: true,
  currentVersion: "0.4.0-alpha.8",
  latestVersion: "0.4.0-alpha.9",
  phase: "available",
  releaseNotes: "Signed updater support.",
  publishedAt: "2026-09-06T12:00:00Z",
  checkedAt: "2026-09-06T12:01:00Z",
  downloadedBytes: 0,
  totalBytes: 100,
  message: null,
}

function desktopUpdater(
  overrides: Partial<DesktopUpdaterContextValue> = {}
): DesktopUpdaterContextValue {
  return {
    status: DESKTOP_STATUS,
    pending: false,
    error: null,
    checkAfterLaunch: true,
    check: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined),
    relaunch: vi.fn(async () => undefined),
    setCheckAfterLaunch: vi.fn(),
    ...overrides,
  }
}

function renderCenter({
  desktop = desktopUpdater(),
  daemonStatus = DAEMON_STATUS,
  daemonError = null,
  daemonOperation = null,
  checkingDaemon = false,
  onCheck = () => undefined,
}: {
  desktop?: DesktopUpdaterContextValue
  daemonStatus?: UpdateStatus
  daemonError?: string | null
  daemonOperation?: {
    connectionId: string
    connectionName: string
    phase: "installing" | "restarting"
  } | null
  checkingDaemon?: boolean
  onCheck?: () => void
} = {}) {
  render(
    <UpdateCenter
      desktop={desktop}
      daemonStatus={daemonStatus}
      daemonError={daemonError}
      daemonOperation={daemonOperation}
      checkingDaemon={checkingDaemon}
      supportedApiProtocols={[1]}
      onUpdateDesktop={() => undefined}
      onUpdateDaemon={() => undefined}
      onCheck={onCheck}
    />
  )
  fireEvent.click(screen.getByRole("button", { name: /Updates/ }))
}

describe("browser daemon update control", () => {
  it("uses an explicitly daemon-scoped action", () => {
    const onUpdate = vi.fn()
    render(
      <WispUpdateControl
        status={DAEMON_STATUS}
        updating={false}
        error={null}
        onUpdate={onUpdate}
      />
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Update daemon 0.4.0-alpha.9" })
    )
    expect(onUpdate).toHaveBeenCalledWith("0.4.0-alpha.9")
  })

  it("names daemon progress and failures", () => {
    const { rerender } = render(
      <WispUpdateControl
        status={{ ...DAEMON_STATUS, state: "installing" }}
        updating
        error={null}
        onUpdate={() => undefined}
      />
    )
    expect(
      screen.getByRole("button", { name: "Updating daemon…" })
    ).toBeDisabled()

    rerender(
      <WispUpdateControl
        status={{ ...DAEMON_STATUS, state: "failed" }}
        updating={false}
        error="Synthetic failure"
        onUpdate={() => undefined}
      />
    )
    expect(
      screen.getByRole("button", { name: "Retry daemon update" })
    ).toHaveAttribute("title", "Synthetic failure")
  })
})

describe("the update trigger", () => {
  it("names an icon-only trigger with everything the dot cannot say", () => {
    renderCenter()

    // The trigger carries a glyph and a 6px dot, so its accessible name is the
    // whole readout — the count in words, for anyone not looking at it.
    expect(
      screen.getByRole("button", { name: "Updates, 2 available" })
    ).toBeInTheDocument()
  })

  it("says only Updates when nothing waits behind it", () => {
    renderCenter({
      desktop: desktopUpdater({
        status: { ...DESKTOP_STATUS, latestVersion: null, phase: "up-to-date" },
      }),
      daemonStatus: {
        ...DAEMON_STATUS,
        latestVersion: null,
        state: "up-to-date",
      },
    })

    expect(screen.getByRole("button", { name: "Updates" })).toBeInTheDocument()
  })

  it("carries a failure in the name as well as in the dot", () => {
    renderCenter({ daemonError: "Synthetic failure" })

    expect(
      screen.getByRole("button", { name: /Updates.*needs attention/ })
    ).toBeInTheDocument()
  })
})

describe("Desktop update center", () => {
  it("renders separately scoped Desktop and Local-daemon rows", () => {
    renderCenter()
    expect(
      screen.getByRole("button", { name: /Updates.*2/ })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("region", { name: "Wisp Desktop update" })
    ).toHaveTextContent("0.4.0-alpha.8 → 0.4.0-alpha.9")
    expect(
      screen.getByRole("button", { name: "Update Desktop and relaunch" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("region", { name: "Local daemon update" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Update Local daemon" })
    ).toBeInTheDocument()
  })

  it("does not count or offer an incompatible daemon update", () => {
    renderCenter({
      daemonStatus: {
        ...DAEMON_STATUS,
        latestVersion: "0.5.0",
        latestApiProtocolVersion: 2,
      },
    })
    expect(
      screen.getByRole("button", { name: /Updates.*1/ })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Update Local daemon" })
    ).toBeNull()
    expect(screen.getByText(/Update Desktop first/)).toBeInTheDocument()
  })

  it("does not offer a daemon update with unknown candidate protocol", () => {
    renderCenter({
      daemonStatus: {
        ...DAEMON_STATUS,
        latestApiProtocolVersion: null,
      },
    })
    expect(
      screen.getByRole("button", { name: /Updates.*1/ })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Update Local daemon" })
    ).toBeNull()
    expect(screen.getByText(/protocol unknown/)).toBeInTheDocument()
  })

  it("keeps daemon operation chrome bound to Local", () => {
    renderCenter({
      daemonOperation: {
        connectionId: "build",
        connectionName: "Build host",
        phase: "restarting",
      },
    })
    expect(screen.getByText("Restarting Local daemon…")).toBeInTheDocument()
    expect(screen.queryByText(/Build host daemon is restarting/)).toBeNull()
    expect(
      screen.getByRole("button", { name: "Update Desktop and relaunch" })
    ).toBeDisabled()
  })

  it("checks Desktop and Local through one explicit callback", () => {
    const onCheck = vi.fn()
    renderCenter({ onCheck })

    fireEvent.click(screen.getByRole("button", { name: "Check now" }))
    expect(onCheck).toHaveBeenCalledOnce()
  })

  it("names and blocks a Local daemon check in progress", () => {
    renderCenter({ checkingDaemon: true })

    expect(
      screen.getByRole("button", { name: "Checking Local daemon…" })
    ).toBeDisabled()
    expect(screen.getByRole("button", { name: "Check now" })).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Update Desktop and relaunch" })
    ).toBeDisabled()
  })

  it("shows bounded download progress and the relaunch recovery action", () => {
    const { rerender } = render(
      <UpdateCenter
        desktop={desktopUpdater({
          pending: true,
          status: {
            ...DESKTOP_STATUS,
            phase: "downloading",
            downloadedBytes: 25,
          },
        })}
        daemonStatus={DAEMON_STATUS}
        daemonError={null}
        daemonOperation={null}
        checkingDaemon={false}
        supportedApiProtocols={[1]}
        onUpdateDesktop={() => undefined}
        onUpdateDaemon={() => undefined}
        onCheck={() => undefined}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /Updates/ }))
    expect(
      screen.getByRole("progressbar", { name: "Desktop update download" })
    ).toHaveAttribute("aria-valuenow", "25")

    rerender(
      <UpdateCenter
        desktop={desktopUpdater({
          error: "Relaunch was interrupted",
          status: { ...DESKTOP_STATUS, phase: "ready-to-relaunch" },
        })}
        daemonStatus={DAEMON_STATUS}
        daemonError={null}
        daemonOperation={null}
        checkingDaemon={false}
        supportedApiProtocols={[1]}
        onUpdateDesktop={() => undefined}
        onUpdateDaemon={() => undefined}
        onCheck={() => undefined}
      />
    )
    expect(
      screen.getByRole("button", { name: "Relaunch Desktop" })
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Check now" })).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Update Local daemon" })
    ).toBeDisabled()
  })

  it("blocks daemon updates while a Desktop install is in flight", () => {
    renderCenter({
      desktop: desktopUpdater({
        pending: true,
        status: { ...DESKTOP_STATUS, phase: "downloading" },
      }),
    })
    expect(
      screen.getByRole("button", { name: "Update Local daemon" })
    ).toBeDisabled()
  })
})
