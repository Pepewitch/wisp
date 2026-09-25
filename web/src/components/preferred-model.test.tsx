import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { clearRememberedAttachments } from "@/lib/attachments"
import { clearConnectionDrafts } from "@/lib/drafts"
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
  models: {
    list: models,
    defaultModel: models[0] ?? null,
    probedAt: "2026-09-01T00:00:00.000Z",
  },
})

const harnesses = [harness("claude", ["claude-a"]), harness("codex", ["codex-a", "codex-b"])]
const created = vi.fn()

function mountDialog() {
  const request = ((path: string) =>
    Promise.resolve(path === "/api/tasks" ? { id: "synthetic-task" } : {})) as DaemonTransport["request"]
  return render(
    <CreateTaskDialog
      open
      onOpenChange={() => {}}
      initialRepoPath="/repo"
      repos={[repo]}
      harnesses={harnesses}
      harnessesError={null}
      onCreated={created}
    />,
    { wrapper: runtimeWrapper(fakeDaemonTransport("test-connection", { request })) },
  )
}

afterEach(() => {
  localStorage.clear()
  clearConnectionDrafts("test-connection")
  clearRememberedAttachments("test-connection")
  created.mockReset()
})

async function submitTask(number: number) {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
  fireEvent.change(screen.getByPlaceholderText("What do you want to work on?"), {
    target: { value: `task ${number}` },
  })
  fireEvent.click(screen.getByRole("button", { name: "Create" }))
  await waitFor(() => expect(created).toHaveBeenCalledTimes(number))
}

describe("preferred model picker", () => {
  it("stars a future default without changing the current dialog, and the filled star clears it", async () => {
    const first = mountDialog()
    const current = await screen.findByRole("button", { name: /claude.*claude-a/ })
    fireEvent.click(current)

    const preferCodex = await screen.findByRole("button", { name: "Prefer codex · codex-b for new tasks" })
    expect(preferCodex).toHaveAttribute("aria-pressed", "false")
    fireEvent.click(preferCodex)

    expect(current).toHaveTextContent("claude-a")
    expect(screen.getByRole("button", { name: "Clear preferred model codex · codex-b" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )

    // Closing alone restores this dialog's choice, despite the new preference.
    first.unmount()
    const reopened = mountDialog()
    expect(await screen.findByRole("button", { name: /claude.*claude-a/ })).toBeInTheDocument()
    // A successful create clears it, so the preference becomes the next pick.
    await submitTask(1)
    reopened.unmount()
    const second = mountDialog()
    const preferredCurrent = await screen.findByRole("button", { name: /codex.*codex-b/ })
    fireEvent.click(preferredCurrent)
    fireEvent.click(await screen.findByRole("button", { name: "Clear preferred model codex · codex-b" }))

    expect(preferredCurrent).toHaveTextContent("codex-b")
    await submitTask(2)
    second.unmount()
    mountDialog()
    expect(await screen.findByRole("button", { name: /claude.*claude-a/ })).toBeInTheDocument()
  })
})
