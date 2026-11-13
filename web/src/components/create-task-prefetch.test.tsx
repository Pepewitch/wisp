import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PREFETCH_DEBOUNCE_MS, PREFETCH_REWARM_MS } from "@/hooks/usePrefetchBaseRefs"
import { clearConnectionDrafts } from "@/lib/drafts"
import type { DaemonTransport } from "@/lib/transport"
import type { HarnessInfo, RepoInfo } from "@/lib/types"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { CreateTaskDialog } from "./create-task-dialog"

/**
 * The composer warms the daemon's `git fetch origin` while a worktree task is
 * written (POST /api/projects/base-refs), so Start does not wait on it. Pinned
 * here: it asks once the composer settles, never per keystroke or per project
 * passed through, never for a local task, again while typing only after
 * PREFETCH_REWARM_MS, and a refusal changes nothing on screen.
 */

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
const otherRepo: RepoInfo = { ...repo, path: "/other", name: "other" }

const harness: HarnessInfo = {
  name: "droid",
  hasModel: true,
  hasEffort: true,
  hasImage: false,
  defaults: { model: "kimi-k3" },
  models: { list: ["kimi-k3"], defaultModel: "kimi-k3", probedAt: "2026-09-01T00:00:00.000Z" },
}

const CONNECTION = "prefetch-connection"

function setup(fail = false) {
  const prefetches: unknown[] = []
  const request = ((path: string, init?: { body?: unknown }) => {
    if (path === "/api/projects/base-refs") {
      prefetches.push(init?.body)
      return fail ? Promise.reject(new Error("404 not found")) : Promise.resolve({ state: "started" })
    }
    if (path === "/api/harnesses") return Promise.resolve({ harnesses: [harness], features: {} })
    return Promise.resolve({})
  }) as DaemonTransport["request"]
  const dialog = (initialRepoPath: string) => (
    <CreateTaskDialog
      open
      onOpenChange={() => {}}
      initialRepoPath={initialRepoPath}
      repos={[repo, otherRepo]}
      harnesses={[harness]}
      harnessesError={null}
      onCreated={() => {}}
    />
  )
  render(dialog("/repo"), { wrapper: runtimeWrapper(fakeDaemonTransport(CONNECTION, { request })) })
  return { prefetches }
}

const prompt = () => screen.getByPlaceholderText<HTMLTextAreaElement>("What do you want to work on?")
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
})

afterEach(() => {
  vi.useRealTimers()
  clearConnectionDrafts(CONNECTION)
})

describe("create composer base-ref prefetch", () => {
  it("asks once the composer has settled, not on open and not per keystroke", () => {
    const { prefetches } = setup()
    expect(prefetches).toEqual([])
    advance(PREFETCH_DEBOUNCE_MS - 100)
    fireEvent.change(prompt(), { target: { value: "fix the" } })
    advance(PREFETCH_DEBOUNCE_MS - 100)
    fireEvent.change(prompt(), { target: { value: "fix the flaky test" } })
    expect(prefetches).toEqual([])
    advance(PREFETCH_DEBOUNCE_MS)
    expect(prefetches).toEqual([{ path: "/repo" }])

    // more typing soon after is covered by the fetch just asked for
    fireEvent.change(prompt(), { target: { value: "fix the flaky test in CI" } })
    advance(PREFETCH_DEBOUNCE_MS * 5)
    expect(prefetches).toHaveLength(1)
  })

  it("asks again while typing continues, once the last ask is PREFETCH_REWARM_MS old", () => {
    const { prefetches } = setup()
    advance(PREFETCH_DEBOUNCE_MS)
    expect(prefetches).toHaveLength(1)
    advance(PREFETCH_REWARM_MS)
    expect(prefetches).toHaveLength(1) // an idle composer costs nothing
    fireEvent.change(prompt(), { target: { value: "still writing" } })
    advance(PREFETCH_DEBOUNCE_MS)
    expect(prefetches).toEqual([{ path: "/repo" }, { path: "/repo" }])
  })

  it("asks for the project finally picked, not each one passed through", () => {
    const { prefetches } = setup()
    const pick = (name: string) => {
      fireEvent.click(screen.getByRole("button", { name: "Project" }))
      fireEvent.click(screen.getByRole("menuitemradio", { name }))
      advance(PREFETCH_DEBOUNCE_MS / 2)
    }
    advance(PREFETCH_DEBOUNCE_MS / 2)
    pick("other")
    pick("repo")
    pick("other")
    advance(PREFETCH_DEBOUNCE_MS)
    expect(prefetches).toEqual([{ path: "/other" }])
  })

  it("asks nothing for a local task, which has no base to fetch", () => {
    const { prefetches } = setup()
    fireEvent.click(screen.getByRole("button", { name: "Worktree" }))
    fireEvent.click(screen.getByRole("menuitemradio", { name: "This repo" }))
    advance(PREFETCH_DEBOUNCE_MS * 5)
    expect(prefetches).toEqual([])
  })

  it("a refused ask is ignored: the composer carries on", async () => {
    const { prefetches } = setup(true)
    advance(PREFETCH_DEBOUNCE_MS)
    await act(async () => {})
    expect(prefetches).toHaveLength(1)
    fireEvent.change(prompt(), { target: { value: "still here" } })
    expect(prompt()).toHaveValue("still here")
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
