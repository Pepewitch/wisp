import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { clearConnectionDrafts } from "@/lib/drafts"
import { ApiError, type DaemonRequestOptions } from "@/lib/transport"
import type { ApiTask, HarnessInfo } from "@/lib/types"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { NewSubtaskDialog } from "./new-subtask-dialog"

const harness: HarnessInfo = {
  name: "droid",
  hasModel: true,
  hasEffort: false,
  hasImage: false,
  defaults: { model: "kimi-k3" },
  models: { list: ["kimi-k3"], defaultModel: "kimi-k3", probedAt: "2026-09-01T00:00:00.000Z" },
}

const PARENT = {
  id: "tparent", title: "Orchestrate the release", repo_path: "/repo", branch: "wisp/tparent-release", archived: false,
  subtask_kind: null, parent_task_id: null, mode: "worktree", state: "done",
} as unknown as ApiTask

afterEach(() => {
  clearConnectionDrafts("test-connection")
  vi.unstubAllGlobals()
})

function mount(refuse?: string) {
  const posts: unknown[] = []
  const request = vi.fn(async (path: string, options?: DaemonRequestOptions) => {
    if (path === "/api/harnesses") return { harnesses: [harness], features: { subtasks: true, taskAutopilot: true } }
    if (path === "/api/tasks" && options?.method === "POST") {
      posts.push(options.body)
      if (refuse) throw new ApiError(refuse, 409)
      return { id: "tchild", title: "child" }
    }
    return {}
  })
  const onOpenChange = vi.fn()
  render(<NewSubtaskDialog parent={PARENT} open onOpenChange={onOpenChange} />, {
    wrapper: runtimeWrapper(fakeDaemonTransport("test-connection", { request: request as never })),
  })
  return { posts, onOpenChange }
}

const prompt = () => screen.getByPlaceholderText<HTMLTextAreaElement>("What do you want to work on?")

describe("New subtask", () => {
  it("sends the parent, the kind and reporting on, with no project of its own, and closes", async () => {
    const { posts, onOpenChange } = mount()
    expect(await screen.findByText("of Orchestrate the release")).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "Report back" })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByText(/the project's base, pinned when it starts/)).toBeInTheDocument()
    fireEvent.change(prompt(), { target: { value: "try the other parser" } })
    await waitFor(() => expect(screen.getByRole("button", { name: /^Create/ })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: /^Create/ }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({ prompt: "try the other parser", harness: "droid", model: "kimi-k3", parentTaskId: "tparent", subtaskKind: "explore", report: true })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("offers autopilot to an explore subtask only, and previews each kind's base", async () => {
    mount()
    expect(await screen.findByRole("button", { name: "Manual PR" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Kind" }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /continue/ }))
    expect(await screen.findByText(/this task's tip \(wisp\/tparent-release\), pinned when it starts/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Manual PR" })).toBeNull()
  })

  it("shows the daemon's own refusal, and sends no reporting when it is turned off", async () => {
    const { posts } = mount("task tparent has 3 live subtasks — the limit is 3")
    await screen.findByText("of Orchestrate the release")
    fireEvent.click(screen.getByRole("switch", { name: "Report back" }))
    fireEvent.change(prompt(), { target: { value: "one more" } })
    await waitFor(() => expect(screen.getByRole("button", { name: /^Create/ })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: /^Create/ }))
    expect(await screen.findByText("task tparent has 3 live subtasks — the limit is 3")).toBeInTheDocument()
    expect(posts[0]).toMatchObject({ report: false })
  })
})
