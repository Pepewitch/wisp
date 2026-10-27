import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { clearRememberedAttachments } from "@/lib/attachments"
import { createDesktopTransport } from "@/lib/desktop-transport"
import { clearConnectionDrafts, connectionLocalData } from "@/lib/drafts"
import { savePreferredEffort } from "@/lib/effort"
import type { DaemonTransport } from "@/lib/transport"
import type { HarnessInfo, RepoInfo } from "@/lib/types"
import { sameOriginWebTransport } from "@/lib/web-transport"
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
  hasImage: false,
  defaults: { model: "kimi-k3" },
  models: {
    list: ["kimi-k3"],
    defaultModel: "kimi-k3",
    probedAt: "2026-09-01T00:00:00.000Z",
  },
}

afterEach(() => {
  for (const connectionId of ["test-connection", "another-connection", "local", "remote-fixture"]) {
    clearRememberedAttachments(connectionId)
    clearConnectionDrafts(connectionId)
  }
  vi.unstubAllGlobals()
})

describe("create task drafts", () => {
  const otherRepo: RepoInfo = { ...repo, path: "/other", name: "other" }
  const file = new File(["id,name\n1,a\n"], "orders.csv", { type: "text/csv" })
  const prompt = () => screen.getByPlaceholderText<HTMLTextAreaElement>("What do you want to work on?")
  const draftDialog = (open: boolean, initialRepoPath: string | null, onCreated = vi.fn()) => (
    <CreateTaskDialog
      open={open}
      onOpenChange={() => {}}
      initialRepoPath={initialRepoPath}
      repos={[repo, otherRepo]}
      harnesses={[harness]}
      harnessesError={null}
      onCreated={onCreated}
    />
  )
  const attachFile = async () => {
    fireEvent.change(screen.getByTestId("attach-input"), { target: { files: [file] } })
    await waitFor(() => expect(screen.getByTestId("pending-attachments")).toHaveTextContent("orders.csv"))
  }

  it("restores the unsent composer after closing and keeps each project's contents separate", async () => {
    const upload = vi.fn(async () => ({ uploadId: "test-upload", contentHash: "test-content-hash" }))
    const view = render(draftDialog(true, "/repo"), {
      wrapper: runtimeWrapper(fakeDaemonTransport("test-connection", {
        upload: upload as unknown as DaemonTransport["upload"],
      })),
    })
    fireEvent.change(prompt(), { target: { value: "first project's work" } })
    await attachFile()
    fireEvent.click(screen.getByRole("button", { name: "Worktree" }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "This repo" }))

    view.rerender(draftDialog(false, "/repo"))
    view.rerender(draftDialog(true, "/repo"))
    expect(prompt()).toHaveValue("first project's work")
    expect(screen.getByTestId("pending-attachments")).toHaveTextContent("orders.csv")
    expect(screen.getByRole("button", { name: "This repo" })).toBeInTheDocument()
    expect(upload).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Project" }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "other" }))
    expect(prompt()).toHaveValue("")
    expect(screen.queryByTestId("pending-attachments")).toBeNull()
    expect(screen.getByRole("button", { name: "Worktree" })).toBeInTheDocument()
    fireEvent.change(prompt(), { target: { value: "second project's work" } })

    // The global New task action has no project path: it reopens the last
    // selected project's composer rather than the first project in the list.
    view.rerender(draftDialog(false, null))
    view.rerender(draftDialog(true, null))
    expect(prompt()).toHaveValue("second project's work")
    expect(screen.getByRole("button", { name: "Project" })).toHaveTextContent("other")
    fireEvent.click(screen.getByRole("button", { name: "Project" }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "repo" }))
    expect(prompt()).toHaveValue("first project's work")
    expect(screen.getByTestId("pending-attachments")).toHaveTextContent("orders.csv")
    expect(screen.getByRole("button", { name: "This repo" })).toBeInTheDocument()
    expect(connectionLocalData("test-connection")).toEqual({ drafts: 2, pendingAttachments: 1 })
  })

  it("keeps a refused create for retry, then clears only the submitted project on success", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("try again")).mockResolvedValue({ id: "synthetic-task" })
    const route = ((path: string, init?: unknown) =>
      path === "/api/settings"
        ? Promise.resolve({ hiddenModels: {} })
        : path === "/api/harnesses"
          ? Promise.resolve({ harnesses: [harness], features: {} })
          : request(path, init)) as DaemonTransport["request"]
    const onCreated = vi.fn()
    const view = render(draftDialog(true, "/repo", onCreated), {
      wrapper: runtimeWrapper(fakeDaemonTransport("test-connection", { request: route })),
    })
    fireEvent.click(screen.getByRole("button", { name: "Project" }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "other" }))
    fireEvent.change(prompt(), { target: { value: "other unfinished work" } })
    fireEvent.click(screen.getByRole("button", { name: "Project" }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "repo" }))
    fireEvent.change(prompt(), { target: { value: "keep this if refused" } })
    await attachFile()
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await screen.findByText("Could not reach the daemon")
    view.rerender(draftDialog(false, "/repo", onCreated))
    view.rerender(draftDialog(true, "/repo", onCreated))
    expect(prompt()).toHaveValue("keep this if refused")
    expect(screen.getByTestId("pending-attachments")).toHaveTextContent("orders.csv")

    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("synthetic-task"))
    view.rerender(draftDialog(false, "/repo", onCreated))
    view.rerender(draftDialog(true, "/repo", onCreated))
    expect(prompt()).toHaveValue("")
    expect(screen.queryByTestId("pending-attachments")).toBeNull()
    expect(connectionLocalData("test-connection")).toEqual({ drafts: 1, pendingAttachments: 0 })
    expect(request.mock.calls.filter(([path]) => path === "/api/tasks")).toHaveLength(2)
    expect(request).toHaveBeenLastCalledWith(
      "/api/tasks",
      expect.objectContaining({ body: expect.objectContaining({ prompt: "keep this if refused" }) }),
    )
    fireEvent.click(screen.getByRole("button", { name: "Project" }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "other" }))
    expect(prompt()).toHaveValue("other unfinished work")
  })

  it("does not show another connection's project draft", async () => {
    const first = render(draftDialog(true, "/repo"), {
      wrapper: runtimeWrapper(fakeDaemonTransport("test-connection")),
    })
    fireEvent.change(prompt(), { target: { value: "local work" } })
    await attachFile()
    first.unmount()

    const second = render(draftDialog(true, "/repo"), {
      wrapper: runtimeWrapper(fakeDaemonTransport("another-connection")),
    })
    expect(prompt()).toHaveValue("")
    expect(screen.queryByTestId("pending-attachments")).toBeNull()
    second.unmount()

    render(draftDialog(true, "/repo"), {
      wrapper: runtimeWrapper(fakeDaemonTransport("test-connection")),
    })
    expect(prompt()).toHaveValue("local work")
    expect(screen.getByTestId("pending-attachments")).toHaveTextContent("orders.csv")
  })

  it.each(["browser", "desktop"] as const)("submits a restored file through the %s transport", async (runtime) => {
    const calls: { url: string; body: BodyInit | null | undefined }[] = []
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url)
      if (init?.method === "POST") calls.push({ url: path, body: init.body })
      const response = path.includes("/api/attachments?")
        ? { uploadId: "synthetic-upload", contentHash: "synthetic-hash" }
        : path.endsWith("/api/tasks")
          ? { id: "synthetic-task" }
          : path.endsWith("/api/harnesses")
            ? { harnesses: [harness], features: {} }
            : { hiddenModels: {} }
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }))
    const transport = runtime === "browser"
      ? sameOriginWebTransport
      : createDesktopTransport("http://127.0.0.1:45678/fixture-capability", "remote-fixture", 1)
    const onCreated = vi.fn()
    const view = render(draftDialog(true, "/repo", onCreated), {
      wrapper: runtimeWrapper(transport),
    })
    fireEvent.change(prompt(), { target: { value: "ship a task" } })
    await attachFile()
    view.rerender(draftDialog(false, "/repo", onCreated))
    view.rerender(draftDialog(true, "/repo", onCreated))
    expect(screen.getByTestId("pending-attachments")).toHaveTextContent("orders.csv")
    fireEvent.click(screen.getByRole("button", { name: "Create" }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("synthetic-task"))
    const prefix = runtime === "browser"
      ? ""
      : "http://127.0.0.1:45678/fixture-capability/connections/remote-fixture/1"
    expect(calls.map((call) => call.url)).toEqual([
      `${prefix}/api/attachments?name=orders.csv`,
      `${prefix}/api/tasks`,
    ])
    expect(JSON.parse(String(calls[1]?.body))).toMatchObject({
      repoPath: "/repo",
      prompt: "ship a task",
      attachments: [{ name: "orders.csv", uploadId: "synthetic-upload", contentHash: "synthetic-hash" }],
    })
  })
})

