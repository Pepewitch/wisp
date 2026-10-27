import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import type { ProjectEntriesResponse } from "../../../shared/api/project-entries"
import { ApiError } from "@/lib/api"
import type { DaemonTransport } from "@/lib/transport"
import type { ApiTask, RepoInfo } from "@/lib/types"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { SteerBox } from "./steer-box"

/**
 * The composer's `@` list, end to end through the real SteerBox: what opens
 * it (an `@` that starts a word, nothing else), what the keys do, what a pick
 * writes, and that a closed list leaves Enter to send. The ranking and the
 * index arithmetic are lib/mentions.test.ts's.
 */

const task = (): ApiTask =>
  ({
    id: "tk9zdy",
    title: "steer",
    repo_path: "/work/wisp",
    worktree_path: "/home/.wisp/worktrees/wisp-tk9zdy",
    branch: "wisp/tk9zdy-steer",
    base_commit: "8f2a1c9",
    harness: "claude",
    model: "claude-sonnet-4-6",
    effort: null,
    slot: 1,
    state: "done",
    state_detail: null,
    session_id: null,
    seq: 4,
    turn_count: 3,
    archived: false,
    mode: "worktree",
    created_at: "2026-08-30T00:00:00Z",
    updated_at: "2026-08-30T00:00:00Z",
  }) as ApiTask

const repo = (name: string, path: string, exists = true): RepoInfo =>
  ({ name, path, exists, setupScript: "", archiveScript: "", copyFiles: [], baseBranch: "", configured: true }) as RepoInfo

const REPOS = [
  repo("wisp", "/work/wisp"),
  repo("superapp", "/work/superapp"),
  repo("gone", "/work/gone", false),
  repo("app", "/work/app"),
  repo("app", "/work/other/app"),
  repo("slow", "/work/slow"),
]

const listing = (project: string, dir: string, entries: ProjectEntriesResponse["entries"]): ProjectEntriesResponse => ({
  project,
  dir,
  truncated: false,
  incompleteAfter: null,
  entries,
})

/** Keyed `<project>|<dir>`; the fake daemon applies `q` the way the real one does. */
const LISTINGS: Record<string, ProjectEntriesResponse> = {
  "/work/superapp|": listing("/work/superapp", "", [
    { name: "My Docs", kind: "dir" },
    { name: "src", kind: "dir" },
    { name: "README.md", kind: "file" },
  ]),
  "/work/superapp|src": listing("/work/superapp", "src", [
    { name: "components", kind: "dir" },
    { name: "config.ts", kind: "file" },
  ]),
  "/work/superapp|My Docs": listing("/work/superapp", "My Docs", [{ name: "guide.md", kind: "file" }]),
  "/work/other/app|": listing("/work/other/app", "", [{ name: "lib", kind: "dir" }]),
  "/work/superapp|vendor": { ...listing("/work/superapp", "vendor", [{ name: "a.js", kind: "file" }]), incompleteAfter: 5000 },
}

function mount(node: ReactNode) {
  const paths: string[] = []
  const request: DaemonTransport["request"] = async <T,>(path: string) => {
    paths.push(path)
    if (path === "/api/repos") return { repos: REPOS } as T
    if (path.startsWith("/api/projects/entries?")) {
      const query = new URLSearchParams(path.slice(path.indexOf("?") + 1))
      if (query.get("project") === "/work/slow") return new Promise<T>(() => {})
      const found = LISTINGS[`${query.get("project")}|${query.get("dir") ?? ""}`]
      if (!found) throw new ApiError("no such folder", 404)
      const q = (query.get("q") ?? "").toLowerCase()
      return { ...found, entries: found.entries.filter((entry) => entry.name.toLowerCase().includes(q)) } as T
    }
    throw new ApiError("not found", 404)
  }
  render(node, { wrapper: runtimeWrapper(fakeDaemonTransport("test-connection", { request })) })
  return paths
}

function box(): HTMLTextAreaElement {
  return screen.getByPlaceholderText("Ask for changes, or / for commands") as HTMLTextAreaElement
}

function type(text: string, caret = text.length) {
  fireEvent.change(box(), { target: { value: text, selectionStart: caret } })
}

function key(name: string, init: Partial<KeyboardEventInit> = {}) {
  fireEvent.keyDown(box(), { key: name, ...init })
}

function options(): string[] {
  return within(screen.getByTestId("mention-list"))
    .queryAllByRole("option")
    .map((option) => option.textContent ?? "")
}

function selectedOption(): string | null {
  return screen.getByTestId("mention-list").querySelector('[aria-selected="true"]')?.textContent ?? null
}

