import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { RepoInfo } from "@/lib/types"

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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("project settings remove", () => {
  it("a history-only repo has no unregister control", () => {
    stubApi()
    mount(<ProjectSettingsSpecimen project={HISTORY_ONLY} />)
    expect(screen.queryByRole("button", { name: "Remove from Wisp" })).toBeNull()
  })

  it("unregisters behind a two-click confirm and never fires on the first click", async () => {
    const calls = stubApi()
    mount(<ProjectSettingsSpecimen project={CONFIGURED} />)

    fireEvent.click(screen.getByRole("button", { name: "Remove from Wisp" }))
    expect(calls.some((call) => call.method === "DELETE")).toBe(false)
    expect(screen.getByText("Unregisters this project. Tasks stay; nothing on disk is deleted.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Keep sample-app" }))
    expect(screen.getByRole("button", { name: "Remove from Wisp" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Remove from Wisp" }))
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove sample-app" }))

    await waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true))
    expect(calls.find((call) => call.method === "DELETE")).toEqual({
      path: "/api/projects",
      method: "DELETE",
      body: { path: "/repo" },
    })
  })
})
