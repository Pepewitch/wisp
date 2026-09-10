import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

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
