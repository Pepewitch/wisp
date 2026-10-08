import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { api } from "@/lib/api"
import type { HarnessInfo } from "@/lib/types"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { useBriefChoice } from "./useBriefChoice"

const HARNESS = { name: "codex", hasBriefs: true } as HarnessInfo

function daemon(features: Record<string, boolean>) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ harnesses: [], features }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })))
  return runtimeWrapper(fakeDaemonTransport("brief-choice", { request: api })) as (props: { children: ReactNode }) => ReactNode
}

afterEach(() => vi.unstubAllGlobals())

describe("the create composer's brief choice", () => {
  it("starts at the model's default and sends nothing once switched off", async () => {
    const wrapper = daemon({ taskBriefs: true })
    const { result } = renderHook(() => useBriefChoice(HARNESS, null, true), { wrapper })
    await waitFor(() => expect(result.current.toggle).not.toBeNull())
    expect(result.current.body).toEqual({ briefEnabled: true })
    render(<>{result.current.toggle}</>, { wrapper })
    act(() => fireEvent.click(screen.getByRole("button", { name: "Task brief on" })))
    await waitFor(() => expect(result.current.body).toEqual({}))
    expect(result.current.chosen).toBe(false)
  })

  it("follows a changed default until toggled, and forgets the toggle on reset", async () => {
    const wrapper = daemon({ taskBriefs: true })
    const { result, rerender } = renderHook(({ fallback }) => useBriefChoice(HARNESS, null, fallback), {
      wrapper,
      initialProps: { fallback: false },
    })
    await waitFor(() => expect(result.current.toggle).not.toBeNull())
    expect(result.current.body).toEqual({})
    rerender({ fallback: true })
    expect(result.current.body).toEqual({ briefEnabled: true })
    render(<>{result.current.toggle}</>, { wrapper })
    act(() => fireEvent.click(screen.getByRole("button", { name: "Task brief on" })))
    await waitFor(() => expect(result.current.value).toBe(false))
    act(() => result.current.reset())
    expect(result.current.value).toBe(true)
  })

  it("keeps a restored draft's choice over the default", async () => {
    const wrapper = daemon({ taskBriefs: true })
    const { result } = renderHook(() => useBriefChoice(HARNESS, { brief: false }, true), { wrapper })
    await waitFor(() => expect(result.current.toggle).not.toBeNull())
    expect(result.current.body).toEqual({})
  })

  it("is not offered by an older daemon or for a harness that cannot publish", async () => {
    const older = renderHook(() => useBriefChoice(HARNESS, { brief: true }, true), { wrapper: daemon({}) })
    await waitFor(() => expect(older.result.current.toggle).toBeNull())
    expect(older.result.current.body).toEqual({})
    const plain = renderHook(() => useBriefChoice({ ...HARNESS, hasBriefs: false }, { brief: true }, true), { wrapper: daemon({ taskBriefs: true }) })
    await waitFor(() => expect(plain.result.current.toggle).toBeNull())
    expect(plain.result.current.body).toEqual({})
  })
})