/**
 * Uploading starts before `createTask.isPending` goes true, so the dialog must
 * guard the gap between the first click and the JSON create request. Two
 * clicks must still mean one task.
 */
describe("create task dialog submission", () => {
  /**
   * The composer also READS — the model picker asks /api/settings for the
   * daemon's hidden-model curation, and the autopilot picker asks
   * /api/harnesses whether the daemon has it. Only creates are the subject
   * here, so those reads are answered separately rather than counted as sends.
   */
  async function mountWithRequest(request: ReturnType<typeof vi.fn>) {
    const send = request as unknown as (path: string, init?: unknown) => Promise<unknown>
    const route = ((path: string, init?: unknown) =>
      path === "/api/settings"
        ? Promise.resolve({ autoRenameTasksFromPullRequests: true, hiddenModels: {} })
        : path === "/api/harnesses"
          ? Promise.resolve({ harnesses: [harness], features: {} })
          : send(path, init)) as unknown as DaemonTransport["request"]
    render(
      <CreateTaskDialog
        open
        onOpenChange={() => {}}
        initialRepoPath="/repo"
        repos={[repo]}
        harnesses={[harness]}
        harnessesError={null}
        onCreated={() => {}}
      />,
      {
        wrapper: runtimeWrapper(
          fakeDaemonTransport("test-connection", { request: route }),
        ),
      },
    )
    fireEvent.change(screen.getByPlaceholderText("What do you want to work on?"), {
      target: { value: "reconcile the rows" },
    })
    return await screen.findByRole("button", { name: "Create" })
  }

  it("a second click or ⌘↵ while one create is in flight cannot make a second task", async () => {
    // a create that never settles: the whole window under test is the one
    // between the first click and the daemon answering
    let finish!: (task: { id: string }) => void
    const request = vi.fn(() => new Promise((resolve) => { finish = resolve }))
    const create = await mountWithRequest(request)

    fireEvent.click(create)
    // the second click lands in the same tick, while the encode is still a
    // pending microtask and nothing has reached the daemon yet
    fireEvent.click(create)
    // …and the keyboard path bypasses the button's disabled state entirely
    fireEvent.keyDown(document, { key: "Enter", metaKey: true })

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    expect(create).toBeDisabled()

    // the create is still in flight, so neither route may start another
    fireEvent.click(create)
    fireEvent.keyDown(document, { key: "Enter", metaKey: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(request).toHaveBeenCalledTimes(1)
    finish({ id: "tk9zdy" })
  })

  it("a refused create is retryable: the guard releases on failure too", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("no such project")).mockResolvedValue({ id: "tk9zdy" })
    const create = await mountWithRequest(request)

    fireEvent.click(create)
    await waitFor(() => expect(create).not.toBeDisabled())
    fireEvent.click(create)
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  })

  /**
   * A drop is the third way a file arrives, and it must not be a side door
   * around the attachment contract: the create carries it the same way a
   * pasted or picked file would.
   */
  it("a dropped file becomes a pending row and rides with the create", async () => {
    const request = vi.fn().mockResolvedValue({ id: "tk9zdy" })
    const create = await mountWithRequest(request)
    // the fixture harness has no image capability, so the drop is a text file:
    // pdf, text and video reach every harness by path (A1d)
    const CSV = new TextEncoder().encode("id,name\n1,a\n2,b\n")
    const csvFile = new File([CSV], "orders.csv", { type: "text/csv" })

    fireEvent.drop(screen.getByTestId("create-prompt-field"), {
      dataTransfer: { types: ["Files"], files: [csvFile] },
    })
    await waitFor(() => expect(screen.getByTestId("pending-attachment")).toBeTruthy())
    expect(screen.getByTestId("pending-attachments").textContent).toContain("orders.csv")

    fireEvent.click(create)
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    expect(request).toHaveBeenCalledWith(
      "/api/tasks",
      expect.objectContaining({
        body: expect.objectContaining({
          attachments: [{
            name: "orders.csv",
            uploadId: "test-upload",
            contentHash: "test-content-hash",
          }],
        }),
      }),
    )
  })

  it("a non-file drag is not answered", async () => {
    await mountWithRequest(vi.fn())
    const field = screen.getByTestId("create-prompt-field")
    fireEvent.dragEnter(field, { dataTransfer: { types: ["text/plain"] } })
    expect(field.className).not.toContain("ring-2")
    fireEvent.drop(field, { dataTransfer: { types: ["text/plain"], files: [] } })
    expect(screen.queryByTestId("pending-attachments")).toBeNull()
  })
})