describe("the @ list", () => {
  it("lists existing projects with their paths, and does not ask until an @ is typed", async () => {
    const paths = mount(<SteerBox task={task()} onSend={async () => {}} />)
    expect(paths).not.toContain("/api/repos")
    type("@")
    await waitFor(() => expect(options()).toHaveLength(5))
    expect(options().slice(0, 2)).toEqual(["wisp/work/wisp", "superapp/work/superapp"])
    expect(box()).toHaveAttribute("aria-controls", "composer-mention-list")
    expect(box()).toHaveAttribute("aria-activedescendant", "composer-mention-list-0")
  })

  it("filters as you type and moves with ↑/↓; Enter inserts the highlighted project's path", async () => {
    mount(<SteerBox task={task()} onSend={async () => {}} />)
    type("check @")
    await waitFor(() => expect(options()).toHaveLength(5))
    key("ArrowDown")
    expect(selectedOption()).toBe("superapp/work/superapp")
    key("ArrowUp")
    expect(selectedOption()).toBe("wisp/work/wisp")
    type("check @sup")
    expect(options()).toEqual(["superapp/work/superapp"])
    key("Enter")
    expect(box()).toHaveValue("check /work/superapp ")
    expect(screen.queryByTestId("mention-list")).toBeNull()
  })

  it("Tab, → at the end of the word, and `/` after a name open the highlighted project", async () => {
    mount(<SteerBox task={task()} onSend={async () => {}} />)
    for (const opener of ["Tab", "ArrowRight", "/"]) {
      type("@supe")
      await waitFor(() => expect(options()).toEqual(["superapp/work/superapp"]))
      key(opener)
      expect(box(), opener).toHaveValue("@superapp/")
      await waitFor(() => expect(options()).toEqual(["My Docs/", "src/", "README.md"]))
    }
  })

  it("→ in the middle of the word and `/` right after the @ only move and type", async () => {
    mount(<SteerBox task={task()} onSend={async () => {}} />)
    type("@supe", 2)
    await waitFor(() => expect(options()).toHaveLength(1))
    key("ArrowRight")
    expect(box()).toHaveValue("@supe")
    type("@")
    await waitFor(() => expect(options()).toHaveLength(5))
    expect(fireEvent.keyDown(box(), { key: "/" })).toBe(true)
  })

  it("a click inserts, and the chevron opens", async () => {
    mount(<SteerBox task={task()} onSend={async () => {}} />)
    type("@")
    await waitFor(() => expect(options()).toHaveLength(5))
    fireEvent.click(screen.getByRole("button", { name: "Open superapp" }))
    expect(box()).toHaveValue("@superapp/")
    await waitFor(() => expect(options()).toEqual(["My Docs/", "src/", "README.md"]))
    expect(screen.queryByRole("button", { name: "Open README.md" })).toBeNull()
    fireEvent.click(within(screen.getByTestId("mention-list")).getByText("src/"))
    expect(box()).toHaveValue("/work/superapp/src ")
  })

  it("the footer names the keys, and only offers ⇥ where something opens", async () => {
    mount(<SteerBox task={task()} onSend={async () => {}} />)
    type("@")
    await waitFor(() => expect(screen.getByTestId("mention-list")).toHaveTextContent("↵ insert · ⇥ open"))
    type("@superapp/RE")
    await waitFor(() => expect(options()).toEqual(["README.md"]))
    expect(screen.getByTestId("mention-list")).toHaveTextContent("↵ insert")
    expect(screen.getByTestId("mention-list")).not.toHaveTextContent("⇥ open")
  })

  it("Escape closes the list and leaves the text as typed, until the caret leaves the word", async () => {
    mount(<SteerBox task={task()} onSend={async () => {}} />)
    type("@su")
    await waitFor(() => expect(options()).toHaveLength(1))
    key("Escape")
    expect(screen.queryByTestId("mention-list")).toBeNull()
    expect(box()).toHaveValue("@su")
    type("@sup")
    expect(screen.queryByTestId("mention-list")).toBeNull()
    type("@sup ")
    type("@sup @")
    await waitFor(() => expect(screen.getByTestId("mention-list")).toBeInTheDocument())
  })

  it("an @ inside a word never opens it, and Enter still sends", async () => {
    const onSend = vi.fn(async () => {})
    const paths = mount(<SteerBox task={task()} onSend={onSend} />)
    type("mail me@superapp")
    expect(screen.queryByTestId("mention-list")).toBeNull()
    expect(paths).not.toContain("/api/repos")
    key("Enter")
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("mail me@superapp", undefined))
  })

  it("an @ word no project answers stays shut, and Enter sends it", async () => {
    const onSend = vi.fn(async () => {})
    mount(<SteerBox task={task()} onSend={onSend} />)
    type("npm i @types/node")
    await waitFor(() => expect(screen.queryByTestId("mention-list")).toBeNull())
    key("Enter")
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("npm i @types/node", undefined))
  })

  it("@project/ lists its root; Tab opens a folder, Enter inserts a folder or a file", async () => {
    mount(<SteerBox task={task()} onSend={async () => {}} />)
    type("see @superapp/")
    await waitFor(() => expect(options()).toEqual(["My Docs/", "src/", "README.md"]))
    key("ArrowDown")
    key("Tab")
    expect(box()).toHaveValue("see @superapp/src/")
    await waitFor(() => expect(options()).toEqual(["components/", "config.ts"]))
    key("Enter")
    expect(box()).toHaveValue("see /work/superapp/src/components ")
    type("see @superapp/src/conf")
    await waitFor(() => expect(options()).toEqual(["config.ts"]))
    key("Tab")
    expect(box()).toHaveValue("see @superapp/src/conf")
    key("Enter")
    expect(box()).toHaveValue("see /work/superapp/src/config.ts ")
  })

  it("a folder with a space in its name opens, and its paths arrive quoted", async () => {
    mount(<SteerBox task={task()} onSend={async () => {}} />)
    type("see @superapp/My")
    await waitFor(() => expect(options()).toEqual(["My Docs/"]))
    key("Tab")
    expect(box()).toHaveValue("see @superapp/My Docs/")
    await waitFor(() => expect(options()).toEqual(["guide.md"]))
    type("see @superapp/My Docs/gu")
    await waitFor(() => expect(options()).toEqual(["guide.md"]))
    key("Enter")
    expect(box()).toHaveValue('see "/work/superapp/My Docs/guide.md" ')
    type("see @superapp/My")
    await waitFor(() => expect(options()).toEqual(["My Docs/"]))
    key("Enter")
    expect(box()).toHaveValue('see "/work/superapp/My Docs" ')
  })

  it("two projects with one name are both offered, and the chosen one is the one listed", async () => {
    const paths = mount(<SteerBox task={task()} onSend={async () => {}} />)
    type("@app/")
    await waitFor(() => expect(options()).toEqual(["app/work/app", "app/work/other/app"]))
    expect(paths.some((path) => path.startsWith("/api/projects/entries?"))).toBe(false)
    key("ArrowDown")
    key("Tab")
    await waitFor(() => expect(options()).toEqual(["lib/"]))
    key("Enter")
    expect(box()).toHaveValue("/work/other/app/lib ")
  })

  it("opening one twin re-tracks even when the browser's insertText leaves the draft unchanged", async () => {
    // the browser path: insertText succeeds, and `@app/` over `@app/` fires no change event
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => true) })
    try {
      mount(<SteerBox task={task()} onSend={async () => {}} />)
      type("@app/")
      await waitFor(() => expect(options()).toHaveLength(2))
      key("ArrowDown")
      key("Tab")
      await waitFor(() => expect(options()).toEqual(["lib/"]))
    } finally {
      Reflect.deleteProperty(document, "execCommand")
    }
  })

  it("an open list never lets Enter send, while it loads or when nothing matches", async () => {
    const onSend = vi.fn(async () => {})
    mount(<SteerBox task={task()} onSend={onSend} />)
    type("@slow/")
    await waitFor(() => expect(screen.getByTestId("mention-list")).toHaveTextContent("Listing…"))
    key("Enter")
    key("Enter", { metaKey: true })
    type("@superapp/zzz")
    await waitFor(() => expect(screen.getByTestId("mention-list")).toHaveTextContent("Nothing in superapp matches “zzz”"))
    key("Enter")
    expect(onSend).not.toHaveBeenCalled()
    expect(box()).toHaveValue("@superapp/zzz")
    key("Escape")
    key("Enter")
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("@superapp/zzz", undefined))
  })

  it("on touch, a tap inserts, the chevron opens, and no key hint is shown", async () => {
    mount(<SteerBox task={task()} onSend={async () => {}} touch />)
    type("@")
    await waitFor(() => expect(options()).toHaveLength(5))
    expect(screen.getByTestId("mention-list")).not.toHaveTextContent("↵ insert")
    fireEvent.click(screen.getByRole("button", { name: "Open superapp" }))
    await waitFor(() => expect(options()).toEqual(["My Docs/", "src/", "README.md"]))
    fireEvent.click(within(screen.getByTestId("mention-list")).getByText("README.md"))
    expect(box()).toHaveValue("/work/superapp/README.md ")
  })

  it("a folder the scan could not read in full says so, rather than to keep typing", async () => {
    mount(<SteerBox task={task()} onSend={async () => {}} />)
    type("@superapp/vendor/")
    await waitFor(() =>
      expect(screen.getByTestId("mention-list")).toHaveTextContent("This folder has more than 5,000 entries; not all are searchable"),
    )
    type("@superapp/vendor/zzz")
    await waitFor(() => expect(options()).toEqual([]))
    expect(screen.getByTestId("mention-list")).toHaveTextContent("not all are searchable")
    expect(screen.getByTestId("mention-list")).not.toHaveTextContent("Nothing in")
  })

  it("a folder that cannot be listed says so, and Escape closes it", async () => {
    mount(<SteerBox task={task()} onSend={async () => {}} />)
    type("@superapp/missing/")
    await waitFor(() => expect(screen.getByTestId("mention-list")).toHaveTextContent("Couldn't list missing: no such folder"))
    key("Escape")
    expect(screen.queryByTestId("mention-list")).toBeNull()
  })

  it("does not take over the / palette", async () => {
    mount(<SteerBox task={task()} onSend={async () => {}} />)
    type("/")
    expect(screen.getByTestId("slash-palette")).toBeInTheDocument()
    expect(screen.queryByTestId("mention-list")).toBeNull()
  })
})
