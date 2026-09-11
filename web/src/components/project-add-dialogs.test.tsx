import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { AddProjectDialog } from "./project-add-dialogs"

describe("remote project path", () => {
  it("refuses a relative path before calling the remote daemon", () => {
    const onSubmit = vi.fn(async () => undefined)
    render(
      <AddProjectDialog
        open
        connectionName="Build host"
        pending={false}
        error={null}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />
    )

    fireEvent.change(screen.getByLabelText("Absolute path on Build host"), {
      target: { value: "relative/project" },
    })

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter an absolute path beginning with /"
    )
    expect(screen.getByRole("button", { name: "Add project" })).toBeDisabled()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe("the browser registers a project too", () => {
  it("names the daemon's filesystem rather than the remote sentence", () => {
    render(
      <AddProjectDialog
        open
        connectionName="the daemon host"
        hint="This path is resolved by the Wisp daemon serving this page, not by your browser."
        pending={false}
        error={null}
        onClose={() => undefined}
        onSubmit={async () => undefined}
      />
    )

    expect(
      screen.getByLabelText("Absolute path on the daemon host")
    ).toBeInTheDocument()
    // "not on this computer" would be a lie: the daemon serving the page very
    // often IS this computer
    expect(
      screen.getByText(/resolved by the Wisp daemon serving this page/)
    ).toBeInTheDocument()
  })

  it("sends the typed path once it is absolute", async () => {
    const onSubmit = vi.fn(async () => undefined)
    render(
      <AddProjectDialog
        open
        connectionName="the daemon host"
        pending={false}
        error={null}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />
    )

    fireEvent.change(screen.getByLabelText("Absolute path on the daemon host"), {
      target: { value: "  /srv/projects/wisp  " },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add project" }))

    expect(onSubmit).toHaveBeenCalledWith("/srv/projects/wisp")
  })
})
