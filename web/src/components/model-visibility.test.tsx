import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

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

const harness = (name: string, models: string[]): HarnessInfo => ({
  name,
  hasModel: true,
  hasEffort: false,
  hasImage: false,
  defaults: { model: models[0] },
  models: { list: models, defaultModel: models[0] ?? null, probedAt: "2026-09-22T00:00:00.000Z" },
})

const HARNESSES = [
  harness("claude", ["claude-opus-5", "claude-sonnet-5"]),
  harness("cursor", ["auto", "composer-2.5"]),
]

/** A daemon that answers /api/settings with the curation under test. */
function mount(hiddenModels: Record<string, string[]> | undefined, patched: unknown[] = []) {
  const request = vi.fn(async (path: string, init?: { method?: string; body?: unknown }) => {
    if (path === "/api/settings") {
      if (hiddenModels === undefined && init?.method === undefined) {
        // an older daemon: the route exists but knows no curation
        return { autoRenameTasksFromPullRequests: true }
      }
      if (init?.method === "PATCH") {
        patched.push(init.body)
        return { autoRenameTasksFromPullRequests: true, ...(init.body as object) }
      }
      return { autoRenameTasksFromPullRequests: true, hiddenModels: hiddenModels ?? {} }
    }
    if (path === "/api/harnesses") return { harnesses: HARNESSES }
    return {}
  })
  render(
    <CreateTaskDialog
      open
      onOpenChange={() => {}}
      initialRepoPath="/repo"
      repos={[repo]}
      harnesses={HARNESSES}
      harnessesError={null}
      onCreated={() => {}}
    />,
    {
      wrapper: runtimeWrapper(
        fakeDaemonTransport("test-connection", {
          request: request as unknown as DaemonTransport["request"],
        }),
      ),
    },
  )
  return request
}

const openPicker = async () => {
  fireEvent.click(await screen.findByRole("button", { name: /claude/ }))
}

describe("the model picker's curation", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("leaves out the hidden models and says how many are missing", async () => {
    mount({ claude: ["claude-sonnet-5"], cursor: ["auto", "composer-2.5"] })
    await openPicker()

    await waitFor(() => expect(screen.queryByText("claude-sonnet-5")).not.toBeInTheDocument())
    expect(screen.getByText("claude-opus-5")).toBeInTheDocument()
    // every cursor model is hidden, so the harness itself drops out
    expect(screen.queryByText("cursor")).not.toBeInTheDocument()
    expect(screen.getByText("Show 3 hidden")).toBeInTheDocument()
  })

  it("Show N hidden reveals them for this opening only, and forgets on close", async () => {
    mount({ claude: ["claude-sonnet-5"] })
    await openPicker()
    await waitFor(() => expect(screen.getByText("Show 1 hidden")).toBeInTheDocument())

    fireEvent.click(screen.getByText("Show 1 hidden"))
    expect(screen.getByText("claude-sonnet-5")).toBeInTheDocument()
    expect(screen.getByText("Hide them again")).toBeInTheDocument()

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    await waitFor(() => expect(screen.queryByText("claude-sonnet-5")).not.toBeInTheDocument())
    await openPicker()
    await waitFor(() => expect(screen.getByText("Show 1 hidden")).toBeInTheDocument())
    expect(screen.queryByText("claude-sonnet-5")).not.toBeInTheDocument()
  })

  it("the row's eye PATCHes a denylist rather than an allowlist", async () => {
    const patched: unknown[] = []
    mount({}, patched)
    await openPicker()

    const hide = await screen.findByRole("button", {
      name: "Hide claude · claude-sonnet-5 from the picker",
    })
    fireEvent.click(hide)
    await waitFor(() => expect(patched).toHaveLength(1))
    expect(patched[0]).toEqual({ hiddenModels: { claude: ["claude-sonnet-5"] } })
    // the row is a base-ui RadioItem: pressing its eye must not also pick the
    // model, nor close the menu on someone curating several in a row
    expect(screen.getByText("claude-opus-5")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Hide claude · claude-opus-5 from the picker" }),
    ).toBeInTheDocument()
  })

  it("keeps the CURRENT choice listed even after it is hidden", async () => {
    // claude-opus-5 is what the composer opens on, and hiding it must not
    // leave the trigger naming a model its own menu denies
    mount({ claude: ["claude-opus-5"] })
    await openPicker()
    await waitFor(() => expect(screen.getByText("claude-opus-5")).toBeInTheDocument())
    expect(screen.getByText("hidden")).toBeInTheDocument()
  })

  it("offers no eye and no manager on a daemon that cannot store a curation", async () => {
    mount(undefined)
    await openPicker()

    await waitFor(() => expect(screen.getByText("claude-sonnet-5")).toBeInTheDocument())
    expect(screen.queryByText("Manage models…")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /from the picker$/ }),
    ).not.toBeInTheDocument()
    // the list it always showed is still whole
    expect(screen.getByText("auto")).toBeInTheDocument()
  })
})

describe("the manager", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("opens from the picker, and Hide all retires a harness in one click", async () => {
    const patched: unknown[] = []
    mount({}, patched)
    await openPicker()

    fireEvent.click(await screen.findByText("Manage models…"))
    const heading = await screen.findByText("Which models the picker offers on this daemon")
    expect(heading).toBeInTheDocument()

    const [, cursorHideAll] = await screen.findAllByRole("button", { name: "Hide all" })
    fireEvent.click(cursorHideAll!)
    await waitFor(() => expect(patched).toHaveLength(1))
    expect(patched[0]).toEqual({ hiddenModels: { cursor: ["auto", "composer-2.5"] } })
  })

  it("filtering narrows the rows and drops a harness that matches nothing", async () => {
    mount({})
    await openPicker()
    fireEvent.click(await screen.findByText("Manage models…"))

    const filter = await screen.findByLabelText("Filter models")
    fireEvent.change(filter, { target: { value: "composer" } })
    await waitFor(() => expect(screen.queryByText("claude-opus-5")).not.toBeInTheDocument())
    expect(screen.getByText("composer-2.5")).toBeInTheDocument()
  })

  it("hiding the preferred model clears the star it can no longer seed", async () => {
    const patched: unknown[] = []
    mount({}, patched)
    await openPicker()

    fireEvent.click(
      await screen.findByRole("button", { name: "Prefer claude · claude-sonnet-5 for new tasks" }),
    )
    await screen.findByRole("button", {
      name: "Clear preferred model claude · claude-sonnet-5",
    })

    fireEvent.click(screen.getByText("Manage models…"))
    const [claudeHideAll] = await screen.findAllByRole("button", { name: "Hide all" })
    fireEvent.click(claudeHideAll!)

    await waitFor(() => expect(patched).toHaveLength(1))
    expect(
      JSON.parse(localStorage.getItem("wisp_connection:test-connection:preferred_model") ?? "null"),
    ).toBeNull()
  })
})
