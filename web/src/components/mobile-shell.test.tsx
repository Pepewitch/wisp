import { QueryClient } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { TASKS } from "@/lib/fixtures"
import { createConnectionQueryKeys } from "@/lib/query"
import type { ApiTask, PullRequestStatus } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { MobileShell } from "./mobile-shell"

type Props = Parameters<typeof MobileShell>[0]

function mount(props: Partial<Props> = {}, tasks?: ApiTask[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (tasks) client.setQueryData(createConnectionQueryKeys("test-connection").tasksList(false), tasks)
  const all: Props = {
    task: TASKS[0]!,
    sidebar: () => null,
    conversation: <div>Transcript</div>,
    changes: <div>Diff</div>,
    terminal: <div>Shell</div>,
    composer: <div>Composer</div>,
    ...props,
  }
  const view = render(<MobileShell {...all} />, { wrapper: runtimeWrapper(fakeDaemonTransport(), client) })
  return { ...view, client, rerender: (next: Partial<Props>) => view.rerender(<MobileShell {...all} {...next} />) }
}

const PR = {
  kind: "found",
  provider: "github",
  others: 0,
  pullRequest: {
    number: 318,
    url: "https://github.com/acme/widgets/pull/318",
    title: "Paginate the library view",
    lifecycle: "open",
    queuedToMerge: false,
    checks: "pending",
    review: "required",
    mergeState: "blocked",
    updatedAt: "2026-10-26T12:00:00Z",
  },
} satisfies PullRequestStatus

/** The app band, the one part of the header that is not about the task. */
function appBand(): HTMLElement | null {
  return document.querySelector("[data-tauri-drag-region]")
}

/** The line under the title. */
function statusLine(): HTMLElement {
  return screen.getByRole("heading", { level: 1 }).nextElementSibling as HTMLElement
}

/** Shown: its pane is not hidden. */
function shown(text: string): boolean {
  return screen.getByText(text).closest("[aria-hidden]")?.getAttribute("aria-hidden") !== "true"
}

async function openSheet(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Task sheet" }))
  return await screen.findByRole("dialog")
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
    expect(screen.queryByRole("img", { name: "Wisp" })).toBeNull()
    expect(screen.getByText("Local")).toBeInTheDocument()
    expect(screen.getByText("Zoom")).toBeInTheDocument()
  })

  it("is a title over ONE status line: the state, then the pull request and its CI", () => {
    mount({ task: { ...TASKS[0]!, state: "running" }, pullRequest: PR })

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(TASKS[0]!.title)
    // the separators are spaced by the line's gap, not by text
    expect(statusLine().textContent).toBe("Running·#318 open · CI pending")
  })

  it("drops CI from the line once the pull request has landed", () => {
    mount({ pullRequest: { ...PR, pullRequest: { ...PR.pullRequest, lifecycle: "merged", checks: "passed" } } })

    expect(statusLine()).toHaveTextContent("#318 merged")
    expect(statusLine()).not.toHaveTextContent("CI")
  })

  it("says Local on the line for a task in the project checkout", () => {
    mount({ task: { ...TASKS[0]!, mode: "local" } })
    expect(statusLine()).toHaveTextContent("Local")
  })

  it("has no tab strip: the conversation fills the screen and the tools wait in the sheet", () => {
    mount({ workflows: <div /> })

    expect(screen.queryByRole("tablist")).toBeNull()
    expect(screen.queryByRole("button", { name: /^(Chat|Changes|Terminal|Workflows)$/ })).toBeNull()
    expect(shown("Transcript")).toBe(true)
    expect(screen.getByText("Composer")).toBeInTheDocument()
  })

  it("makes every header control a 44px thumb target", () => {
    mount()
    for (const name of ["Open tasks", "Task sheet"]) expect(screen.getByRole("button", { name }).className).toContain("size-11")
    // the two-line title block is one target, at least as tall
    expect(screen.getByRole("button", { name: "Open the task sheet" }).parentElement!.className).toContain("min-h-11")
  })
})

