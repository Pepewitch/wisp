import { render, screen } from "@testing-library/react"
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
  it("stacks the bar into columns on a narrow modal and one line on a wide one", async () => {
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

    // The switch keys off the modal's own width (@container). Narrow: the
    // choices that shape the task stack in a left column; worktree rides
    // directly above Create in a right column pinned to the bottom right.
    // Wide: both clusters flatten into a single line.
    const create = await screen.findByRole("button", { name: "Create" })
    const rightCluster = create.parentElement as HTMLElement
    expect(rightCluster).toHaveClass("ml-auto", "flex-col", "justify-end", "@min-[640px]:flex-row")
    const bar = rightCluster.parentElement as HTMLElement
    expect(bar).toHaveClass("flex", "@min-[640px]:flex-wrap")
    expect(bar.firstElementChild).toHaveClass("min-w-0", "grow", "flex-col", "@min-[640px]:flex-row")
  })
})
