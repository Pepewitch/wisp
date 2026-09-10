import { onlineManager } from "@tanstack/react-query"
import { afterEach, expect, it, vi } from "vitest"
import { queryClient } from "./query"

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
