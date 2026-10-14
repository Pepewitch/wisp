import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { VerificationStatus } from "../../../shared/api/auto-review"
import { api } from "@/lib/api"
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
    name: "claude", hasModel: true, hasEffort: true, hasImage: true,
    defaults: { model: "opus-5" }, models: { list: ["opus-5", "sonnet-5"], defaultModel: "opus-5", probedAt: "2026-10-12T08:00:00Z" },
  }

  function stubVerification(status: VerificationStatus, features: Record<string, boolean> = { autoReview: true }, tasks = 201) {
    const calls: Call[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input)
        const method = init?.method ?? "GET"
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        calls.push({ path, method, body })
        if (path === "/api/harnesses") return Response.json({ harnesses: [HARNESS], features })
        if (path === "/api/settings") return Response.json({ autoRenameTasksFromPullRequests: true, hiddenModels: {} })
        if (path.startsWith("/api/projects/verification?")) return Response.json(status)
        if (path === "/api/projects/verification/tasks") {
          return tasks === 201
            ? Response.json({ task: { id: "tvr3ip", title: "Set up verification for sample-app" } }, { status: 201 })
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

  it("needs a reviewer agent before it can start one, and saves the choice with Save", async () => {
    const calls = stubVerification(STATUS_NONE)
    mount(<ProjectSettingsSpecimen project={{ ...REVIEWABLE, verify: null }} />)
    const setup = await screen.findByRole("button", { name: "Set up verification" })
    expect(setup).toBeDisabled()
    // a disabled button shows no title: the reason is a line beside it
    expect(screen.getByText(/Choose a reviewer agent first/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Reviewer agent" }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /sonnet-5/ }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Set up verification" })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(calls.some((call) => call.path === "/api/projects" && call.method === "POST")).toBe(true))
    expect(calls.find((call) => call.path === "/api/projects")!.body).toMatchObject({ verify: { harness: "claude", model: "sonnet-5" } })
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
})
