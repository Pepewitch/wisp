import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { clearRememberedAttachments } from "@/lib/attachments"
import { clearConnectionDrafts } from "@/lib/drafts"
import type { DaemonTransport } from "@/lib/transport"
import type { HarnessInfo, RepoInfo, SuffixPrompt } from "@/lib/types"
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
  hasFastMode: true,
  hasImage: false,
  effortLevels: ["high", "low"],
  defaults: { model: "kimi-k3", reasoningEffort: "high" },
  models: {
    list: ["kimi-k3", "other-model"],
    defaultModel: "kimi-k3",
    probedAt: "2026-09-01T00:00:00.000Z",
  },
}
const suffix: SuffixPrompt = {
  id: "suffix-review",
  name: "Review",
  prompt: "Check the result.",
  createdAt: "2026-09-01T00:00:00.000Z",
}

const prompt = () => screen.getByPlaceholderText<HTMLTextAreaElement>("What do you want to work on?")
const dialog = (open: boolean, currentHarness = harness) => (
  <CreateTaskDialog
    open={open}
    onOpenChange={() => {}}
    initialRepoPath="/repo"
    repos={[repo]}
    harnesses={[currentHarness]}
    harnessesError={null}
    onCreated={() => {}}
  />
)
const route = (suffixes: () => SuffixPrompt[], sent = vi.fn()) =>
  ((path: string, init?: { body?: unknown }) => {
    if (path === "/api/harnesses") return Promise.resolve({ harnesses: [harness], features: { taskAutopilot: true } })
    if (path === "/api/settings") return Promise.resolve({ hiddenModels: {} })
    if (path === "/api/suffix-prompts") return Promise.resolve({ suffixPrompts: suffixes() })
    sent(path, init?.body)
    return Promise.resolve({ id: "synthetic-task" })
  }) as DaemonTransport["request"]

afterEach(() => {
  clearRememberedAttachments("test-connection")
  clearConnectionDrafts("test-connection")
})

describe("restored create-task options", () => {
  it("keeps base, effort, fast mode, autopilot, and suffix until submission", async () => {
    const sent = vi.fn()
    const view = render(dialog(true), {
      wrapper: runtimeWrapper(fakeDaemonTransport("test-connection", {
        request: route(() => [suffix], sent),
      })),
    })
    fireEvent.change(prompt(), { target: { value: "finish the work" } })

    fireEvent.click(screen.getByRole("button", { name: "Base" }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Start from another ref…" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Base branch" }), { target: { value: "release/test" } })
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Base branch" }), { key: "Enter" })

    fireEvent.click(screen.getByRole("button", { name: "high" }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "low" }))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    fireEvent.click(screen.getByRole("button", { name: "Fast mode" }))

    fireEvent.click(await screen.findByRole("button", { name: "Manual PR" }))
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Auto-merge" }))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    fireEvent.click(screen.getByRole("button", { name: "Suffix prompt" }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Review" }))

    view.rerender(dialog(false))
    view.rerender(dialog(true))
    expect(prompt()).toHaveValue("finish the work")
    expect(screen.getByRole("button", { name: "release/test" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "low" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Fast mode on" })).toBeInTheDocument()
    expect(await screen.findByRole("button", { name: "Auto-merge" })).toBeInTheDocument()
    expect(await screen.findByRole("button", { name: "Review" })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(sent).toHaveBeenCalledWith("/api/tasks", expect.objectContaining({
      base: "release/test",
      effort: "low",
      fast: true,
      suffixPromptId: suffix.id,
      autopilot: { autoMerge: true, autoFix: false },
    })))
  })

  it("flags a saved model that is no longer offered and lets another be picked", async () => {
    const transport = fakeDaemonTransport("test-connection", { request: route(() => [suffix]) })
    const first = render(dialog(true), { wrapper: runtimeWrapper(transport) })
    fireEvent.change(prompt(), { target: { value: "finish the work" } })
    fireEvent.click(screen.getByRole("button", { name: /droid.*kimi-k3/ }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /other-model/ }))
    first.unmount()

    const currentHarness: HarnessInfo = {
      ...harness,
      models: { ...harness.models!, list: ["kimi-k3"] },
    }
    render(dialog(true, currentHarness), { wrapper: runtimeWrapper(transport) })
    expect(prompt()).toHaveValue("finish the work")
    expect(screen.getByText("The selected model is no longer available. Pick another model.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: /droid.*other-model/ }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /kimi-k3/ }))
    expect(screen.getByRole("button", { name: "Create" })).not.toBeDisabled()
  })

  it("names a deleted saved suffix and waits for a new choice", async () => {
    let suffixes = [suffix]
    const transport = fakeDaemonTransport("test-connection", { request: route(() => suffixes) })
    const first = render(dialog(true), { wrapper: runtimeWrapper(transport) })
    fireEvent.change(prompt(), { target: { value: "finish the work" } })
    fireEvent.click(screen.getByRole("button", { name: "Suffix prompt" }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Review" }))
    first.unmount()

    suffixes = []
    render(dialog(true), { wrapper: runtimeWrapper(transport) })
    expect(prompt()).toHaveValue("finish the work")
    expect(await screen.findByRole("button", { name: "Unavailable suffix prompt" })).toBeInTheDocument()
    expect(screen.getByText("The selected suffix prompt is no longer available. Pick another one.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Unavailable suffix prompt" }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "No suffix prompt" }))
    expect(screen.getByRole("button", { name: "Create" })).not.toBeDisabled()
  })
})
