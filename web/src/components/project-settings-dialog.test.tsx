import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { VerificationStatus } from "../../../shared/api/auto-review"
import { api } from "@/lib/api"
import { clearCreateTaskDraft, writeCreateTaskDraft } from "@/lib/drafts"
import type { RepoInfo } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { ProjectSettingsSpecimen } from "./project-settings-dialog"

interface Call {
  path: string
  method: string
  body: unknown
}

const CONFIGURED: RepoInfo = {
  path: "/repo",
  name: "sample-app",
  exists: true,
  setupScript: "",
  archiveScript: "",
  copyFiles: [],
  baseBranch: "",
  configured: true,
}

const HISTORY_ONLY: RepoInfo = {
  ...CONFIGURED,
  name: null,
  configured: false,
}

function stubApi() {
  const calls: Call[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      const method = init?.method ?? "GET"
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ path, method, body })
      if (path === "/api/projects" && method === "DELETE") {
        return Response.json({ ok: true, path: (body as { path: string }).path })
      }
      if (path === "/api/projects" && method === "POST") {
        return Response.json({ path: (body as { path: string }).path })
      }
      return Response.json({ error: `unexpected ${method} ${path}` }, { status: 500 })
    }),
  )
  return calls
}

function mount(node: ReactNode) {
  return render(node, {
    wrapper: runtimeWrapper(fakeDaemonTransport("test-connection", { request: api })),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("project settings remove", () => {
  it("explains why a history-only repo has no unregister control", () => {
    stubApi()
    mount(<ProjectSettingsSpecimen project={HISTORY_ONLY} />)
    expect(screen.queryByRole("button", { name: "Remove from Wisp" })).toBeNull()
    expect(screen.getByText("Not tracked by Wisp. This project remains visible because it has task history.")).toBeInTheDocument()
  })

  it("unregisters behind a two-click confirm and never fires on the first click", async () => {
    const calls = stubApi()
    mount(<ProjectSettingsSpecimen project={CONFIGURED} activeTaskCount={2} />)

    const remove = screen.getByRole("button", { name: "Remove from Wisp" })
    expect(remove).toHaveClass("bg-destructive", "text-destructive-foreground")
    fireEvent.click(remove)
    expect(calls.some((call) => call.method === "DELETE")).toBe(false)
    expect(screen.getByRole("checkbox", { name: "Archive all 2 active tasks" })).toBeChecked()
    expect(
      screen.getByText("Runs normal archive cleanup and removes task worktrees. The project folder stays on disk."),
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Keep sample-app" }))
    expect(screen.getByRole("button", { name: "Remove from Wisp" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Remove from Wisp" }))
    const confirm = screen.getByRole("button", { name: "Confirm remove sample-app" })
    expect(confirm).toHaveClass("bg-destructive", "text-destructive-foreground")
    fireEvent.click(confirm)

    await waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true))
    expect(calls.find((call) => call.method === "DELETE")).toEqual({
      path: "/api/projects",
      method: "DELETE",
      body: { path: "/repo", archiveTasks: true },
    })
  })

  it("lets active tasks stay when the archive option is cleared", async () => {
    const calls = stubApi()
    mount(<ProjectSettingsSpecimen project={CONFIGURED} activeTaskCount={2} />)

    fireEvent.click(screen.getByRole("button", { name: "Remove from Wisp" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Archive all 2 active tasks" }))
    expect(
      screen.getByText("Active tasks stay visible, so this project will remain in the Projects list."),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove sample-app" }))

    await waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true))
    expect(calls.find((call) => call.method === "DELETE")?.body).toEqual({
      path: "/repo",
      archiveTasks: false,
    })
  })
})

/**
 * The base branch field's whole risk is someone filling in a box that was
 * correct empty. The placeholder is the first defence and Reset is the
 * second, so both are worth a test.
 */
describe("project settings base branch", () => {
  it("starts empty, names what empty does, and only offers Reset once set", () => {
    stubApi()
    mount(<ProjectSettingsSpecimen project={CONFIGURED} />)

    const field = screen.getByLabelText("Base branch")
    expect(field).toHaveValue("")
    expect(field).toHaveAttribute("placeholder", "origin/HEAD — the remote's default branch")
    // nothing to undo yet, so the control cannot be mistaken for an action
    expect(screen.getByRole("button", { name: "Reset base branch to the Wisp default" })).toBeDisabled()
  })

  it("saves a trimmed override, and Reset sends the empty string that clears it", async () => {
    const calls = stubApi()
    mount(<ProjectSettingsSpecimen project={{ ...CONFIGURED, baseBranch: "origin/develop" }} />)

    const field = screen.getByLabelText("Base branch")
    expect(field).toHaveValue("origin/develop")

    fireEvent.change(field, { target: { value: "  origin/release-2.1  " } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true))
    expect((calls.find((call) => call.method === "POST")?.body as { baseBranch: string }).baseBranch).toBe(
      "origin/release-2.1",
    )

    const reset = screen.getByRole("button", { name: "Reset base branch to the Wisp default" })
    fireEvent.click(reset)
    expect(screen.getByLabelText("Base branch")).toHaveValue("")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    // "" is the clear: the daemon drops the key and resolves origin/HEAD again
    await waitFor(() => expect(calls.filter((call) => call.method === "POST").length).toBe(2))
    expect((calls.filter((call) => call.method === "POST")[1]?.body as { baseBranch: string }).baseBranch).toBe("")
  })
})

describe("project settings verification", () => {
  const STATUS_NONE: VerificationStatus = {
    state: "none", version: null, activatedAt: null, areas: [], draft: null, task: null, reviewer: null, attention: null,
  }
  const STATUS_DRAFT: VerificationStatus = {
    ...STATUS_NONE,
    state: "active",
    version: "3",
    activatedAt: "2026-10-10T09:00:00Z",
    areas: [{ name: "editor", paths: ["src/editor/**"], status: "proven", attention: "The launch step needs a seeded document" }],
    draft: { taskId: "tvr3ip", savedAt: "2026-10-12T09:00:00Z", areas: [{ name: "editor", paths: ["src/editor/**"], status: "proven" }] },
  }
  const REVIEWABLE: RepoInfo = {
    ...CONFIGURED,
    verify: { harness: "claude", model: "opus-5" },
    verification: { state: "none", areas: 0, draft: false, attention: false, busy: false },
  }
  const HARNESS = {
    name: "claude", hasModel: true, hasEffort: true, hasImage: true, effortLevels: ["low", "medium", "high", "max"],
    defaults: { model: "opus-5" }, models: { list: ["opus-5", "sonnet-5"], defaultModel: "opus-5", probedAt: "2026-10-12T08:00:00Z" },
  }

  function stubVerification(status: VerificationStatus, features: Record<string, boolean> = { autoReview: true }, tasks = 201, harnesses: unknown[] = [HARNESS]) {
    const calls: Call[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input)
        const method = init?.method ?? "GET"
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        calls.push({ path, method, body })
        if (path === "/api/harnesses") return Response.json({ harnesses, features })
        if (path === "/api/settings") return Response.json({ autoRenameTasksFromPullRequests: true, hiddenModels: {} })
        if (path.startsWith("/api/projects/verification?")) return Response.json(status)
        if (path === "/api/projects/verification/tasks") {
          return tasks === 201
            ? Response.json(
                {
                  task: { id: "tvr3ip", title: "Set up verification for sample-app" },
                  // an older daemon's 201 names no draft: it started from the active recipe
                  ...(features.recipeFromDraft ? { draft: status.draft && { taskId: status.draft.taskId, savedAt: status.draft.savedAt } } : {}),
                },
                { status: 201 },
              )
            : Response.json({ error: "Task tvr3ip is already working on this project's verification recipe" }, { status: tasks })
        }
        if (path === "/api/projects/verification/activate") return Response.json({ version: "4", areas: [], changed: true })
        if (path === "/api/projects" && method === "POST") return Response.json({ path: (body as { path: string }).path })
        return Response.json({ error: `unexpected ${method} ${path}` }, { status: 500 })
      }),
    )
    return calls
  }

  it("is absent on a daemon without features.autoReview, and Save sends no verify", async () => {
    const calls = stubVerification(STATUS_NONE, {})
    mount(<ProjectSettingsSpecimen project={REVIEWABLE} />)
    await waitFor(() => expect(calls.some((call) => call.path === "/api/harnesses")).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByRole("region", { name: "Verification" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(calls.some((call) => call.path === "/api/projects" && call.method === "POST")).toBe(true))
    expect(calls.find((call) => call.path === "/api/projects")!.body).not.toHaveProperty("verify")
  })

  it("Set up verification starts a recipe task on the reviewer agent, and selects it", async () => {
    const calls = stubVerification(STATUS_NONE)
    mount(<ProjectSettingsSpecimen project={REVIEWABLE} />)
    expect(await screen.findByText("No verification recipe yet")).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Note for the recipe task"), { target: { value: " cover the editor " } })
    fireEvent.click(screen.getByRole("button", { name: "Set up verification" }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "/api/projects/verification/tasks",
        method: "POST",
        body: { path: "/repo", mode: "setup", note: "cover the editor", harness: "claude", model: "opus-5" },
      }),
    )
    expect(await screen.findByText(/Started Set up verification for sample-app/)).toBeInTheDocument()
    expect(uiIntentsFor("test-connection").taskFocusRequest()).toMatchObject({ taskId: "tvr3ip" })
  })

  const savedBody = async (calls: Call[]) => {
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(calls.some((call) => call.path === "/api/projects" && call.method === "POST")).toBe(true))
    return calls.find((call) => call.path === "/api/projects" && call.method === "POST")!.body
  }
  const pick = async (picker: string, item: string | RegExp) => {
    fireEvent.click(screen.getByRole("button", { name: picker }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: item }))
  }

  describe("with each task's own agent as the reviewer", () => {
    const OWN = { ...REVIEWABLE, verify: null }
    afterEach(() => clearCreateTaskDraft("test-connection", "/repo"))

    it("starts a recipe task on an agent picked for it, and leaves the reviewer setting unchanged", async () => {
      const calls = stubVerification(STATUS_NONE)
      mount(<ProjectSettingsSpecimen project={OWN} />)
      // what a new task would start on: the first harness's default model, at its default effort
      const recipe = await screen.findByRole("button", { name: "Recipe agent" })
      await waitFor(() => expect(recipe).toHaveTextContent("claude · opus-5"))
      expect(screen.getByRole("button", { name: "Recipe agent effort" })).toHaveTextContent("Default effort")
      expect(screen.getByRole("button", { name: "Reviewer agent" })).toHaveTextContent("Each task's own agent")
      await pick("Recipe agent", /sonnet-5/)
      await pick("Recipe agent effort", "high")
      const setup = screen.getByRole("button", { name: "Set up verification" })
      expect(setup).toBeEnabled()
      fireEvent.click(setup)
      await waitFor(() =>
        expect(calls).toContainEqual({
          path: "/api/projects/verification/tasks",
          method: "POST",
          body: { path: "/repo", mode: "setup", harness: "claude", model: "sonnet-5", effort: "high" },
        }),
      )
      expect(await screen.findByText(/Started Set up verification for sample-app/)).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Reviewer agent" })).toHaveTextContent("Each task's own agent")
      expect(await savedBody(calls)).toMatchObject({ verify: null })
    })

    it("starts from the project's create composer when it has a drafted agent", async () => {
      writeCreateTaskDraft("test-connection", "/repo", {
        prompt: "", choice: { harness: "claude", model: "sonnet-5" }, effort: "max", fast: false, mode: "worktree", base: "", suffixPromptId: null,
      })
      const calls = stubVerification(STATUS_NONE)
      mount(<ProjectSettingsSpecimen project={OWN} />)
      await waitFor(() => expect(screen.getByRole("button", { name: "Recipe agent" })).toHaveTextContent("claude · sonnet-5"))
      expect(screen.getByRole("button", { name: "Recipe agent effort" })).toHaveTextContent("max effort")
      fireEvent.click(screen.getByRole("button", { name: "Set up verification" }))
      await waitFor(() =>
        expect(calls).toContainEqual({
          path: "/api/projects/verification/tasks",
          method: "POST",
          body: { path: "/repo", mode: "setup", harness: "claude", model: "sonnet-5", effort: "max" },
        }),
      )
    })

    it("starts on the harness a new task would, in the composer's order, at its configured effort", async () => {
      // the daemon lists droid first; the composer orders claude ahead of it
      const DROID = {
        name: "droid", hasModel: true, hasEffort: true, hasImage: true, effortLevels: ["low", "high"],
        defaults: { model: "droid-default" }, models: { list: ["droid-default"], defaultModel: "droid-default", probedAt: "2026-10-12T08:00:00Z" },
      }
      const CLAUDE = { ...HARNESS, defaults: { model: "opus-5", reasoningEffort: "medium" } }
      const calls = stubVerification(STATUS_NONE, { autoReview: true }, 201, [DROID, CLAUDE])
      mount(<ProjectSettingsSpecimen project={OWN} />)
      await waitFor(() => expect(screen.getByRole("button", { name: "Recipe agent" })).toHaveTextContent("claude · opus-5"))
      expect(screen.getByRole("button", { name: "Recipe agent effort" })).toHaveTextContent("medium effort")
      fireEvent.click(screen.getByRole("button", { name: "Set up verification" }))
      await waitFor(() =>
        expect(calls).toContainEqual({
          path: "/api/projects/verification/tasks",
          method: "POST",
          body: { path: "/repo", mode: "setup", harness: "claude", model: "opus-5", effort: "medium" },
        }),
      )
    })

    it("shows and clears a drafted effort on a harness that lists no levels", async () => {
      const CUSTOM = {
        name: "custom", hasModel: true, hasEffort: true, hasImage: false, effortLevels: [],
        defaults: { model: "c-1" }, models: { list: ["c-1"], defaultModel: "c-1", probedAt: "2026-10-12T08:00:00Z" },
      }
      writeCreateTaskDraft("test-connection", "/repo", {
        prompt: "", choice: { harness: "custom", model: "c-1" }, effort: "high", fast: false, mode: "worktree", base: "", suffixPromptId: null,
      })
      const calls = stubVerification(STATUS_NONE, { autoReview: true }, 201, [CUSTOM])
      mount(<ProjectSettingsSpecimen project={OWN} />)
      const effort = await screen.findByRole("button", { name: "Recipe agent effort" })
      await waitFor(() => expect(effort).toHaveTextContent("high effort"))
      await pick("Recipe agent effort", "Harness default")
      await waitFor(() => expect(screen.getByRole("button", { name: "Recipe agent effort" })).toHaveTextContent("Default effort"))
      fireEvent.click(screen.getByRole("button", { name: "Set up verification" }))
      await waitFor(() =>
        expect(calls).toContainEqual({
          path: "/api/projects/verification/tasks",
          method: "POST",
          body: { path: "/repo", mode: "setup", harness: "custom", model: "c-1" },
        }),
      )
    })

    it("drops the recipe agent once a reviewer agent is chosen, and saves that choice with Save", async () => {
      const calls = stubVerification(STATUS_NONE)
      mount(<ProjectSettingsSpecimen project={OWN} />)
      expect(await screen.findByRole("button", { name: "Recipe agent" })).toBeInTheDocument()
      await pick("Reviewer agent", /sonnet-5/)
      await waitFor(() => expect(screen.queryByRole("button", { name: "Recipe agent" })).toBeNull())
      expect(await savedBody(calls)).toMatchObject({ verify: { harness: "claude", model: "sonnet-5" } })
    })
  })

  it("chooses the reviewer's effort, saves it, and starts a recipe task with it", async () => {
    const calls = stubVerification(STATUS_NONE)
    mount(<ProjectSettingsSpecimen project={REVIEWABLE} />)
    const effort = await screen.findByRole("button", { name: "Reviewer agent effort" })
    await waitFor(() => expect(effort).toHaveTextContent("Default effort"))
    await pick("Reviewer agent effort", "high")
    await waitFor(() => expect(screen.getByRole("button", { name: "Reviewer agent effort" })).toHaveTextContent("high effort"))
    // a model change on the same harness keeps it
    await pick("Reviewer agent", /sonnet-5/)
    await waitFor(() => expect(screen.getByRole("button", { name: "Reviewer agent effort" })).toHaveTextContent("high effort"))
    fireEvent.click(screen.getByRole("button", { name: "Set up verification" }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "/api/projects/verification/tasks",
        method: "POST",
        body: { path: "/repo", mode: "setup", harness: "claude", model: "sonnet-5", effort: "high" },
      }),
    )
    expect(await savedBody(calls)).toMatchObject({ verify: { harness: "claude", model: "sonnet-5", effort: "high" } })
  })

  it("Harness default clears a reviewer's effort", async () => {
    const calls = stubVerification(STATUS_NONE)
    mount(<ProjectSettingsSpecimen project={{ ...REVIEWABLE, verify: { harness: "claude", model: "opus-5", effort: "xhigh" } }} />)
    // a level set elsewhere (the CLI) shows even when the harness does not list it
    const effort = await screen.findByRole("button", { name: "Reviewer agent effort" })
    await waitFor(() => expect(effort).toHaveTextContent("xhigh effort"))
    await pick("Reviewer agent effort", "Harness default")
    await waitFor(() => expect(screen.getByRole("button", { name: "Reviewer agent effort" })).toHaveTextContent("Default effort"))
    const body = (await savedBody(calls)) as { verify: Record<string, unknown> }
    expect(body.verify).toEqual({ harness: "claude", model: "opus-5" })
  })

  describe("the second reviewer", () => {
    const PANEL = { autoReview: true, reviewPanel: true }
    const saved = async (calls: Call[]) => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
      await waitFor(() => expect(calls.some((call) => call.path === "/api/projects" && call.method === "POST")).toBe(true))
      return calls.find((call) => call.path === "/api/projects")!.body
    }

    it("is absent without features.reviewPanel, and Save never sends verifySecond", async () => {
      const calls = stubVerification({ ...STATUS_NONE, second: "off" })
      mount(<ProjectSettingsSpecimen project={{ ...REVIEWABLE, verifySecond: "off" }} />)
      expect(await screen.findByRole("button", { name: "Reviewer agent" })).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Second reviewer" })).toBeNull()
      const body = await saved(calls)
      expect(body).toHaveProperty("verify")
      expect(body).not.toHaveProperty("verifySecond")
    })

    it("shows the daemon's choice, and Save leaves it alone until a person picks one", async () => {
      const calls = stubVerification({ ...STATUS_NONE, second: { harness: "claude", model: "sonnet-5", effort: null } }, PANEL)
      mount(<ProjectSettingsSpecimen project={REVIEWABLE} />)
      expect(await screen.findByRole("button", { name: "Second reviewer" })).toHaveTextContent("claude · sonnet-5")
      expect(await saved(calls)).not.toHaveProperty("verifySecond")
    })

    it("saves Off as \"off\"", async () => {
      const calls = stubVerification(STATUS_NONE, PANEL)
      mount(<ProjectSettingsSpecimen project={{ ...REVIEWABLE, verifySecond: null }} />)
      const picker = await screen.findByRole("button", { name: "Second reviewer" })
      expect(picker).toHaveTextContent("Same agent as the reviewer")
      fireEvent.click(picker)
      fireEvent.click(await screen.findByRole("menuitemradio", { name: "Off — one reviewer" }))
      await waitFor(() => expect(screen.getByRole("button", { name: "Second reviewer" })).toHaveTextContent("Off — one reviewer"))
      expect(await saved(calls)).toMatchObject({ verifySecond: "off" })
    })

    it("saves a chosen agent", async () => {
      const calls = stubVerification({ ...STATUS_NONE, second: "off" }, PANEL)
      mount(<ProjectSettingsSpecimen project={{ ...REVIEWABLE, verifySecond: "off" }} />)
      const picker = await screen.findByRole("button", { name: "Second reviewer" })
      await waitFor(() => expect(picker).toHaveTextContent("Off — one reviewer"))
      fireEvent.click(picker)
      fireEvent.click(await screen.findByRole("menuitemradio", { name: /sonnet-5/ }))
      await waitFor(() => expect(screen.getByRole("button", { name: "Second reviewer" })).toHaveTextContent("claude · sonnet-5"))
      expect(await saved(calls)).toMatchObject({ verifySecond: { harness: "claude", model: "sonnet-5" } })
    })

    it("saves the second reviewer's effort", async () => {
      const calls = stubVerification({ ...STATUS_NONE, second: "off" }, PANEL)
      mount(<ProjectSettingsSpecimen project={{ ...REVIEWABLE, verifySecond: "off" }} />)
      const picker = await screen.findByRole("button", { name: "Second reviewer" })
      await waitFor(() => expect(picker).toHaveTextContent("Off — one reviewer"))
      expect(screen.queryByRole("button", { name: "Second reviewer effort" })).toBeNull()
      await pick("Second reviewer", /sonnet-5/)
      await pick("Second reviewer effort", "max")
      await waitFor(() => expect(screen.getByRole("button", { name: "Second reviewer effort" })).toHaveTextContent("max effort"))
      expect(await saved(calls)).toMatchObject({ verifySecond: { harness: "claude", model: "sonnet-5", effort: "max" } })
    })

    it("saves Same agent as the reviewer as null, which clears the choice", async () => {
      const calls = stubVerification({ ...STATUS_NONE, second: "off" }, PANEL)
      mount(<ProjectSettingsSpecimen project={{ ...REVIEWABLE, verifySecond: "off" }} />)
      const picker = await screen.findByRole("button", { name: "Second reviewer" })
      await waitFor(() => expect(picker).toHaveTextContent("Off — one reviewer"))
      fireEvent.click(picker)
      fireEvent.click(await screen.findByRole("menuitemradio", { name: "Same agent as the reviewer" }))
      await waitFor(() => expect(screen.getByRole("button", { name: "Second reviewer" })).toHaveTextContent("Same agent as the reviewer"))
      expect(await saved(calls)).toMatchObject({ verifySecond: null })
    })
  })

  describe("each reviewer's fallback", () => {
    const FALLBACK = { autoReview: true, reviewPanel: true, reviewFallback: true }
    const saved = async (calls: Call[]) => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
      await waitFor(() => expect(calls.some((call) => call.path === "/api/projects" && call.method === "POST")).toBe(true))
      return calls.find((call) => call.path === "/api/projects")!.body
    }

    it("is absent without features.reviewFallback, and Save never sends a fallback", async () => {
      const calls = stubVerification(STATUS_NONE, { autoReview: true, reviewPanel: true })
      mount(<ProjectSettingsSpecimen project={REVIEWABLE} />)
      expect(await screen.findByRole("button", { name: "Second reviewer" })).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Fallback for A" })).toBeNull()
      const body = await saved(calls)
      expect(body).not.toHaveProperty("verifyFallback")
      expect(body).not.toHaveProperty("verifySecondFallback")
    })

    it("shows the daemon's choices, and Save leaves them alone until a person picks one", async () => {
      const fallbacks = { primary: { harness: "claude", model: "sonnet-5", effort: null }, second: null }
      const calls = stubVerification({ ...STATUS_NONE, fallbacks }, FALLBACK)
      mount(<ProjectSettingsSpecimen project={REVIEWABLE} />)
      await waitFor(() => expect(screen.getByRole("button", { name: "Fallback for A" })).toHaveTextContent("claude · sonnet-5"))
      expect(screen.getByRole("button", { name: "Fallback for B" })).toHaveTextContent("None — the round needs you")
      const body = await saved(calls)
      expect(body).not.toHaveProperty("verifyFallback")
      expect(body).not.toHaveProperty("verifySecondFallback")
    })

    it("saves a chosen fallback for B, and None for A as null", async () => {
      const fallbacks = { primary: { harness: "claude", model: "sonnet-5", effort: null }, second: null }
      const calls = stubVerification({ ...STATUS_NONE, fallbacks }, FALLBACK)
      mount(<ProjectSettingsSpecimen project={REVIEWABLE} />)
      await waitFor(() => expect(screen.getByRole("button", { name: "Fallback for A" })).toHaveTextContent("claude · sonnet-5"))
      await pick("Fallback for A", "None — the round needs you")
      await waitFor(() => expect(screen.getByRole("button", { name: "Fallback for A" })).toHaveTextContent("None — the round needs you"))
      // a scripted pick leaves A's menu mounted: pick from the one B opened
      fireEvent.click(screen.getByRole("button", { name: "Fallback for B" }))
      const menus = await screen.findAllByRole("menu")
      fireEvent.click(within(menus.at(-1)!).getByRole("menuitemradio", { name: /sonnet-5/ }))
      await pick("Fallback for B effort", "max")
      await waitFor(() => expect(screen.getByRole("button", { name: "Fallback for B effort" })).toHaveTextContent("max effort"))
      expect(await saved(calls)).toMatchObject({ verifyFallback: null, verifySecondFallback: { harness: "claude", model: "sonnet-5", effort: "max" } })
    })

    it("has no fallback for B while the second reviewer is off", async () => {
      stubVerification({ ...STATUS_NONE, second: "off" }, FALLBACK)
      mount(<ProjectSettingsSpecimen project={{ ...REVIEWABLE, verifySecond: "off" }} />)
      expect(await screen.findByRole("button", { name: "Fallback for A" })).toBeInTheDocument()
      await waitFor(() => expect(screen.getByRole("button", { name: "Second reviewer" })).toHaveTextContent("Off — one reviewer"))
      expect(screen.queryByRole("button", { name: "Fallback for B" })).toBeNull()
    })
  })

  it("Activate draft activates it, and a refused recipe task says why inline", async () => {
    const calls = stubVerification(STATUS_DRAFT, { autoReview: true }, 409)
    mount(<ProjectSettingsSpecimen project={REVIEWABLE} />)
    fireEvent.click(await screen.findByRole("button", { name: "Activate draft" }))
    await waitFor(() =>
      expect(calls).toContainEqual({ path: "/api/projects/verification/activate", method: "POST", body: { path: "/repo" } }),
    )
    expect(await screen.findByText("Activated recipe 4.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Fix editor" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("already working on this project's verification recipe")
    expect(calls).toContainEqual({
      path: "/api/projects/verification/tasks",
      method: "POST",
      body: { path: "/repo", mode: "fix", area: "editor", harness: "claude", model: "opus-5" },
    })
  })

  it("with a draft waiting, Improve builds on the draft and says whose it is", async () => {
    const calls = stubVerification(STATUS_DRAFT, { autoReview: true, recipeFromDraft: true })
    mount(<ProjectSettingsSpecimen project={REVIEWABLE} />)
    expect((await screen.findByText("tvr3ip")).parentElement).toHaveTextContent("Draft waiting from task tvr3ip")
    expect(screen.getByText(/begins from this draft/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Open its task" })).toBeInTheDocument()
    expect(screen.queryByText(/Recipe updated/)).toBeNull()
    expect(screen.queryByRole("button", { name: "Improve" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Improve on the draft" }))
    expect(await screen.findByText(/starting from the draft from task tvr3ip/)).toBeInTheDocument()
    expect(calls).toContainEqual({
      path: "/api/projects/verification/tasks",
      method: "POST",
      body: { path: "/repo", mode: "improve", harness: "claude", model: "opus-5" },
    })
  })

  it("on an older daemon without features.recipeFromDraft, Improve stays Improve and says it starts from the active recipe", async () => {
    // that daemon sends the draft in its status, but its recipe tasks start from the active recipe
    const calls = stubVerification(STATUS_DRAFT, { autoReview: true })
    mount(<ProjectSettingsSpecimen project={REVIEWABLE} />)
    expect((await screen.findByText("tvr3ip")).parentElement).toHaveTextContent("Draft waiting from task tvr3ip")
    expect(screen.getByText(/begins from the active recipe, not this draft/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Improve on the draft" })).toBeNull()
    expect(screen.getByRole("button", { name: "Activate draft" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Improve" }))
    expect(await screen.findByText("Started Set up verification for sample-app.")).toBeInTheDocument()
    expect(screen.queryByText(/starting from the draft/)).toBeNull()
    expect(calls).toContainEqual({
      path: "/api/projects/verification/tasks",
      method: "POST",
      body: { path: "/repo", mode: "improve", harness: "claude", model: "opus-5" },
    })
  })

  it("hides the draft's Open its task when the recipe task row above opens the same task", async () => {
    stubVerification({ ...STATUS_DRAFT, task: { id: "tvr3ip", mode: "improve", area: null, state: "done", archived: false } }, { autoReview: true, recipeFromDraft: true })
    mount(<ProjectSettingsSpecimen project={REVIEWABLE} />)
    expect(await screen.findByRole("button", { name: "Open task" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Open its task" })).toBeNull()
  })

  it("with no draft waiting, Improve sits beside the active recipe's age", async () => {
    stubVerification({ ...STATUS_DRAFT, draft: null, activatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() })
    mount(<ProjectSettingsSpecimen project={REVIEWABLE} />)
    expect(await screen.findByText("Recipe updated 3d ago")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Improve" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Activate draft" })).toBeNull()
  })
})