describe("create task dialog layout", () => {
  function mountLayout() {
    render(
      <CreateTaskDialog
        open
        onOpenChange={() => {}}
        initialRepoPath="/repo"
        repos={[repo]}
        harnesses={[harness]}
        harnessesError={null}
        onCreated={() => {}}
      />,
      { wrapper: runtimeWrapper(fakeDaemonTransport()) },
    )
  }

  it("stacks the bar into columns on a narrow modal and one line on a wide one", async () => {
    mountLayout()

    // The switch keys off the modal's own width (@container). Narrow: the
    // choices that shape the task stack in a left column, with Create pinned
    // to the bottom right. Wide: both clusters flatten into a single line.
    const create = await screen.findByRole("button", { name: "Create" })
    const rightCluster = create.parentElement as HTMLElement
    expect(rightCluster).toHaveClass("ml-auto", "flex", "justify-end")
    const bar = rightCluster.parentElement as HTMLElement
    expect(bar).toHaveClass("flex", "@min-[640px]:flex-wrap")
    expect(bar.firstElementChild).toHaveClass("min-w-0", "grow", "flex-col", "@min-[640px]:flex-row")
  })

  it("keeps project, where it runs and its base on the scoping row above the prompt", async () => {
    mountLayout()

    // Project and where the task runs are the two decisions that scope the
    // prompt, so they share the row above it. The path is the project
    // trigger's own parenthetical rather than a column of its own, which is
    // what freed the width for the mode and base pickers.
    const project = await screen.findByRole("button", { name: "Project" })
    expect(project).toHaveTextContent("repo")
    expect(project).toHaveTextContent("(/repo)")
    const row = project.parentElement as HTMLElement
    expect(row).toContainElement(screen.getByRole("button", { name: "Worktree" }))
    expect(row).toContainElement(screen.getByRole("button", { name: /Base/ }))
  })
})

