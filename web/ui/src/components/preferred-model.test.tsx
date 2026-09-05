import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { HarnessInfo, RepoInfo } from "@/lib/types"

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

function mountDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <CreateTaskDialog
        open
        onOpenChange={() => {}}
        initialRepoPath="/repo"
        repos={[repo]}
        harnesses={harnesses}
        harnessesError={null}
        onCreated={() => {}}
      />
    </QueryClientProvider>,
  )
}

afterEach(() => localStorage.clear())

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

    first.unmount()
    const second = mountDialog()
    const preferredCurrent = await screen.findByRole("button", { name: /codex.*codex-b/ })
    fireEvent.click(preferredCurrent)
    fireEvent.click(await screen.findByRole("button", { name: "Clear preferred model codex · codex-b" }))

    expect(preferredCurrent).toHaveTextContent("codex-b")
    second.unmount()
    mountDialog()
    expect(await screen.findByRole("button", { name: /claude.*claude-a/ })).toBeInTheDocument()
  })
})
