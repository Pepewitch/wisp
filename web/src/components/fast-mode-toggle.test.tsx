import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createDesktopTransport } from "@/lib/desktop-transport"
import { sameOriginWebTransport } from "@/lib/web-transport"
import type { ApiTask, HarnessInfo, RepoInfo } from "@/lib/types"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { CreateTaskDialog } from "./create-task-dialog"
import { FastModeToggle } from "./fast-mode-toggle"
import { SteerBox } from "./steer-box"
import { TaskAgentPicker } from "./task-agent-picker"

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

const harness = (name: string, models: string[], hasFastMode: boolean): HarnessInfo => ({
  name,
  hasModel: true,
  hasEffort: false,
  hasFastMode,
  hasImage: false,
  defaults: { model: models[0] },
  models: { list: models, defaultModel: models[0] ?? null, probedAt: "2026-09-01T00:00:00.000Z" },
})

// codex has a real speed tier for the same model; claude has none
const harnesses = [harness("claude", ["claude-a"], false), harness("codex", ["codex-a"], true)]

afterEach(() => localStorage.clear())

describe("the fast mode toggle", () => {
  it("reads as an unpressed icon until it is on, when it also says so in words", () => {
    const onChange = vi.fn()
    const { rerender } = render(<FastModeToggle value={false} onChange={onChange} />)
    const off = screen.getByRole("button", { name: "Fast mode" })
    expect(off).toHaveAttribute("aria-pressed", "false")
    expect(off).not.toHaveTextContent("Fast")

    fireEvent.click(off)
    expect(onChange).toHaveBeenCalledWith(true)

    rerender(<FastModeToggle value onChange={onChange} />)
    const on = screen.getByRole("button", { name: "Fast mode on" })
    expect(on).toHaveAttribute("aria-pressed", "true")
    expect(on).toHaveTextContent("Fast")
    fireEvent.click(on)
    expect(onChange).toHaveBeenLastCalledWith(false)
  })
})

describe("fast mode in the create dialog", () => {
  const mount = () =>
    render(
      <CreateTaskDialog
        open
        onOpenChange={() => {}}
        initialRepoPath="/repo"
        repos={[repo]}
        harnesses={harnesses}
        harnessesError={null}
        onCreated={() => {}}
      />,
      { wrapper: runtimeWrapper(fakeDaemonTransport()) },
    )

  it("appears only for a harness that has the lane, and clears when the harness loses it", async () => {
    mount()
    // claude is first in the fixture, and sells no faster lane
    expect(screen.queryByRole("button", { name: /^Fast mode/ })).toBeNull()

    // one open menu serves the whole walk: picking a model leaves it up
    fireEvent.click(await screen.findByRole("button", { name: /^claude\W+claude-a$/ }))
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /codex-a/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Fast mode" }))
    expect(screen.getByRole("button", { name: "Fast mode on" })).toBeTruthy()

    // a harness with no lane takes the button away — and the choice with it, so
    // the create request cannot carry a tier that harness would refuse
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /claude-a/ }))
    expect(screen.queryByRole("button", { name: /^Fast mode/ })).toBeNull()

    fireEvent.click(await screen.findByRole("menuitemradio", { name: /codex-a/ }))
    expect(screen.getByRole("button", { name: "Fast mode" })).toHaveAttribute("aria-pressed", "false")
  })
})

describe("fast mode in the steer picker", () => {
  it("offers the tier for a harness with the lane and hides it otherwise", () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <TaskAgentPicker
        harnesses={harnesses}
        value={{ harness: "codex", model: "codex-a", effort: null, fast: false }}
        disabled={false}
        onChange={onChange}
      />,
      { wrapper: runtimeWrapper(fakeDaemonTransport()) },
    )
    fireEvent.click(screen.getByRole("button", { name: "Fast mode" }))
    expect(onChange).toHaveBeenCalledWith({ harness: "codex", model: "codex-a", effort: null, fast: true })

    rerender(
      <TaskAgentPicker
        harnesses={harnesses}
        value={{ harness: "claude", model: "claude-a", effort: null, fast: false }}
        disabled={false}
        onChange={onChange}
      />,
    )
    expect(screen.queryByRole("button", { name: /^Fast mode/ })).toBeNull()
  })

  it("drops the tier when the chosen model moves to a harness without the lane", () => {
    const onChange = vi.fn()
    render(
      <TaskAgentPicker
        harnesses={harnesses}
        value={{ harness: "codex", model: "codex-a", effort: null, fast: true }}
        disabled={false}
        onChange={onChange}
      />,
      { wrapper: runtimeWrapper(fakeDaemonTransport()) },
    )
    fireEvent.click(screen.getByRole("button", { name: /codex.*codex-a/ }))
    fireEvent.click(screen.getByRole("menuitemradio", { name: /claude-a/ }))
    expect(onChange).toHaveBeenCalledWith({ harness: "claude", model: "claude-a", effort: null, fast: false })
  })
})

/**
 * One bundle, two shipped clients: the tier has to reach the daemon over the
 * browser's same-origin fetch AND the desktop's proxied URL, so the steer is
 * driven for real on both rather than trusted because the code is shared.
 */
describe("fast mode over both client transports", () => {
  const steerTask = (): ApiTask =>
    ({
      id: "tk9zdy",
      title: "steer",
      harness: "codex",
      model: "codex-a",
      state: "done",
      state_detail: null,
      archived: false,
      context_n: 1,
      turn_count: 1,
      seq: 4,
      branch: "wisp/tk9zdy-steer",
      worktree_path: "/tmp/wt",
      repo_path: "/tmp/repo",
    }) as ApiTask

  afterEach(() => vi.unstubAllGlobals())

  it.each(["browser", "desktop"] as const)("sends fast: true through %s", async (runtime) => {
    const sends: { url: string; body: Record<string, unknown> }[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url, init) => {
        if (String(url).endsWith("/send")) {
          sends.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
        }
        return new Response(JSON.stringify({ disposition: "queued-next", message: {}, turn_count: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }),
    )
    const transport =
      runtime === "browser"
        ? sameOriginWebTransport
        : createDesktopTransport("http://127.0.0.1:45678/fixture-capability", "remote-fixture", 1)
    render(<SteerBox task={steerTask()} harnesses={harnesses} canSwitchAgent />, {
      wrapper: runtimeWrapper(transport),
    })

    fireEvent.click(screen.getByRole("button", { name: "Fast mode" }))
    fireEvent.change(screen.getByPlaceholderText("Ask for changes, or / for commands"), {
      target: { value: "same model, faster lane" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    await waitFor(() => expect(sends).toHaveLength(1))
    expect(sends[0]!.url).toBe(
      runtime === "browser"
        ? "/api/tasks/tk9zdy/send"
        : "http://127.0.0.1:45678/fixture-capability/connections/remote-fixture/1/api/tasks/tk9zdy/send",
    )
    expect(sends[0]!.body).toMatchObject({ message: "same model, faster lane", fast: true, harness: "codex" })
  })
})
