import { onlineManager } from "@tanstack/react-query"
import { afterEach, expect, it, vi } from "vitest"
import { FOCUS_REFRESH_AFTER_MS, queryClient, refetchOnFocus } from "./query"

afterEach(() => {
  onlineManager.setOnline(true)
  queryClient.clear()
})

it("reports an offline command failure immediately and does not replay it on reconnect", async () => {
  onlineManager.setOnline(false)
  const command = vi.fn().mockRejectedValue(new Error("daemon unreachable"))
  const mutation = queryClient.getMutationCache().build(queryClient, { mutationFn: command })
  await expect(mutation.execute(undefined)).rejects.toThrow("daemon unreachable")
  expect(mutation.state.isPaused).toBe(false)
  expect(command).toHaveBeenCalledTimes(1)
  onlineManager.setOnline(true)
  await queryClient.resumePausedMutations()
  expect(command).toHaveBeenCalledTimes(1)
})

it("allows a reachable Desktop proxy even when the browser reports offline", async () => {
  onlineManager.setOnline(false)
  const command = vi.fn().mockResolvedValue({ accepted: true })
  const mutation = queryClient.getMutationCache().build(queryClient, { mutationFn: command })
  await expect(mutation.execute(undefined)).resolves.toEqual({ accepted: true })
  expect(command).toHaveBeenCalledTimes(1)
})

it("refetches on focus what no event keeps fresh, an event-fed read only after a long absence, and never the archive", () => {
  const fetched = (key: readonly unknown[], at: number) => {
    queryClient.setQueryData(key, [], { updatedAt: at })
    return queryClient.getQueryCache().find({ queryKey: key, exact: true })!
  }
  const now = Date.now()
  expect(refetchOnFocus(fetched(["local", "pull-request", "t1"], now))).toBe(true)
  expect(refetchOnFocus(fetched(["local", "tasks", { archived: false }], now))).toBe(false)
  expect(refetchOnFocus(fetched(["local", "task", "t1"], now - FOCUS_REFRESH_AFTER_MS - 1))).toBe(true)
  expect(refetchOnFocus(fetched(["local", "tasks", { archived: true }], now - FOCUS_REFRESH_AFTER_MS - 1))).toBe(false)
})

it("still reads a reachable daemon when the browser reports offline", async () => {
  onlineManager.setOnline(false)
  const read = vi.fn().mockResolvedValue([{ id: "t1", state: "done" }])
  await expect(queryClient.fetchQuery({ queryKey: ["local", "tasks", { archived: false }], queryFn: read }))
    .resolves.toEqual([{ id: "t1", state: "done" }])
  expect(read).toHaveBeenCalledTimes(1)
})
