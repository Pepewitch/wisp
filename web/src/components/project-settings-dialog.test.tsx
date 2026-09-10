import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { api } from "@/lib/api"
import type { RepoInfo } from "@/lib/types"
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