describe("the task sheet", () => {
  it("opens from the task button, and from the title", async () => {
    mount()
    await openSheet()
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    fireEvent.click(screen.getByRole("button", { name: "Open the task sheet" }))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
  })

  it("holds the facts the header used to, the card's rows, the tools and the verbs", async () => {
    mount({ task: { ...TASKS[0]!, harness: "claude", model: "claude-opus-5", context_tokens: 412_300 }, pullRequest: PR, autopilot: () => <div />, workflows: <div /> })
    const sheet = within(await openSheet())

    expect(sheet.getByText(`${TASKS[0]!.id} · claude · claude-opus-5 · high effort`)).toBeInTheDocument()
    // the summary card's own rows, the context among them
    expect(sheet.getByTestId("task-summary")).toHaveTextContent("Pull request")
    expect(sheet.getByText("412.3k")).toBeInTheDocument()
    const tools = sheet.getAllByRole("button", { name: /^(Terminal|Changes|Autopilot|Subtasks|Workflows)/ })
    expect(tools.map((tool) => tool.textContent)).toEqual(["Terminal", "Changes", "Autopilot", "Workflows"])
    for (const tool of tools) expect(tool.className).toContain("min-h-11")
    for (const verb of ["Find in task", "Rename", "Archive"]) expect(sheet.getByRole("button", { name: verb })).toBeInTheDocument()
  })

  it("leaves out the tools this daemon does not have", async () => {
    mount()
    const sheet = within(await openSheet())

    expect(sheet.queryByRole("button", { name: /^Autopilot/ })).toBeNull()
    expect(sheet.queryByRole("button", { name: /^Workflows/ })).toBeNull()
  })

  it("closes for its verbs, so a dialog never opens under it", async () => {
    mount()
    const sheet = within(await openSheet())
    fireEvent.click(sheet.getByRole("button", { name: "Rename" }))

    expect(await screen.findByLabelText("Task name")).toHaveValue(TASKS[0]!.title)
    await waitFor(() => expect(screen.queryByTestId("task-summary")).toBeNull())
  })

  it("does not archive an archived task again", async () => {
    mount({ task: { ...TASKS[0]!, archived: true } })
    const sheet = within(await openSheet())
    expect(sheet.getByRole("button", { name: "Archive" })).toBeDisabled()
  })

  it("brings the chat back before it finds", async () => {
    mount({ autopilot: () => <div>Autopilot content</div> })
    const intents = uiIntentsFor("test-connection")
    fireEvent.click(within(await openSheet()).getByRole("button", { name: /^Autopilot/ }))
    expect(shown("Autopilot content")).toBe(true)

    const before = intents.findRequest()?.seq ?? 0
    fireEvent.click(within(await openSheet()).getByRole("button", { name: "Find in task" }))
    expect(shown("Transcript")).toBe(true)
    await waitFor(() => expect(intents.findRequest()?.seq ?? 0).toBe(before + 1))
  })
})

describe("a tool on the phone", () => {
  it("opens full screen with a way back to the chat", async () => {
    mount()
    fireEvent.click(within(await openSheet()).getByRole("button", { name: /^Changes/ }))

    expect(shown("Diff")).toBe(true)
    expect(shown("Transcript")).toBe(false)
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    // the composer stays: you can ask about what you are reading
    expect(screen.getByText("Composer")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Chat" }))
    expect(shown("Transcript")).toBe(true)
    expect(screen.queryByRole("button", { name: "Chat" })).toBeNull()
  })

  it("hides the composer on the Terminal, where the shell is the input", async () => {
    mount()
    fireEvent.click(within(await openSheet()).getByRole("button", { name: /^Terminal/ }))

    expect(shown("Shell")).toBe(true)
    expect(screen.queryByText("Composer")).toBeNull()
    expect(screen.getByText("Terminal", { selector: "span" })).toBeInTheDocument()
  })

  it("tells the Autopilot pane when it is hidden, so its clock can stop, and hands it a way back", async () => {
    const seen: boolean[] = []
    mount({ autopilot: (showChat, hidden) => { seen.push(hidden); return <button onClick={showChat}>Back to chat</button> } })
    expect(seen.at(-1)).toBe(true)

    fireEvent.click(within(await openSheet()).getByRole("button", { name: /^Autopilot/ }))
    expect(seen.at(-1)).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }))
    expect(seen.at(-1)).toBe(true)
    expect(shown("Transcript")).toBe(true)
  })

  it("gives the chat back for a find from elsewhere, and asks again once it is on screen", async () => {
    mount({ autopilot: () => <div>Autopilot content</div> })
    const intents = uiIntentsFor("test-connection")
    fireEvent.click(within(await openSheet()).getByRole("button", { name: /^Autopilot/ }))

    const before = intents.findRequest()?.seq ?? 0
    act(() => intents.openFind("autosave", 4))

    await waitFor(() => expect(shown("Transcript")).toBe(true))
    // the first ask ran against a hidden transcript, where nothing can scroll
    await waitFor(() => expect(intents.findRequest()?.seq ?? 0).toBe(before + 2))
    expect(intents.findRequest()).toMatchObject({ query: "autosave", turn: 4 })
  })

  it("returns to the chat when the task changes", async () => {
    const view = mount()
    fireEvent.click(within(await openSheet()).getByRole("button", { name: /^Changes/ }))
    view.rerender({ task: TASKS[2]! })
    expect(shown("Transcript")).toBe(true)
  })
})

