import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { UpdateStatus } from "@/lib/types"

import { WispUpdateControl } from "./update-control"

const STATUS: UpdateStatus = {
  currentVersion: "0.4.0-alpha.6",
  latestVersion: null,
  state: "up-to-date",
  installMethod: "homebrew",
  canAutoUpdate: true,
  message: null,
  checkedAt: "2026-09-05T12:00:00.000Z",
}

describe("WispUpdateControl", () => {
  it("shows the daemon version when Wisp is current", () => {
    render(<WispUpdateControl status={STATUS} updating={false} error={null} onUpdate={() => {}} />)
    expect(screen.getByText("0.4.0-alpha.6")).toHaveAttribute("title", "Wisp 0.4.0-alpha.6")
  })

  it("becomes an update button for an automatic update", () => {
    const onUpdate = vi.fn()
    render(
      <WispUpdateControl
        status={{ ...STATUS, state: "available", latestVersion: "0.4.0-alpha.7" }}
        updating={false}
        error={null}
        onUpdate={onUpdate}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Update 0.4.0-alpha.7" }))
    expect(onUpdate).toHaveBeenCalledWith("0.4.0-alpha.7")
  })

  it("keeps an unsupported update informational", () => {
    render(
      <WispUpdateControl
        status={{
          ...STATUS,
          state: "available",
          latestVersion: "0.4.0-alpha.7",
          installMethod: "unsupported",
          canAutoUpdate: false,
          message: "source builds update manually",
        }}
        updating={false}
        error={null}
        onUpdate={() => {}}
      />,
    )
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(screen.getByText("0.4.0-alpha.6")).toHaveAttribute("title", "source builds update manually")
  })

  it("shows progress and offers a retry after failure", () => {
    const available = { ...STATUS, latestVersion: "0.4.0-alpha.7" }
    const { rerender } = render(
      <WispUpdateControl
        status={{ ...available, state: "installing" }}
        updating
        error={null}
        onUpdate={() => {}}
      />,
    )
    expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled()

    rerender(
      <WispUpdateControl
        status={{ ...available, state: "failed", message: "update failed: tap unavailable" }}
        updating={false}
        error={null}
        onUpdate={() => {}}
      />,
    )
    expect(screen.getByRole("button", { name: "Retry update" })).toHaveAttribute(
      "title",
      "update failed: tap unavailable",
    )
  })

  it("does not stay disabled after restart polling times out", () => {
    render(
      <WispUpdateControl
        status={{ ...STATUS, state: "restarting", latestVersion: "0.4.0-alpha.7" }}
        updating={false}
        error="Wisp 0.4.0-alpha.7 did not start within 300 seconds"
        onUpdate={() => {}}
      />,
    )
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(screen.getByText("Update failed")).toHaveAttribute(
      "title",
      "Wisp 0.4.0-alpha.7 did not start within 300 seconds",
    )
  })
})
