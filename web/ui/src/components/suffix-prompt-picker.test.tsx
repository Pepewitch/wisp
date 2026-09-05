import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState, type ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { HarnessInfo, RepoInfo, SuffixPrompt } from "@/lib/types"

import { CreateTaskDialog } from "./create-task-dialog"
import { SuffixPromptPicker } from "./suffix-prompt-picker"

interface Call {
  path: string
  method: string
  body: unknown
}

const SAVED: SuffixPrompt = {
  id: "suffix-review",
  name: "Intensive review",
  prompt: "Inspect correctness and security.",
  createdAt: "2026-09-01T00:00:00.000Z",
}

function stubApi(initial: SuffixPrompt[] = []): Call[] {
  const calls: Call[] = []
  let prompts = [...initial]
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      const method = init?.method ?? "GET"
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ path, method, body })
      if (path === "/api/suffix-prompts" && method === "GET") {
        return Response.json({ suffixPrompts: prompts })
      }
      if (path === "/api/suffix-prompts" && method === "POST") {
        const fields = body as { name: string; prompt: string }
        const saved = { ...SAVED, id: "suffix-created", name: fields.name, prompt: fields.prompt }
        prompts = [...prompts, saved]
        return Response.json(saved, { status: 201 })
      }
      if (path.startsWith("/api/suffix-prompts/") && method === "PATCH") {
        const id = path.slice("/api/suffix-prompts/".length)
        const existing = prompts.find((prompt) => prompt.id === id)
        if (!existing) return Response.json({ error: `no such suffix prompt: ${id}` }, { status: 404 })
        const fields = body as { name: string; prompt: string }
        const saved = { ...existing, name: fields.name, prompt: fields.prompt }
        prompts = prompts.map((prompt) => (prompt.id === id ? saved : prompt))
        return Response.json(saved)
      }
      if (path.startsWith("/api/suffix-prompts/") && method === "DELETE") {
        const id = path.slice("/api/suffix-prompts/".length)
        if (!prompts.some((prompt) => prompt.id === id)) {
          return Response.json({ error: `no such suffix prompt: ${id}` }, { status: 404 })
        }
        prompts = prompts.filter((prompt) => prompt.id !== id)
        return Response.json({ ok: true })
      }
      if (path === "/api/tasks" && method === "POST") {
        return Response.json({ id: "task1" }, { status: 201 })
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
  localStorage.clear()
})

