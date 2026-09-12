import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it } from "vitest"

import { TASKS } from "@/lib/fixtures"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { MobileShell } from "./mobile-shell"

function mount(props: Partial<Parameters<typeof MobileShell>[0]> = {}): ReactNode {
  render(
    <MobileShell
      task={TASKS[0]!}
      sidebar={() => null}
      conversation={<div />}
      changes={<div />}
      terminal={<div />}
      composer={<div />}
      {...props}
    />,
    { wrapper: runtimeWrapper(fakeDaemonTransport()) },
  )
  return null
}

/** The app band, the one part of the header that is not about the task. */
function appBand(): HTMLElement | null {
  return document.querySelector("[data-tauri-drag-region]")
}

describe("the mobile header", () => {
  it("gives the browser no app band, because it has nothing to put in one", () => {
    mount()

    expect(appBand()).toBeNull()
  })

  it("reserves the traffic lights and a drag region in Wisp Desktop", () => {
    mount({
      desktop: true,
      connectionSwitcher: <span>Local</span>,
      zoomControl: <span>Zoom</span>,
    })

    const band = appBand()
    // the packaged window is titleBarStyle: Overlay, so the lights float over
    // the top left and a hidden title bar leaves nothing to drag by
    expect(band).not.toBeNull()
    expect(band!.className).toContain("pl-20")
    // the mark yields the corner to the lights and the connection menu, the
    // same bar the pointer shell drops it from
    expect(screen.queryByRole("img", { name: "Wisp" })).toBeNull()
    expect(screen.getByText("Local")).toBeInTheDocument()
    expect(screen.getByText("Zoom")).toBeInTheDocument()
  })

  it("keeps the task band to a title over ONE metadata line", () => {
    const task = { ...TASKS[0]!, harness: "claude", model: "claude-opus-5" }
    mount({ task })

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(task.title)
    expect(screen.getByText("claude")).toBeInTheDocument()
    expect(screen.getByText("claude-opus-5")).toBeInTheDocument()
  })

  it("splits the tab strip into equal thirds, each a full-height thumb target", () => {
    mount()

    const tabs = screen.getAllByRole("button", { name: /^(Chat|Changes|Terminal)$/ })
    expect(tabs).toHaveLength(3)
    for (const tab of tabs) expect(tab.className).toContain("flex-1")
  })
})
