import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"

import { qk } from "@/lib/query"

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  mintSession: vi.fn(),
  completeAuth: vi.fn(),
}))

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: mocks.api,
  mintSession: mocks.mintSession,
  completeAuth: mocks.completeAuth,
}))

import {
  useArchiveTask,
  useCopyPreview,
  useCreateSuffixPrompt,
  useCreateTask,
  useFreshSession,
  useInterruptTask,
  useInstallUpdate,
  useMintSession,
  usePushTask,
  useRenameTask,
  useRemoveProject,
  useReprobeHarnesses,
  useSaveProject,
  useSendMessage,
} from "./mutations"

/**
 * What is worth asserting here is OURS, not React Query's: which query keys a
 * write declares stale, and the two places the app deliberately departs from
 * the obvious default — the header verbs refetch even when they fail, and
 * re-probing waits out the daemon's async probes before refetching.
 */

function harness() {
  const client = new QueryClient()
  const spy = vi.spyOn(client, "invalidateQueries")
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, spy, wrapper }
}

/** The query keys a run declared stale, in order. */
function invalidated(spy: MockInstance): unknown[] {
  return spy.mock.calls.map((call) => (call[0] as { queryKey?: unknown } | undefined)?.queryKey)
}

/**
 * React Query hands mutation state to React on a MACROTASK (its notifyManager
 * schedules with setTimeout(0)), so a read taken the instant `mutateAsync`
 * resolves is one tick stale. Every assertion on the hook's own state waits.
 */
const settles = (assert: () => void) => waitFor(assert)

beforeEach(() => {
  mocks.api.mockReset()
  mocks.api.mockResolvedValue({})
  mocks.mintSession.mockReset()
  mocks.mintSession.mockResolvedValue(undefined)
  mocks.completeAuth.mockReset()
})