describe("suffix prompt picker", () => {
  it("defaults to none, selects without touching the draft, and creates then selects a saved prompt", async () => {
    const calls = stubApi([SAVED])

    function Harness() {
      const [value, setValue] = useState<string | null>(null)
      const [draft, setDraft] = useState("https://github.com/acme/repo/pull/42")
      return (
        <>
          <textarea aria-label="Draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
          <SuffixPromptPicker value={value} onValueChange={setValue} />
        </>
      )
    }

    mount(<Harness />)
    const draft = screen.getByLabelText("Draft") as HTMLTextAreaElement
    const trigger = screen.getByRole("button", { name: "Suffix prompt" })
    fireEvent.click(trigger)

    expect(await screen.findByText("No suffix prompt")).toBeInTheDocument()
    fireEvent.click(await screen.findByText("Intensive review"))
    expect(screen.getByRole("button", { name: "Intensive review" })).toBeInTheDocument()
    expect(draft.value).toBe("https://github.com/acme/repo/pull/42")

    fireEvent.click(await screen.findByText("Create a new prompt"))
    const dialog = await screen.findByTestId("create-suffix-prompt-dialog")
    expect(dialog).toBeInTheDocument()
    expect(screen.queryByRole("menu")).toBeNull()
    expect(screen.getByTestId("create-suffix-prompt-backdrop")).toHaveClass("z-(--z-nested-backdrop)")
    expect(dialog).toHaveClass("z-(--z-nested-modal)")

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Review loop  " } })
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "  Review, fix, repeat.  " } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(screen.queryByTestId("create-suffix-prompt-dialog")).toBeNull())
    expect(screen.getByRole("button", { name: "Review loop" })).toBeInTheDocument()
    expect(draft.value).toBe("https://github.com/acme/repo/pull/42")
    expect(calls.find((call) => call.method === "POST")).toEqual({
      path: "/api/suffix-prompts",
      method: "POST",
      body: { name: "Review loop", prompt: "Review, fix, repeat." },
    })
  })

  it("edits a saved prompt from its row and keeps the selection pointing at it", async () => {
    const calls = stubApi([SAVED])

    function Harness() {
      const [value, setValue] = useState<string | null>(SAVED.id)
      return <SuffixPromptPicker value={value} onValueChange={setValue} />
    }

    mount(<Harness />)
    // the list loads when the menu opens; only then can the trigger name the selection
    fireEvent.click(screen.getByRole("button", { name: "Suffix prompt" }))
    await screen.findByRole("button", { name: "Intensive review" })

    fireEvent.click(await screen.findByRole("button", { name: "Edit suffix prompt Intensive review" }))
    const dialog = await screen.findByTestId("create-suffix-prompt-dialog")
    expect(dialog).toHaveTextContent("Edit suffix prompt")
    // the menu closes so the nested dialog has the stage to itself
    expect(screen.queryByRole("menu")).toBeNull()
    expect(screen.getByLabelText("Name")).toHaveValue("Intensive review")
    expect(screen.getByLabelText("Prompt")).toHaveValue("Inspect correctness and security.")

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Deep review" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(screen.queryByTestId("create-suffix-prompt-dialog")).toBeNull())
    expect(calls.find((call) => call.method === "PATCH")).toEqual({
      path: "/api/suffix-prompts/suffix-review",
      method: "PATCH",
      body: { name: "Deep review", prompt: "Inspect correctness and security." },
    })
    // the selection survived the rename because the id did
    expect(screen.getByRole("button", { name: "Deep review" })).toBeInTheDocument()
  })

  it("deletes behind a two-click inline confirm, and a deleted selection falls back to none", async () => {
    const calls = stubApi([SAVED])

    function Harness() {
      const [value, setValue] = useState<string | null>(SAVED.id)
      return <SuffixPromptPicker value={value} onValueChange={setValue} />
    }

    mount(<Harness />)
    // the list loads when the menu opens; only then can the trigger name the selection
    fireEvent.click(screen.getByRole("button", { name: "Suffix prompt" }))
    await screen.findByRole("button", { name: "Intensive review" })

    // one click arms, never deletes
    fireEvent.click(await screen.findByRole("button", { name: "Delete suffix prompt Intensive review" }))
    expect(calls.some((call) => call.method === "DELETE")).toBe(false)

    // backing out restores the row's plain actions
    fireEvent.click(await screen.findByRole("button", { name: "Keep Intensive review" }))
    expect(await screen.findByRole("button", { name: "Delete suffix prompt Intensive review" })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Delete suffix prompt Intensive review" }))
    fireEvent.click(await screen.findByRole("button", { name: "Confirm delete Intensive review" }))

    await waitFor(() =>
      expect(screen.queryByRole("menuitemradio", { name: "Intensive review" })).toBeNull(),
    )
    expect(calls.find((call) => call.method === "DELETE")).toEqual({
      path: "/api/suffix-prompts/suffix-review",
      method: "DELETE",
      body: undefined,
    })
    expect(screen.getByRole("button", { name: "Suffix prompt" })).toBeInTheDocument()
  })
})

describe("create-task suffix integration", () => {
  const repo: RepoInfo = {
    path: "/repo",
    name: "repo",
    exists: true,
    setupScript: "",
    archiveScript: "",
    copyFiles: [],
    configured: true,
  }
  const harness: HarnessInfo = {
    name: "droid",
    hasModel: true,
    hasEffort: true,
    hasImage: false,
    effortLevels: ["high"],
    defaults: { model: "kimi-k3", reasoningEffort: "high" },
    models: {
      list: ["kimi-k3"],
      defaultModel: "kimi-k3",
      probedAt: "2026-09-01T00:00:00.000Z",
    },
  }

  it("sends the suffix id, while the nested modal suspends the outer ⌘↵ shortcut", async () => {
    const calls = stubApi([])
    const onCreated = vi.fn()
    mount(
      <CreateTaskDialog
        open
        onOpenChange={() => {}}
        initialRepoPath="/repo"
        repos={[repo]}
        harnesses={[harness]}
        harnessesError={null}
        onCreated={onCreated}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText("What do you want to work on?"), {
      target: { value: "Review this PR" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Suffix prompt" }))
    fireEvent.click(await screen.findByText("Create a new prompt"))

    fireEvent.keyDown(document, { key: "Enter", metaKey: true })
    expect(calls.some((call) => call.path === "/api/tasks")).toBe(false)
    expect(screen.getByTestId("create-suffix-prompt-dialog")).toBeInTheDocument()
    expect(screen.queryByRole("menu")).toBeNull()
    expect(screen.getByTestId("create-suffix-prompt-backdrop")).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Intensive review" } })
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Inspect correctness and security." },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await screen.findByRole("button", { name: "Intensive review" })

    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("task1"))
    expect(calls.find((call) => call.path === "/api/tasks")).toEqual({
      path: "/api/tasks",
      method: "POST",
      body: {
        repoPath: "/repo",
        prompt: "Review this PR",
        harness: "droid",
        model: "kimi-k3",
        mode: "worktree",
        effort: "high",
        suffixPromptId: "suffix-created",
      },
    })
  })
})