/**
 * The composer's per-task base. It exists for the deliberate case — stack
 * this task on a feature branch, target a release line — so its resting
 * state has to read as "the project decides", not as an empty required field.
 */
describe("create task dialog base", () => {
  function mount() {
    render(
      <CreateTaskDialog
        open
        onOpenChange={() => {}}
        initialRepoPath="/repo"
        repos={[repo]}
        harnesses={[harness]}
        harnessesError={null}
        onCreated={() => {}}
      />,
      { wrapper: runtimeWrapper(fakeDaemonTransport()) },
    )
  }

  it("rests on the project's base and offers an override", async () => {
    mount()
    // labelled "Base", never a resolved ref: the composer cannot know what
    // origin/HEAD points at, and the daemon only resolves it after fetching
    const picker = await screen.findByRole("button", { name: /Base/ })
    fireEvent.click(picker)
    expect(await screen.findByRole("menuitemradio", { name: /Project default/ })).toBeInTheDocument()
    // an action inside a radio group is itself a radio item — see MENU_ACTION
    expect(screen.getByRole("menuitemradio", { name: "Start from another ref…" })).toBeInTheDocument()
  })

  it("is absent for a local task, which has nothing to fork", async () => {
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "Worktree" }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "This repo" }))
    await screen.findByRole("button", { name: "This repo" })
    expect(screen.queryByRole("button", { name: /^Base$/ })).toBeNull()
  })
})

