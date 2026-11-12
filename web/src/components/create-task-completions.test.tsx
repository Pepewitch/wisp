import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ProjectEntriesResponse } from "../../../shared/api/project-entries"
import { ApiError } from "@/lib/api"
import { clearRememberedAttachments } from "@/lib/attachments"
import { clearConnectionDrafts } from "@/lib/drafts"
import type { DaemonTransport } from "@/lib/transport"
import type { HarnessInfo, RepoInfo, TaskSkills } from "@/lib/types"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { CreateTaskDialog } from "./create-task-dialog"

/**
 * The create composer's `@` list and `/` palette, end to end through the real
 * dialog: the first task you describe is the one most likely to name a file or
 * ask for a skill, so both lists work here exactly as they do in the steer
 * box. The ranking, the index arithmetic and the key rules are the steer
 * box's own tests (`steer-mentions`, `slash-palette`); what is pinned here is
 * that this composer is wired to them, and what is different because no task
 * exists yet.
 */

const repo: RepoInfo = {
  path: "/work/wisp",
  name: "wisp",
  exists: true,
  setupScript: "",
  archiveScript: "",
  copyFiles: [],
  baseBranch: "",
  configured: true,
}

const harness: HarnessInfo = {
  name: "claude",
  hasModel: true,
  hasEffort: false,
  hasImage: true,
  defaults: { model: "claude-sonnet-4-6" },
  models: { list: ["claude-sonnet-4-6"], defaultModel: "claude-sonnet-4-6", probedAt: "2026-09-01T00:00:00.000Z" },
}

const SKILLS: TaskSkills = {
  skills: [
    { name: "code-review", description: "Review the pending changes" },
    { name: "security-review", description: "Security review of the branch" },
  ],
  commands: [
    { name: "release", description: "Prepare a release", argumentHint: "[version]", executable: false },
  ],
  commandError: null,
  errors: [],
  partialNote: null,
  invoke: "slash",
  probedAt: "2026-09-01T00:00:00.000Z",
  cached: false,
}

const listing: ProjectEntriesResponse = {
  project: "/work/wisp",
  dir: "",
  truncated: false,
  incompleteAfter: null,
  entries: [
    { name: "src", kind: "dir" },
    { name: "README.md", kind: "file" },
  ],
}

afterEach(() => {
  clearRememberedAttachments("test-connection")
  clearConnectionDrafts("test-connection")
})

/** The daemon the dialog talks to: projects, their files, and a project's registry. */
function mount({
  skills = SKILLS,
  skillsError = null,
  projectSkills = true,
}: { skills?: TaskSkills; skillsError?: ApiError | null; projectSkills?: boolean } = {}) {
  const paths: string[] = []
  const request: DaemonTransport["request"] = async <T,>(path: string) => {
    paths.push(path)
    if (path === "/api/repos") return { repos: [repo] } as T
    if (path.startsWith("/api/harnesses")) {
      return { features: { projectSkills }, harnesses: [harness] } as T
    }
    if (path.startsWith("/api/projects/entries?")) return listing as T
    if (path.startsWith("/api/projects/skills?")) {
      if (skillsError) throw skillsError
      return skills as T
    }
    throw new ApiError("not found", 404)
  }
  render(
    <CreateTaskDialog
      open
      onOpenChange={() => {}}
      initialRepoPath={repo.path}
      repos={[repo]}
      harnesses={[harness]}
      harnessesError={null}
      onCreated={vi.fn()}
    />,
    { wrapper: runtimeWrapper(fakeDaemonTransport("test-connection", { request })) },
  )
  return paths
}

function box(): HTMLTextAreaElement {
  return screen.getByPlaceholderText("What do you want to work on?") as HTMLTextAreaElement
}

function type(text: string, caret = text.length) {
  fireEvent.change(box(), { target: { value: text, selectionStart: caret } })
}

function key(name: string, init: Partial<KeyboardEventInit> = {}) {
  fireEvent.keyDown(box(), { key: name, ...init })
}

function rows(testid: string): string[] {
  return within(screen.getByTestId(testid))
    .queryAllByRole("option")
    .map((option) => option.textContent ?? "")
}

