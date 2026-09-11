import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { DaemonTransport } from "@/lib/transport"
import type { HarnessInfo, RepoInfo } from "@/lib/types"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { CreateTaskDialog } from "./create-task-dialog"

const repo: RepoInfo = {
  path: "/repo",
  name: "repo",
  exists: true,
  setupScript: "",
  archiveScript: "",
  copyFiles: [],
  baseBranch: "",
  configured: true,
}

const harness: HarnessInfo = {
  name: "droid",
  hasModel: true,
  hasEffort: true,
  hasImage: false,
  defaults: { model: "kimi-k3" },
  models: {
    list: ["kimi-k3"],
    defaultModel: "kimi-k3",
    probedAt: "2026-09-01T00:00:00.000Z",
  },
}

/**
 * A1d moved base64 encoding from paste to submit, which opened a window the
 * dialog did not close: `createTask.isPending` only goes true once the encode
 * finishes, so during a 50 MB video's encode the Create button stayed live and
 * ⌘↵ still fired. Two clicks meant two tasks.
 */
describe("create task dialog submission", () => {
  async function mountWithRequest(request: ReturnType<typeof vi.fn>) {
    render(
      <CreateTaskDialog
        open
        onOpenChange={() => {}}
        initialRepoPath="/repo"
        repos={[repo]}
        harnesses={[harness]}
        harnessesError={null}
        onCreated={() => {}}
      />,
      {
        wrapper: runtimeWrapper(
          fakeDaemonTransport("test-connection", { request: request as unknown as DaemonTransport["request"] }),
        ),
      },
    )
    fireEvent.change(screen.getByPlaceholderText("What do you want to work on?"), {
      target: { value: "reconcile the rows" },
    })
    return await screen.findByRole("button", { name: "Create" })
  }

  it("a second click or ⌘↵ while one create is in flight cannot make a second task", async () => {
    // a create that never settles: the whole window under test is the one
    // between the first click and the daemon answering
    let finish!: (task: { id: string }) => void
    const request = vi.fn(() => new Promise((resolve) => { finish = resolve }))
    const create = await mountWithRequest(request)

    fireEvent.click(create)
    // the second click lands in the same tick, while the encode is still a
    // pending microtask and nothing has reached the daemon yet
    fireEvent.click(create)
    // …and the keyboard path bypasses the button's disabled state entirely
    fireEvent.keyDown(document, { key: "Enter", metaKey: true })

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    expect(create).toBeDisabled()

    // the create is still in flight, so neither route may start another
    fireEvent.click(create)
    fireEvent.keyDown(document, { key: "Enter", metaKey: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(request).toHaveBeenCalledTimes(1)
    finish({ id: "tk9zdy" })
  })

  it("a refused create is retryable: the guard releases on failure too", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("no such project")).mockResolvedValue({ id: "tk9zdy" })
    const create = await mountWithRequest(request)

    fireEvent.click(create)
    await waitFor(() => expect(create).not.toBeDisabled())
    fireEvent.click(create)
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  })

  /**
   * A drop is the third way a file arrives, and it must not be a side door
   * around the attachment contract: the create carries it the same way a
   * pasted or picked file would.
   */
  it("a dropped file becomes a pending row and rides with the create", async () => {
    const request = vi.fn().mockResolvedValue({ id: "tk9zdy" })
    const create = await mountWithRequest(request)
    // the fixture harness has no image capability, so the drop is a text file:
    // pdf, text and video reach every harness by path (A1d)
    const CSV = new TextEncoder().encode("id,name\n1,a\n2,b\n")
    const csvFile = new File([CSV], "orders.csv", { type: "text/csv" })

    fireEvent.drop(screen.getByTestId("create-prompt-field"), {
      dataTransfer: { types: ["Files"], files: [csvFile] },
    })
    await waitFor(() => expect(screen.getByTestId("pending-attachment")).toBeTruthy())
    expect(screen.getByTestId("pending-attachments").textContent).toContain("orders.csv")

    fireEvent.click(create)
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    expect(request).toHaveBeenCalledWith(
      "/api/tasks",
      expect.objectContaining({
        body: expect.objectContaining({
          attachments: [{ name: "orders.csv", dataBase64: expect.any(String) }],
        }),
      }),
    )
  })

  it("a non-file drag is not answered", async () => {
    await mountWithRequest(vi.fn())
    const field = screen.getByTestId("create-prompt-field")
    fireEvent.dragEnter(field, { dataTransfer: { types: ["text/plain"] } })
    expect(field.className).not.toContain("ring-2")
    fireEvent.drop(field, { dataTransfer: { types: ["text/plain"], files: [] } })
    expect(screen.queryByTestId("pending-attachments")).toBeNull()
  })
})