describe("auto-merge and auto-fix at creation", () => {
  function mount(features: Record<string, boolean>) {
    const sent: { path: string; body: unknown }[] = []
    const request = ((path: string, init?: { body?: unknown }) => {
      if (path === "/api/settings") return Promise.resolve({ autoRenameTasksFromPullRequests: true, hiddenModels: {} })
      if (path === "/api/harnesses") return Promise.resolve({ harnesses: [harness], features })
      sent.push({ path, body: init?.body })
      return Promise.resolve({ id: "tk9zdy" })
    }) as unknown as DaemonTransport["request"]
    render(
      <CreateTaskDialog
        open
        onOpenChange={() => {}}
        initialRepoPath="/repo"
        repos={[repo]}
        harnesses={[harness]}
        harnessesError={null}
        onCreated={() => {}}
      />,
      { wrapper: runtimeWrapper(fakeDaemonTransport("test-connection", { request })) },
    )
    fireEvent.change(screen.getByPlaceholderText("What do you want to work on?"), { target: { value: "ship the fix" } })
    return sent
  }

  it("arms the task's PR from the start, and says which switches are on", async () => {
    const sent = mount({ taskAutopilot: true })
    fireEvent.click(await screen.findByRole("button", { name: "Manual PR" }))
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Auto-merge" }))
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Auto-fix" }))
    expect(await screen.findByRole("button", { name: "Auto-merge + fix" })).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]!.body).toMatchObject({ mode: "worktree", autopilot: { autoMerge: true, autoFix: true } })
  })

  it("sends nothing to arm when both are off, and is not offered for a local task or an older daemon", async () => {
    const sent = mount({ taskAutopilot: true })
    fireEvent.click(await screen.findByRole("button", { name: "Create" }))
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]!.body).not.toHaveProperty("autopilot")
    fireEvent.click(screen.getByRole("button", { name: "Worktree" }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "This repo" }))
    await screen.findByRole("button", { name: "This repo" })
    expect(screen.queryByRole("button", { name: "Manual PR" })).toBeNull()
  })

  it("is absent on a daemon that predates it", async () => {
    mount({})
    await screen.findByRole("button", { name: "Worktree" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByRole("button", { name: "Manual PR" })).toBeNull()
  })
  it("offers auto-review on a daemon that has it, and sends it only when it is on", async () => {
    const sent = mount({ taskAutopilot: true, autoReview: true })
    fireEvent.click(await screen.findByRole("button", { name: "Manual PR" }))
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Auto-merge" }))
    expect(await screen.findByRole("button", { name: "Auto-merge" })).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(sent).toHaveLength(1))
    // off: the field is left out, so nothing new reaches the daemon
    expect(sent[0]!.body).toMatchObject({ autopilot: { autoMerge: true, autoFix: false } })
    expect((sent[0]!.body as { autopilot: object }).autopilot).not.toHaveProperty("autoReview")
  })

  it("sends autoReview: true once it is switched on, labelled with the rest", async () => {
    const sent = mount({ taskAutopilot: true, autoReview: true })
    fireEvent.click(await screen.findByRole("button", { name: "Manual PR" }))
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Auto-review" }))
    expect(await screen.findByRole("button", { name: "Auto-review" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Auto-merge" }))
    expect(await screen.findByRole("button", { name: "Auto-merge + review" })).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]!.body).toMatchObject({ autopilot: { autoMerge: true, autoFix: false, autoReview: true } })
  })

  it("has no auto-review switch on a daemon without features.autoReview", async () => {
    mount({ taskAutopilot: true })
    fireEvent.click(await screen.findByRole("button", { name: "Manual PR" }))
    await screen.findByRole("menuitemcheckbox", { name: "Auto-merge" })
    expect(screen.queryByRole("menuitemcheckbox", { name: "Auto-review" })).toBeNull()
  })
})

/**
 * The effort star seeds a fresh dialog, or a switch to that model, with one
 * level per harness · model. It never changes a level already in the composer.
 */