describe("task writes", () => {
  it("starts the selected update and stores its progress response", async () => {
    const status = {
      currentVersion: "0.4.0-alpha.6",
      latestVersion: "0.4.0-alpha.7",
      state: "installing",
    }
    mocks.api.mockResolvedValue(status)
    const { client, wrapper } = harness()
    const { result } = renderHook(() => useInstallUpdate(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync("0.4.0-alpha.7")
    })

    expect(mocks.api).toHaveBeenCalledWith("/api/update", {
      method: "POST",
      body: { version: "0.4.0-alpha.7" },
    })
    expect(client.getQueryData(qk.update)).toEqual(status)
  })

  it("creating a task posts the composer's body and stales the task list", async () => {
    mocks.api.mockResolvedValue({ id: "t5qmha" })
    const { spy, wrapper } = harness()
    const { result } = renderHook(() => useCreateTask(), { wrapper })

    let created: { id: string } | undefined
    await act(async () => {
      created = await result.current.mutateAsync({
        repoPath: "/repo",
        prompt: "fix it",
        harness: "droid",
        model: "kimi-k3",
        mode: "worktree",
      })
    })

    expect(mocks.api).toHaveBeenCalledWith("/api/tasks", {
      method: "POST",
      body: { repoPath: "/repo", prompt: "fix it", harness: "droid", model: "kimi-k3", mode: "worktree" },
    })
    expect(created).toEqual({ id: "t5qmha" })
    expect(invalidated(spy)).toEqual([qk.tasks])
  })

  it("renaming updates loaded task names without refetching unrelated task data", async () => {
    const saved = { id: "t5qmha", title: "Clear task name", updated_at: "2026-09-03T12:00:00Z" }
    mocks.api.mockResolvedValue(saved)
    const { client, spy, wrapper } = harness()
    client.setQueryData(qk.tasksList(false), [
      { id: saved.id, title: "The first prompt", updated_at: "2026-09-01T12:00:00Z" },
    ])
    client.setQueryData(qk.task(saved.id), {
      id: saved.id,
      title: "The first prompt",
      updated_at: "2026-09-01T12:00:00Z",
    })
    const { result } = renderHook(() => useRenameTask(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({ id: saved.id, title: saved.title })
    })

    expect(mocks.api).toHaveBeenCalledWith(`/api/tasks/${saved.id}`, {
      method: "PATCH",
      body: { title: saved.title },
    })
    expect(client.getQueryData<Array<{ title: string }>>(qk.tasksList(false))?.[0]?.title).toBe(saved.title)
    expect(client.getQueryData<{ title: string }>(qk.task(saved.id))?.title).toBe(saved.title)
    expect(invalidated(spy)).toEqual([])
  })

  it("sending a message stales only that task's detail — the list row carries no turns", async () => {
    const { spy, wrapper } = harness()
    const { result } = renderHook(() => useSendMessage(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({ id: "t5qmha", message: "and again", clientMessageId: "client-message-1" })
    })

    expect(mocks.api).toHaveBeenCalledWith("/api/tasks/t5qmha/send", {
      method: "POST",
      body: { message: "and again", clientMessageId: "client-message-1" },
    })
    expect(invalidated(spy)).toEqual([qk.task("t5qmha")])
  })

  it("passes a selected suffix id on create and steer writes", async () => {
    mocks.api.mockResolvedValue({ id: "t5qmha" })
    const createHarness = harness()
    const create = renderHook(() => useCreateTask(), { wrapper: createHarness.wrapper })
    await act(async () => {
      await create.result.current.mutateAsync({
        repoPath: "/repo",
        prompt: "review it",
        harness: "droid",
        model: "kimi-k3",
        mode: "worktree",
        suffixPromptId: "suffix-review",
      })
    })
    expect(mocks.api).toHaveBeenLastCalledWith("/api/tasks", {
      method: "POST",
      body: {
        repoPath: "/repo",
        prompt: "review it",
        harness: "droid",
        model: "kimi-k3",
        mode: "worktree",
        suffixPromptId: "suffix-review",
      },
    })

    const sendHarness = harness()
    const send = renderHook(() => useSendMessage(), { wrapper: sendHarness.wrapper })
    await act(async () => {
      await send.result.current.mutateAsync({
        id: "t5qmha",
        message: "again",
        clientMessageId: "client-message-2",
        suffixPromptId: "suffix-review",
      })
    })
    expect(mocks.api).toHaveBeenLastCalledWith("/api/tasks/t5qmha/send", {
      method: "POST",
      body: { message: "again", clientMessageId: "client-message-2", suffixPromptId: "suffix-review" },
    })
  })

  it("interrupt and push stale the list and its git badges", async () => {
    for (const [hook, verb] of [
      [useInterruptTask, "interrupt"],
      [usePushTask, "push"],
    ] as const) {
      mocks.api.mockClear()
      const { spy, wrapper } = harness()
      const { result } = renderHook(hook, { wrapper })

      await act(async () => {
        await result.current.mutateAsync("t5qmha")
      })

      expect(mocks.api).toHaveBeenCalledWith(`/api/tasks/t5qmha/${verb}`, { method: "POST" })
      expect(invalidated(spy)).toEqual([qk.tasks, qk.status])
    }
  })

  it("a REFUSED push still stales the list — a failed push can have moved the branch", async () => {
    mocks.api.mockRejectedValue(new Error("no upstream"))
    const { spy, wrapper } = harness()
    const { result } = renderHook(() => usePushTask(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync("t5qmha").catch(() => undefined)
    })

    await settles(() => expect(result.current.isError).toBe(true))
    expect(invalidated(spy)).toEqual([qk.tasks, qk.status])
  })

  it("archiving sends the force flag and stales the row, its badges and its detail", async () => {
    const { spy, wrapper } = harness()
    const { result } = renderHook(() => useArchiveTask(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({ id: "t5qmha", force: true })
    })

    expect(mocks.api).toHaveBeenCalledWith("/api/tasks/t5qmha/archive", { method: "POST", body: { force: true } })
    expect(invalidated(spy)).toEqual([qk.tasks, qk.status, qk.task("t5qmha")])
  })

  it("a REFUSED archive stales nothing — the 409 means the task is untouched", async () => {
    mocks.api.mockRejectedValue(new Error("push first"))
    const { spy, wrapper } = harness()
    const { result } = renderHook(() => useArchiveTask(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({ id: "t5qmha", force: false }).catch(() => undefined)
    })

    expect(invalidated(spy)).toEqual([])
  })

  it("a fresh session stales the row, its badges and its detail", async () => {
    const { spy, wrapper } = harness()
    const { result } = renderHook(() => useFreshSession(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync("t5qmha")
    })

    expect(mocks.api).toHaveBeenCalledWith("/api/tasks/t5qmha/fresh-session", { method: "POST" })
    expect(invalidated(spy)).toEqual([qk.tasks, qk.status, qk.task("t5qmha")])
  })
})

