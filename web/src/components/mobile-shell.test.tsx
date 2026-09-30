import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it } from "vitest"

import { TASKS } from "@/lib/fixtures"
import { uiIntentsFor } from "@/lib/ui-intents"
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

  it("shows the session's context size on that line", () => {
    mount({ task: { ...TASKS[0]!, context_tokens: 412_300 } })
    expect(screen.getByText("412.3k ctx")).toBeInTheDocument()
  })

  it("leaves the context size out when the harness has not reported one", () => {
    mount({ task: { ...TASKS[0]!, context_tokens: undefined } })
    expect(screen.queryByText(/ctx$/)).not.toBeInTheDocument()
  })

  it("puts Workflows beside the other task surfaces in equal-width thumb targets", () => {
    mount({ workflows: <div>Workflow content</div> })

    const tabs = screen.getAllByRole("button", { name: /^(Chat|Changes|Workflows|Terminal)$/ })
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Chat", "Changes", "Workflows", "Terminal"])
    for (const tab of tabs) expect(tab.className).toContain("flex-1")

    fireEvent.click(screen.getByRole("button", { name: "Workflows" }))
    expect(screen.getByText("Workflow content").parentElement).not.toHaveAttribute("aria-hidden", "true")
  })

  it("puts Autopilot level with Changes, and keeps the chat first", () => {
    mount({ autopilot: { label: "Autopilot", render: () => <div>Autopilot content</div> }, workflows: <div /> })

    const tabs = screen.getAllByRole("button", { name: /^(Chat|Autopilot|Changes|Workflows|Terminal)$/ })
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Chat", "Autopilot", "Changes", "Workflows", "Terminal"])
    for (const tab of tabs) expect(tab.className).toContain("flex-1")
    // the chat is still where a task opens
    expect(screen.getByText("Autopilot content").parentElement).toHaveAttribute("aria-hidden", "true")

    fireEvent.click(screen.getByRole("button", { name: "Autopilot" }))
    expect(screen.getByText("Autopilot content").parentElement).not.toHaveAttribute("aria-hidden", "true")
  })

  it("tells the Autopilot pane when another surface hides it, so its clock can stop", () => {
    const seen: boolean[] = []
    mount({ autopilot: { label: "Autopilot", render: (_showChat, hidden) => { seen.push(hidden); return <div>Autopilot content</div> } } })
    expect(seen.at(-1)).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Autopilot" }))
    expect(seen.at(-1)).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "Chat" }))
    expect(seen.at(-1)).toBe(true)
  })

  it("keeps the name Brief on a daemon with briefs and no autopilot", () => {
    mount({ autopilot: { label: "Brief", render: () => <div>Brief content</div> } })

    const tabs = screen.getAllByRole("button", { name: /^(Chat|Autopilot|Brief|Changes|Terminal)$/ })
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Chat", "Brief", "Changes", "Terminal"])
  })

  it("hands the Autopilot tab a way back to the chat", () => {
    mount({ autopilot: { label: "Autopilot", render: (showChat) => <button onClick={showChat}>Back to chat</button> }, conversation: <div>Transcript</div> })

    fireEvent.click(screen.getByRole("button", { name: "Autopilot" }))
    expect(screen.getByText("Transcript").parentElement).toHaveAttribute("aria-hidden", "true")
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }))
    expect(screen.getByText("Transcript").parentElement).not.toHaveAttribute("aria-hidden", "true")
  })

  it("brings the chat forward for a find from elsewhere, and asks again once it is on screen", async () => {
    mount({ autopilot: { label: "Autopilot", render: () => <div>Autopilot content</div> }, conversation: <div>Transcript</div> })
    const intents = uiIntentsFor("test-connection")

    fireEvent.click(screen.getByRole("button", { name: "Autopilot" }))
    const before = intents.findRequest()?.seq ?? 0
    act(() => intents.openFind("autosave", 4))

    await waitFor(() => expect(screen.getByText("Transcript").parentElement).not.toHaveAttribute("aria-hidden", "true"))
    // the first ask ran against a hidden transcript, where nothing can scroll
    await waitFor(() => expect(intents.findRequest()?.seq ?? 0).toBe(before + 2))
    expect(intents.findRequest()).toMatchObject({ query: "autosave", turn: 4 })
  })

  it("leaves other tabs alone when a find arrives", async () => {
    mount({ autopilot: { label: "Autopilot", render: () => <div>Autopilot content</div> }, conversation: <div>Transcript</div> })
    const intents = uiIntentsFor("test-connection")

    fireEvent.click(screen.getByRole("button", { name: "Changes" }))
    const before = intents.findRequest()?.seq ?? 0
    act(() => intents.openFind("autosave", 4))
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(screen.getByText("Transcript").parentElement).toHaveAttribute("aria-hidden", "true")
    expect(intents.findRequest()?.seq ?? 0).toBe(before + 1)
  })

  it("omits the Autopilot tab when the connected daemon has neither briefs nor autopilot", () => {
    mount()

    expect(screen.queryByRole("button", { name: "Autopilot" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Brief" })).not.toBeInTheDocument()
  })

  it("omits Workflows when the connected daemon does not support it", () => {
    mount()

    expect(screen.queryByRole("button", { name: "Workflows" })).not.toBeInTheDocument()
  })
})