describe("create task dialog layout", () => {
  function mountLayout() {
    render(
      <CreateTaskDialog
        open
        onOpenChange={() => {}}
        initialRepoPath="/repo"
        repos={[repo]}
        harnesses={[harness]}
        harnessesError={null}
        onCreated={() => {}}
      />,
      { wrapper: runtimeWrapper(fakeDaemonTransport()) },
    )
  }

  it("stacks the bar into columns on a narrow modal and one line on a wide one", async () => {
    mountLayout()

    // The switch keys off the modal's own width (@container). Narrow: the
    // choices that shape the task stack in a left column, with Create pinned
    // to the bottom right. Wide: both clusters flatten into a single line.
    const create = await screen.findByRole("button", { name: "Create" })
    const rightCluster = create.parentElement as HTMLElement
    expect(rightCluster).toHaveClass("ml-auto", "flex", "justify-end")
    const bar = rightCluster.parentElement as HTMLElement
    expect(bar).toHaveClass("flex", "@min-[640px]:flex-wrap")
    expect(bar.firstElementChild).toHaveClass("min-w-0", "grow", "flex-col", "@min-[640px]:flex-row")
  })

  it("keeps project, where it runs and its base on the scoping row above the prompt", async () => {
    mountLayout()

    // Project and where the task runs are the two decisions that scope the
    // prompt, so they share the row above it. The path is the project
    // trigger's own parenthetical rather than a column of its own, which is
    // what freed the width for the mode and base pickers.
    const project = await screen.findByRole("button", { name: "Project" })
    expect(project).toHaveTextContent("repo")
    expect(project).toHaveTextContent("(/repo)")
    const row = project.parentElement as HTMLElement
    expect(row).toContainElement(screen.getByRole("button", { name: "Worktree" }))
    expect(row).toContainElement(screen.getByRole("button", { name: /Base/ }))
  })
})

/**
 * The composer's per-task base. It exists for the deliberate case — stack
 * this task on a feature branch, target a release line — so its resting
 * state has to read as "the project decides", not as an empty required field.
 */
describe("create task dialog base", () => {
  function mount() {
    render(
      <CreateTaskDialog
        open
        onOpenChange={() => {}}
        initialRepoPath="/repo"
        repos={[repo]}
        harnesses={[harness]}
        harnessesError={null}
        onCreated={() => {}}
      />,
      { wrapper: runtimeWrapper(fakeDaemonTransport()) },
    )
  }

  it("rests on the project's base and offers an override", async () => {
    mount()
    // labelled "Base", never a resolved ref: the composer cannot know what
    // origin/HEAD points at, and the daemon only resolves it after fetching
    const picker = await screen.findByRole("button", { name: /Base/ })
    fireEvent.click(picker)
    expect(await screen.findByRole("menuitemradio", { name: /Project default/ })).toBeInTheDocument()
    // an action inside a radio group is itself a radio item — see MENU_ACTION
    expect(screen.getByRole("menuitemradio", { name: "Start from another ref…" })).toBeInTheDocument()
  })

  it("is absent for a local task, which has nothing to fork", async () => {
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "Worktree" }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "This repo" }))
    await screen.findByRole("button", { name: "This repo" })
    expect(screen.queryByRole("button", { name: /^Base$/ })).toBeNull()
  })
})
