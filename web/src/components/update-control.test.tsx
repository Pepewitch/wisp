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

const HOUR = 3_600_000
const DAY = 24 * HOUR

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

describe("the browser control with nothing to install", () => {
  const current: UpdateStatus = { ...DAEMON_STATUS, latestVersion: null, state: "up-to-date" }

  it("is an icon, not a version label, and keeps the version in its popover", async () => {
    render(<WispUpdateControl status={current} updating={false} error={null} onUpdate={() => undefined} />)
    expect(screen.queryByText("0.4.0-alpha.8")).toBeNull()
    const trigger = screen.getByRole("button", { name: "Updates" })
    expect(trigger).toHaveAttribute("title", "Wisp daemon 0.4.0-alpha.8")
    expect(trigger.querySelector("span[aria-hidden]")).toBeNull()

    fireEvent.click(trigger)
    const popover = await screen.findByRole("region", { name: "Daemon version" })
    expect(popover).toHaveTextContent("Wisp daemon0.4.0-alpha.8")
  })

  it("says when the daemon last checked its release channel", async () => {
    const checkedAt = new Date(Date.now() - 3 * HOUR).toISOString()
    render(
      <WispUpdateControl
        status={{ ...current, checkedAt }}
        updating={false}
        error={null}
        onUpdate={() => undefined}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Updates" }))
    const popover = await screen.findByRole("region", { name: "Daemon version" })
    expect(popover).toHaveTextContent("Checked 3h ago")
  })

  it("dots a manual update and says why it cannot install it", async () => {
    render(
      <WispUpdateControl
        status={{ ...DAEMON_STATUS, canAutoUpdate: false }}
        updating={false}
        error={null}
        onUpdate={() => undefined}
      />
    )
    const trigger = screen.getByRole("button", { name: "Updates, 1 available" })
    expect(trigger.querySelector("span[aria-hidden]")).toHaveClass("bg-state-needs-input")
    fireEvent.click(trigger)
    const popover = await screen.findByRole("region", { name: "Daemon version" })
    expect(popover).toHaveTextContent("0.4.0-alpha.8 → 0.4.0-alpha.9")
    expect(popover).toHaveTextContent("this installation updates manually")
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

  it("says when each row last checked, and nothing while it checks", () => {
    const desktop = desktopUpdater({
      status: {
        ...DESKTOP_STATUS,
        latestVersion: null,
        phase: "up-to-date",
        checkedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
      },
    })
    renderCenter({
      desktop,
      daemonStatus: {
        ...DAEMON_STATUS,
        checkedAt: new Date(Date.now() - 2 * DAY).toISOString(),
      },
    })
    expect(
      screen.getByRole("region", { name: "Wisp Desktop update" })
    ).toHaveTextContent("Checked 2h ago")
    expect(
      screen.getByRole("region", { name: "Local daemon update" })
    ).toHaveTextContent("Checked 2d ago")
    expect(screen.getByText("Check Desktop automatically")).toBeInTheDocument()
  })

  it("hides a stale check time while that row is checking", () => {
    renderCenter({
      desktop: desktopUpdater({
        status: { ...DESKTOP_STATUS, latestVersion: null, phase: "checking" },
      }),
      checkingDaemon: true,
    })
    expect(screen.queryByText(/^Checked /)).toBeNull()
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
        status: { ...DESKTOP_STATUS, phase: "downloading" },
      }),
    })
    expect(
      screen.getByRole("button", { name: "Update Local daemon" })
    ).toBeDisabled()
    expect(screen.getByRole("button", { name: "Check now" })).toBeDisabled()
  })
})

describe("a daemon update nothing restarts", () => {
  const REASON =
    "Homebrew services does not run this daemon, so it will not restart on its own after an update"
  const INSTRUCTION =
    "Wisp 0.4.0-alpha.9 is installed. Restart the daemon to finish: stop the running daemon, then run `brew services start wisp` so future updates restart it on their own."
  const UNSUPERVISED: UpdateStatus = {
    ...DAEMON_STATUS,
    canAutoUpdate: false,
    canInstall: true,
    restartsAutomatically: false,
    message: REASON,
  }
  const RESTART_REQUIRED: UpdateStatus = {
    ...UNSUPERVISED,
    state: "restart-required",
    message: INSTRUCTION,
  }

  it("is offered in the browser, saying why it will not restart", () => {
    const onUpdate = vi.fn()
    render(
      <WispUpdateControl
        status={UNSUPERVISED}
        updating={false}
        error={null}
        onUpdate={onUpdate}
      />
    )
    const action = screen.getByRole("button", {
      name: "Update daemon 0.4.0-alpha.9",
    })
    expect(action).toHaveAttribute("title", REASON)
    fireEvent.click(action)
    expect(onUpdate).toHaveBeenCalledWith("0.4.0-alpha.9")
  })

  it("is not offered by a daemon that cannot install it", async () => {
    render(
      <WispUpdateControl
        status={{ ...UNSUPERVISED, canInstall: false, message: null }}
        updating={false}
        error={null}
        onUpdate={() => undefined}
      />
    )
    expect(screen.queryByRole("button", { name: /Update daemon/ })).toBeNull()
    fireEvent.click(
      screen.getByRole("button", { name: "Updates, 1 available" })
    )
    expect(
      await screen.findByRole("region", { name: "Daemon version" })
    ).toHaveTextContent("this installation updates manually")
  })

  it("once installed, the browser dots it and says how to finish instead of offering it again", async () => {
    render(
      <WispUpdateControl
        status={RESTART_REQUIRED}
        updating={false}
        error={null}
        onUpdate={() => undefined}
      />
    )
    expect(screen.queryByRole("button", { name: /Update daemon/ })).toBeNull()
    const trigger = screen.getByRole("button", {
      name: "Updates, 1 available",
    })
    expect(trigger.querySelector("span[aria-hidden]")).toHaveClass(
      "bg-state-needs-input"
    )
    fireEvent.click(trigger)
    expect(
      await screen.findByRole("region", { name: "Daemon version" })
    ).toHaveTextContent(INSTRUCTION)
  })

  it("is offered in the Local row, whose action says the restart is yours", () => {
    renderCenter({ daemonStatus: UNSUPERVISED })
    expect(
      screen.getByRole("region", { name: "Local daemon update" })
    ).toHaveTextContent(REASON)
    expect(
      screen.getByRole("button", { name: "Update Local daemon" })
    ).toHaveAttribute(
      "title",
      "Install Wisp daemon 0.4.0-alpha.9; restart the daemon yourself to finish"
    )
  })

  it("once installed, the Local row says how to finish and still counts it", () => {
    renderCenter({ daemonStatus: RESTART_REQUIRED })
    expect(
      screen.getByRole("button", { name: "Updates, 2 available" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("region", { name: "Local daemon update" })
    ).toHaveTextContent(INSTRUCTION)
    expect(
      screen.queryByRole("button", { name: "Update Local daemon" })
    ).toBeNull()
  })
})