describe("a question waiting on the phone", () => {
  const waiting = { ...TASKS[1]!, state: "needs-input", pending_question_id: "q-1" } as ApiTask

  it("says so in amber on the status line", () => {
    mount({ task: waiting })

    const words = within(statusLine()).getByText("Waiting for you · 1 question")
    expect(words.className).toContain("text-state-needs-input")
  })

  it("goes to the question when the title block is tapped, from a tool too", async () => {
    mount({ task: waiting })
    const intents = uiIntentsFor("test-connection")
    fireEvent.click(within(await openSheet()).getByRole("button", { name: /^Changes/ }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    const before = intents.streamFocusRequests()
    fireEvent.click(screen.getByRole("button", { name: "Show the question" }))
    expect(shown("Transcript")).toBe(true)
    await waitFor(() => expect(intents.streamFocusRequests()).toBe(before + 1))
    // nothing opened on its own way: the sheet stays one tap away
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})

describe("subtasks on a phone", () => {
  const parent = TASKS[0]!
  const child = { ...TASKS[1]!, parent_task_id: parent.id, subtask_kind: "explore" as const }

  it("offers the Subtasks tool only while the task has subtasks", async () => {
    mount({ subtasks: <div>Subtask list</div> }, [parent])
    expect(within(await openSheet()).queryByRole("button", { name: /^Subtasks/ })).toBeNull()
  })

  it("opens the subtask list from the sheet", async () => {
    mount({ subtasks: <div>Subtask list</div> }, [parent, child])
    fireEvent.click(within(await openSheet()).getByRole("button", { name: /^Subtasks/ }))
    expect(shown("Subtask list")).toBe(true)
  })

  it("names a subtask's parent in the sheet, and opening it selects the parent", async () => {
    mount({ task: { ...child, subtask_kind: "review" } }, [parent, child])
    const sheet = within(await openSheet())
    const seen = uiIntentsFor("test-connection").taskFocusRequest()?.seq ?? 0

    expect(sheet.getByText("review subtask of")).toBeInTheDocument()
    fireEvent.click(sheet.getByRole("button", { name: parent.title }))
    expect(uiIntentsFor("test-connection").taskFocusRequest()).toEqual({ taskId: parent.id, seq: seen + 1 })
  })

  it("falls back to the chat when the last subtask goes away under the Subtasks tool", async () => {
    const view = mount({ subtasks: <div>Subtask list</div> }, [parent, child])
    fireEvent.click(within(await openSheet()).getByRole("button", { name: /^Subtasks/ }))
    expect(shown("Subtask list")).toBe(true)
    // archived from another client: the live list no longer has it
    act(() => view.client.setQueryData(createConnectionQueryKeys("test-connection").tasksList(false), [parent]))
    await waitFor(() => expect(shown("Transcript")).toBe(true))
    expect(screen.queryByRole("button", { name: "Chat" })).toBeNull()
  })
})