describe("the create composer's completions", () => {
  it("lists projects on `@` and asks for a project's files once it is opened", async () => {
    const paths = mount()
    expect(paths).not.toContain("/api/repos")

    type("look at @wi")
    await screen.findByTestId("mention-list")
    expect(paths).toContain("/api/repos")
    expect(rows("mention-list")).toHaveLength(1)
    expect(rows("mention-list")[0]).toContain("wisp")

    key("Tab") // open the project; its root is the daemon's to list
    await waitFor(() => expect(rows("mention-list")).toHaveLength(2))
    expect(box().value).toBe("look at @wisp/")
    expect(rows("mention-list").join(" ")).toContain("README.md")
  })

  it("a pick writes the file's absolute path over the `@` word", async () => {
    mount()
    type("look at @wisp/")
    await waitFor(() => expect(rows("mention-list")).toHaveLength(2))

    key("ArrowDown") // src, then README.md
    key("Enter")
    await waitFor(() => expect(box().value).toBe("look at /work/wisp/README.md "))
    expect(screen.queryByTestId("mention-list")).toBeNull()
  })

  it("asks for the project's registry only once `/` opens the palette, and prefills a pick", async () => {
    const paths = mount()
    expect(paths.some((path) => path.startsWith("/api/projects/skills?"))).toBe(false)

    type("/sec")
    const palette = await screen.findByTestId("slash-palette")
    expect(paths.filter((path) => path.startsWith("/api/projects/skills?"))).toEqual([
      "/api/projects/skills?project=%2Fwork%2Fwisp&harness=claude",
    ])
    await waitFor(() => expect(within(palette).getAllByRole("option").length).toBeGreaterThan(0))
    // the name you typed wins: `/security-review`, not `/code-review`
    expect(palette.querySelector('[aria-selected="true"]')?.textContent).toContain("security-review")

    key("Enter")
    expect(box().value).toBe("/security-review")
    expect(screen.queryByTestId("slash-palette")).toBeNull()
  })

  it("offers the project's custom commands, with the harness's own argument hint", async () => {
    mount()
    type("/rel")
    const palette = await screen.findByTestId("slash-palette")
    await waitFor(() => expect(within(palette).getAllByRole("option").length).toBeGreaterThan(0))
    expect(palette.textContent).toContain("Prepare a release")
    expect(palette.textContent).toContain("[version]")

    key("Enter")
    expect(box().value).toBe("/release ") // the hint says it takes an argument, so the caret lands after a space
  })

  it("never offers a tier that needs a task: no /status, no /archive, no tools", async () => {
    mount()
    type("/")
    const palette = await screen.findByTestId("slash-palette")
    await waitFor(() => expect(within(palette).getAllByRole("option").length).toBeGreaterThan(0))
    const names = rows("slash-palette").join(" ")
    expect(names).toContain("/code-review")
    expect(names).not.toContain("/status")
    expect(names).not.toContain("/archive")
    expect(names).not.toContain("/terminal")
  })

  it("Escape closes the palette and keeps the draft, rather than closing the dialog", async () => {
    const onOpenChange = vi.fn()
    const request: DaemonTransport["request"] = async <T,>(path: string) => {
      if (path === "/api/repos") return { repos: [repo] } as T
      if (path.startsWith("/api/harnesses")) return { features: { projectSkills: true }, harnesses: [harness] } as T
      if (path.startsWith("/api/projects/skills?")) return SKILLS as T
      throw new ApiError("not found", 404)
    }
    render(
      <CreateTaskDialog
        open
        onOpenChange={onOpenChange}
        initialRepoPath={repo.path}
        repos={[repo]}
        harnesses={[harness]}
        harnessesError={null}
        onCreated={vi.fn()}
      />,
      { wrapper: runtimeWrapper(fakeDaemonTransport("test-connection", { request })) },
    )
    type("/code")
    await screen.findByTestId("slash-palette")
    key("Escape")
    expect(screen.queryByTestId("slash-palette")).toBeNull()
    expect(box().value).toBe("/code") // the palette never deletes typed text
    expect(onOpenChange).not.toHaveBeenCalled()

    // with nothing floating, Escape is the dialog's again
    key("Escape")
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.objectContaining({ reason: "escape-key" }))
  })

  it("says why a registry could not be read, instead of an empty list", async () => {
    mount({ skillsError: new ApiError("no session yet — the first turn creates one", 409) })
    type("/")
    const palette = await screen.findByTestId("slash-palette")
    await waitFor(() => expect(palette.textContent).toContain("no session yet"))
    expect(within(palette).queryAllByRole("option")).toHaveLength(0)
  })

  it("opens no palette at all on a daemon with no project registry", async () => {
    const paths = mount({ projectSkills: false })
    await waitFor(() => expect(paths.some((path) => path.startsWith("/api/harnesses"))).toBe(true))
    type("/")
    expect(screen.queryByTestId("slash-palette")).toBeNull()
    expect(paths.some((path) => path.startsWith("/api/projects/skills?"))).toBe(false)
  })
})