describe("preferred effort", () => {
  const levels = ["low", "medium", "high", "max"]
  const effortHarness = (name: string, models: string[], reasoningEffort?: string): HarnessInfo => ({
    name,
    hasModel: true,
    hasEffort: true,
    hasImage: false,
    defaults: { model: models[0], ...(reasoningEffort ? { reasoningEffort } : {}) },
    models: { list: models, defaultModel: models[0] ?? null, probedAt: "2026-09-01T00:00:00.000Z" },
    effortLevels: levels,
  })
  // the same model id on two harnesses: a star must not cross from one to the other
  const effortHarnesses = [effortHarness("claude", ["opus", "sonnet"], "medium"), effortHarness("droid", ["opus"])]
  const sent: Record<string, unknown>[] = []

  afterEach(() => {
    localStorage.clear()
    sent.length = 0
  })

  function mount(list = effortHarnesses) {
    const request = ((path: string, init?: { body?: Record<string, unknown> }) => {
      if (path === "/api/settings") return Promise.resolve({ hiddenModels: {} })
      if (path === "/api/harnesses") return Promise.resolve({ harnesses: list, features: {} })
      if (path === "/api/tasks") sent.push(init?.body ?? {})
      return Promise.resolve({ id: "synthetic-task" })
    }) as unknown as DaemonTransport["request"]
    return render(
      <CreateTaskDialog
        open
        onOpenChange={() => {}}
        initialRepoPath="/repo"
        repos={[repo]}
        harnesses={list}
        harnessesError={null}
        onCreated={() => {}}
      />,
      { wrapper: runtimeWrapper(fakeDaemonTransport("test-connection", { request })) },
    )
  }
  const effortButton = (level: string) => screen.findByRole("button", { name: level })
  const closeMenu = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
  async function pickModel(harnessName: string, model: string) {
    fireEvent.click(await screen.findByRole("button", { name: /^(claude|droid)\b/ }))
    const group = await screen.findByRole("group", { name: harnessName })
    fireEvent.click(within(group).getByRole("menuitemradio", { name: new RegExp(`^${model}`) }))
    closeMenu()
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
  }
  async function create(count: number) {
    fireEvent.change(screen.getByPlaceholderText("What do you want to work on?"), {
      target: { value: `task ${count}` },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(sent).toHaveLength(count))
  }

  it("a star seeds the next dialog, not the open one", async () => {
    const first = mount()
    fireEvent.click(await effortButton("medium"))
    const star = await screen.findByRole("button", { name: "Prefer effort high for claude · opus" })
    expect(star).toHaveAttribute("aria-pressed", "false")
    fireEvent.click(star)
    expect(
      screen.getByRole("button", { name: "Clear preferred effort high for claude · opus" }),
    ).toHaveAttribute("aria-pressed", "true")
    closeMenu()
    expect(await effortButton("medium")).toBeInTheDocument()
    await create(1)
    expect(sent[0]).toMatchObject({ harness: "claude", model: "opus", effort: "medium" })

    first.unmount()
    mount()
    expect(await effortButton("high")).toBeInTheDocument()
    await create(2)
    expect(sent[1]).toMatchObject({ harness: "claude", model: "opus", effort: "high" })
  })

  it("a model switch takes that pair's star, else the harness default, and switching back restores it", async () => {
    savePreferredEffort("test-connection", {}, "claude", "opus", "high")
    mount()
    expect(await effortButton("high")).toBeInTheDocument()

    await pickModel("claude", "sonnet")
    expect(await effortButton("medium")).toBeInTheDocument()

    // droid · opus is another pair: no star, and droid configures no default
    await pickModel("droid", "opus")
    expect(await effortButton("Effort")).toBeInTheDocument()
    fireEvent.click(await effortButton("Effort"))
    fireEvent.click(await screen.findByRole("button", { name: "Prefer effort low for droid · opus" }))
    expect(screen.getByRole("button", { name: "Prefer effort high for droid · opus" })).toHaveAttribute(
      "aria-pressed",
      "false",
    )
    closeMenu()

    await pickModel("claude", "opus")
    expect(await effortButton("high")).toBeInTheDocument()
    await pickModel("claude", "sonnet")
    expect(await effortButton("medium")).toBeInTheDocument()
    await pickModel("droid", "opus")
    expect(await effortButton("low")).toBeInTheDocument()
  })

  it("never overwrites a level picked by hand, and the filled star clears it", async () => {
    savePreferredEffort("test-connection", {}, "claude", "opus", "high")
    const first = mount()
    fireEvent.click(await effortButton("high"))
    // a radio row keeps its menu open, so the star sits right beside the pick
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /^max/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Prefer effort low for claude · opus" }))
    // one star per pair: starring low moved it off high
    expect(screen.getByRole("button", { name: "Prefer effort high for claude · opus" })).toHaveAttribute(
      "aria-pressed",
      "false",
    )
    fireEvent.click(screen.getByRole("button", { name: "Clear preferred effort low for claude · opus" }))
    expect(screen.queryByRole("button", { name: /^Clear preferred effort/ })).toBeNull()
    closeMenu()
    expect(await effortButton("max")).toBeInTheDocument()
    await create(1)
    expect(sent[0]).toMatchObject({ effort: "max" })

    first.unmount()
    mount()
    expect(await effortButton("medium")).toBeInTheDocument()
  })

  it("ignores a star the harness no longer offers, and does not send it", async () => {
    savePreferredEffort("test-connection", {}, "claude", "opus", "ultra")
    mount()
    expect(await effortButton("medium")).toBeInTheDocument()
    fireEvent.click(await effortButton("medium"))
    expect(await screen.findByRole("menuitemradio", { name: /^high/ })).toBeInTheDocument()
    expect(screen.queryByRole("menuitemradio", { name: /^ultra/ })).toBeNull()
    closeMenu()
    await create(1)
    expect(sent[0]).toMatchObject({ harness: "claude", model: "opus", effort: "medium" })
  })
})
