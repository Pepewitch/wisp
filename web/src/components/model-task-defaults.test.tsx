import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { clearConnectionDrafts } from "@/lib/drafts"
import type { DaemonTransport } from "@/lib/transport"
import type { HarnessInfo, RepoInfo } from "@/lib/types"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { CreateTaskDialog } from "./create-task-dialog"
import { ModelVisibilityDialog } from "./model-visibility-dialog"

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

const harness = (name: string, models: string[], hasBriefs = true): HarnessInfo => ({
  name,
  hasModel: true,
  hasEffort: false,
  hasImage: false,
  hasBriefs,
  defaults: { model: models[0] },
  models: { list: models, defaultModel: models[0] ?? null, probedAt: "2026-09-22T00:00:00.000Z" },
})

const HARNESSES = [harness("claude", ["claude-opus-5", "claude-sonnet-5"]), harness("cursor", ["auto"], false)]
const FEATURES = { taskBriefs: true, taskAutopilot: true }

function daemon(modelTaskDefaults: Record<string, unknown> | undefined, sent: { path: string; body: unknown }[] = []) {
  let settings: Record<string, unknown> = {
    autoRenameTasksFromPullRequests: true,
    hiddenModels: {},
    ...(modelTaskDefaults ? { modelTaskDefaults } : {}),
  }
  const request = vi.fn(async (path: string, init?: { method?: string; body?: unknown }) => {
    if (path === "/api/settings") {
      if (init?.method === "PATCH") {
        sent.push({ path, body: init.body })
        settings = { ...settings, ...(init.body as object) }
      }
      return settings
    }
    if (path === "/api/harnesses") return { harnesses: HARNESSES, features: FEATURES }
    if (path === "/api/suffix-prompts") return { suffixPrompts: [] }
    sent.push({ path, body: init?.body })
    return { id: "synthetic-task" }
  })
  return runtimeWrapper(
    fakeDaemonTransport("test-connection", { request: request as unknown as DaemonTransport["request"] }),
  )
}

beforeEach(() => localStorage.clear())
afterEach(() => clearConnectionDrafts("test-connection"))

describe("per-model task defaults in the Models modal", () => {
  const openDefaults = async (name: string) =>
    fireEvent.click(await screen.findByRole("button", { name: `New task defaults for ${name}` }))

  it("starts with a brief, edits from the row menu, and PATCHes only the overrides", async () => {
    const sent: { path: string; body: unknown }[] = []
    render(<ModelVisibilityDialog open onOpenChange={() => {}} />, { wrapper: daemon({}, sent) })

    await openDefaults("claude · claude-sonnet-5")
    const brief = await screen.findByRole("menuitemcheckbox", { name: "Task brief" })
    expect(brief).toHaveAttribute("aria-checked", "true")
    const merge = screen.getByRole("menuitemcheckbox", { name: "Auto-merge" })
    expect(merge).toHaveAttribute("aria-checked", "false")

    fireEvent.click(brief)
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]!.body).toEqual({ modelTaskDefaults: { claude: { "claude-sonnet-5": { brief: false } } } })

    // the menu stays open, and the second click builds on the first rather
    // than on the pre-click map
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Auto-merge" }))
    await waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]!.body).toEqual({
      modelTaskDefaults: { claude: { "claude-sonnet-5": { brief: false, autoMerge: true } } },
    })
  })

  it("names only how a model differs from the usual start", async () => {
    render(<ModelVisibilityDialog open onOpenChange={() => {}} />, {
      wrapper: daemon({
        claude: { "claude-opus-5": { autoFix: true, autoMerge: true } },
        cursor: { auto: { brief: false } },
      }),
    })
    expect(await screen.findByText("Auto-fix · Auto-merge")).toBeInTheDocument()
    // cursor's harness here cannot publish a brief, so "No brief" would describe nothing
    expect(screen.queryByText("No brief")).toBeNull()
    expect(screen.getAllByText(/Auto-fix|Auto-merge|No brief/)).toHaveLength(1)

    await openDefaults("cursor · auto")
    expect(await screen.findByRole("menuitemcheckbox", { name: "Auto-fix" })).toBeInTheDocument()
    expect(screen.queryByRole("menuitemcheckbox", { name: "Task brief" })).toBeNull()
  })

  it("offers no menu on a daemon that cannot store them", async () => {
    render(<ModelVisibilityDialog open onOpenChange={() => {}} />, { wrapper: daemon(undefined) })
    await screen.findByText("claude-sonnet-5")
    expect(screen.queryByRole("button", { name: /^New task defaults for/ })).toBeNull()
  })
})

describe("the composer seeds from the chosen model's defaults", () => {
  const dialog = (
    <CreateTaskDialog
      open
      onOpenChange={() => {}}
      initialRepoPath="/repo"
      repos={[repo]}
      harnesses={HARNESSES}
      harnessesError={null}
      onCreated={() => {}}
    />
  )
  const prompt = () => screen.getByPlaceholderText<HTMLTextAreaElement>("What do you want to work on?")

  it("asks for a brief by default", async () => {
    const sent: { path: string; body: unknown }[] = []
    render(dialog, { wrapper: daemon({}, sent) })
    expect(await screen.findByRole("button", { name: "Task brief on" })).toBeInTheDocument()
    fireEvent.change(prompt(), { target: { value: "do the work" } })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(sent.find((call) => call.path === "/api/tasks")).toBeDefined())
    const body = sent.find((call) => call.path === "/api/tasks")!.body as Record<string, unknown>
    expect(body.briefEnabled).toBe(true)
    expect(body.autopilot).toBeUndefined()
  })

  it("starts from the model's own defaults and reseeds when another model is picked", async () => {
    const sent: { path: string; body: unknown }[] = []
    render(dialog, {
      wrapper: daemon(
        {
          claude: {
            "claude-opus-5": { brief: false, autoMerge: true },
            "claude-sonnet-5": { autoFix: true },
          },
        },
        sent,
      ),
    })
    expect(await screen.findByRole("button", { name: "Auto-merge" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Task brief" })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /claude.*claude-opus-5/ }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /claude-sonnet-5/ }))
    expect(await screen.findByRole("button", { name: "Auto-fix" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Task brief on" })).toBeInTheDocument()

    fireEvent.change(prompt(), { target: { value: "do the work" } })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(sent.find((call) => call.path === "/api/tasks")).toBeDefined())
    expect(sent.find((call) => call.path === "/api/tasks")!.body).toMatchObject({
      model: "claude-sonnet-5",
      briefEnabled: true,
      autopilot: { autoMerge: false, autoFix: true },
    })
  })
})
