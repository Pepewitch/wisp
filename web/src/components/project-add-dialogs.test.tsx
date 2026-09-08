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
