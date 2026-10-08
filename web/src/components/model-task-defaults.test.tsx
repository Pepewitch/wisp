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
  it("shows a brief that is on by default, and PATCHes only the overrides", async () => {
    const sent: { path: string; body: unknown }[] = []
    render(<ModelVisibilityDialog open onOpenChange={() => {}} />, { wrapper: daemon({}, sent) })

    const brief = await screen.findByRole("switch", { name: "Task brief for new claude · claude-sonnet-5 tasks" })
    expect(brief).toHaveAttribute("aria-checked", "true")
    const merge = screen.getByRole("switch", { name: "Auto-merge for new claude · claude-sonnet-5 tasks" })
    expect(merge).toHaveAttribute("aria-checked", "false")
    // cursor cannot publish a brief, so its row offers no brief switch
    expect(screen.queryByRole("switch", { name: "Task brief for new cursor · auto tasks" })).toBeNull()
    expect(screen.getByRole("switch", { name: "Auto-fix for new cursor · auto tasks" })).toBeInTheDocument()

    fireEvent.click(brief)
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]!.body).toEqual({ modelTaskDefaults: { claude: { "claude-sonnet-5": { brief: false } } } })

    // the second click builds on the first rather than on the pre-click map
    fireEvent.click(merge)
    await waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]!.body).toEqual({
      modelTaskDefaults: { claude: { "claude-sonnet-5": { brief: false, autoMerge: true } } },
    })
  })

  it("offers no switches on a daemon that cannot store them", async () => {
    render(<ModelVisibilityDialog open onOpenChange={() => {}} />, { wrapper: daemon(undefined) })
    await screen.findByText("claude-sonnet-5")
    expect(screen.queryByRole("switch")).toBeNull()
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