describe("suffix prompt writes", () => {
  it("adds the created prompt to the shared query cache", async () => {
    const saved = {
      id: "suffix-review",
      name: "Intensive review",
      prompt: "Review everything.",
      createdAt: "2026-09-01T00:00:00.000Z",
    }
    mocks.api.mockResolvedValue(saved)
    const { client, wrapper } = harness()
    client.setQueryData(qk.suffixPrompts, { suffixPrompts: [] })
    const { result } = renderHook(() => useCreateSuffixPrompt(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({ name: saved.name, prompt: saved.prompt })
    })

    expect(mocks.api).toHaveBeenCalledWith("/api/suffix-prompts", {
      method: "POST",
      body: { name: saved.name, prompt: saved.prompt },
    })
    expect(client.getQueryData(qk.suffixPrompts)).toEqual({ suffixPrompts: [saved] })
  })
})

describe("project writes", () => {
  it("saving a project stales the repo list and nothing else", async () => {
    const { spy, wrapper } = harness()
    const { result } = renderHook(() => useSaveProject(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({
        path: "/repo",
        setupScript: "bun install",
        archiveScript: "",
        copyFiles: [".env*"],
      })
    })

    expect(mocks.api).toHaveBeenCalledWith("/api/projects", {
      method: "POST",
      body: { path: "/repo", setupScript: "bun install", archiveScript: "", copyFiles: [".env*"] },
    })
    expect(invalidated(spy)).toEqual([qk.repos])
  })

  it("removing a project stales the repo list and nothing else", async () => {
    const { spy, wrapper } = harness()
    const { result } = renderHook(() => useRemoveProject(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync("/repo")
    })

    expect(mocks.api).toHaveBeenCalledWith("/api/projects", {
      method: "DELETE",
      body: { path: "/repo" },
    })
    expect(invalidated(spy)).toEqual([qk.repos])
  })

  it("a copy preview stales nothing — the POST is a read", async () => {
    mocks.api.mockResolvedValue({ files: ["backend/.env"], truncated: false })
    const { spy, wrapper } = harness()
    const { result } = renderHook(() => useCopyPreview(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync({ path: "/repo", patterns: [".env*"] })
    })

    expect(mocks.api).toHaveBeenCalledWith("/api/projects/copy-preview", {
      method: "POST",
      body: { path: "/repo", patterns: [".env*"] },
    })
    await settles(() => expect(result.current.data).toEqual({ files: ["backend/.env"], truncated: false }))
    // the answer's identity: the call site compares these against what is typed
    expect(result.current.variables).toEqual({ path: "/repo", patterns: [".env*"] })
    expect(invalidated(spy)).toEqual([])
  })
})

describe("re-probing harnesses", () => {
  it("stays pending across the daemon's settle delay, then refetches the list", async () => {
    vi.useFakeTimers()
    try {
      const { spy, wrapper } = harness()
      const { result } = renderHook(() => useReprobeHarnesses(), { wrapper })

      act(() => {
        result.current.mutate()
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })

      expect(mocks.api).toHaveBeenCalledWith("/api/harnesses?refresh=1")
      // ?refresh=1 returns the CACHED list, so the fresh answer is not there yet
      expect(result.current.isPending).toBe(true)
      expect(invalidated(spy)).toEqual([])

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_800)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })

      expect(result.current.isPending).toBe(false)
      expect(invalidated(spy)).toEqual([qk.harnesses])
    } finally {
      vi.useRealTimers()
    }
  })

  it("swallows a failed kick and still refetches — the menu's own reasons say more than a banner", async () => {
    vi.useFakeTimers()
    try {
      mocks.api.mockRejectedValue(new Error("offline"))
      const { spy, wrapper } = harness()
      const { result } = renderHook(() => useReprobeHarnesses(), { wrapper })

      act(() => {
        result.current.mutate()
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_800)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })

      // the rejection never reaches the caller: the mutation itself succeeded
      expect(result.current.isSuccess).toBe(true)
      expect(invalidated(spy)).toEqual([qk.harnesses])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("minting a session", () => {
  it("releases the 401 gate with the token that worked, and stales nothing", async () => {
    const { spy, wrapper } = harness()
    const { result } = renderHook(() => useMintSession(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync("wisp-token")
    })

    expect(mocks.mintSession).toHaveBeenCalledWith("wisp-token")
    expect(mocks.completeAuth).toHaveBeenCalledWith("wisp-token")
    expect(invalidated(spy)).toEqual([])
  })

  it("a refused token never releases the gate", async () => {
    mocks.mintSession.mockRejectedValue(new Error("unauthorized — check `wisp token` on the daemon host"))
    const { wrapper } = harness()
    const { result } = renderHook(() => useMintSession(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync("wrong").catch(() => undefined)
    })

    expect(mocks.completeAuth).not.toHaveBeenCalled()
    await settles(() =>
      expect(result.current.error?.message).toBe("unauthorized — check `wisp token` on the daemon host"),
    )
  })
})
