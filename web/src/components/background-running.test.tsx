import { render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createDesktopTransport } from "@/lib/desktop-transport"
import { backgroundDetail, backgroundLabel, backgroundLingers, backgroundNames, stateWord } from "@/lib/state"
import type { ApiTask } from "@/lib/types"
import { sameOriginWebTransport } from "@/lib/web-transport"
import { runtimeWrapper } from "@/test/runtime"

import { composerStatus } from "./composer-status"
import { TaskHeader } from "./task-header"
import { TaskCard, TaskRow } from "./task-row"

/**
 * The answer is in, and a process the agent started in the background is
 * still up. The task reads "Done · 1 background process running" on the
 * StateDot's hollow ring, and every hover names what is running, where it
 * started and for how long — the facts Stop is judged on.
 */

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

/** What the daemon sends while it keeps a Claude process alive for its dev server. */
const lingering = (): NonNullable<ApiTask["background"]> => ({
  state: "running",
  groups: 1,
  details: [{
    turn: 5, pgid: 48213, processes: 3, since: minutesAgo(3), state: "running", stopRequested: false,
    names: ["claude", "node"],
    tasks: [{ name: "vite", kind: "local_bash", turn: 4, since: minutesAgo(12) }],
  }],
})

const TASK: ApiTask = {
  id: "t5qmha",
  title: "Guard the editor against double saves",
  repo_path: "/tmp/repo",
  worktree_path: "/tmp/wt",
  branch: "wisp/t5qmha-steer-box-hotkey",
  base_commit: "8f2a1c9",
  harness: "claude",
  model: "claude-opus-5-5",
  effort: null,
  slot: 1,
  state: "done",
  state_detail: null,
  session_id: "s-1",
  seq: 7,
  turn_count: 5,
  archived: false,
  mode: "worktree",
  created_at: minutesAgo(30),
  updated_at: minutesAgo(1),
  background: lingering(),
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the words for work outliving its turn", () => {
  it("counts what the harness named, and names it with its turn and age", () => {
    const background = lingering()
    expect(backgroundLabel(background)).toBe("1 background process running")
    expect(stateWord(TASK)).toBe("Done · 1 background process running")
    expect(backgroundDetail(background, Date.now())).toMatch(/^vite · started in turn 4 · 12m 0\ds ago$/)
    // the harness's own name, not the programs `ps` saw in its group
    expect(backgroundNames(background)).toBe("vite")
    expect(backgroundLingers(background)).toBe(true)
  })

  it("says only that work runs when an older daemon sends no detail", () => {
    expect(backgroundLabel({ state: "running", groups: 2 })).toBe("Background work running")
  })

  it("counts every task one lingering process holds", () => {
    const background = lingering()
    background.details![0]!.tasks!.push({ name: "watch tests", kind: "local_bash", turn: 5, since: minutesAgo(1) })
    expect(backgroundLabel(background)).toBe("2 background processes running")
    expect(backgroundDetail(background, Date.now())!.split("\n")).toHaveLength(2)
  })

  it("counts a group no harness is describing by its live processes", () => {
    const background = lingering()
    delete background.details![0]!.tasks
    expect(backgroundLabel(background)).toBe("3 background processes running")
    expect(backgroundDetail(background, Date.now())).toMatch(/^turn 5: claude, node · 3m 0\ds past the turn$/)
    expect(backgroundLingers(background)).toBe(false)
  })
})

describe.each(["browser", "desktop"] as const)("rendered through the %s runtime", (runtime) => {
  const wrapper = () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 })))
    return runtimeWrapper(runtime === "browser" ? sameOriginWebTransport
      : createDesktopTransport("http://127.0.0.1:45678/fixture-capability", "remote-fixture", 1))
  }

  it("the header reads Done on the hollow background ring, and its hover names the process", () => {
    render(<TaskHeader task={TASK} />, { wrapper: wrapper() })

    const word = screen.getByText("Done · 1 background process running")
    const line = word.parentElement!
    expect(line.getAttribute("title")).toMatch(/^Done · 1 background process running\nvite · started in turn 4 · 12m 0\ds ago$/)
    const dot = line.querySelector('[data-state="done"]')!
    expect(dot).toHaveAttribute("data-background", "running")
    expect(dot).toHaveClass("border-state-background", "bg-transparent")
    expect(dot).not.toHaveClass("bg-state-done")
  })

  it("the sidebar row keeps the ring, and its hover card names the process", () => {
    const view = render(<TaskRow task={TASK} selected={false} onSelect={() => {}} />, { wrapper: wrapper() })
    const dot = view.container.querySelector('[data-state="done"][role="img"]')!
    expect(dot).toHaveClass("border-state-background", "bg-transparent")
    expect(dot.getAttribute("aria-label")).toMatch(/^Done · 1 background process running\nvite · started in turn 4/)
    view.unmount()

    const card = render(<TaskCard task={TASK} />, { wrapper: wrapper() })
    expect(card.getByText("Done · 1 background process running")).toBeInTheDocument()
    expect(card.container.querySelector("[data-background-detail]")?.textContent).toMatch(/^vite · started in turn 4 · 12m 0\ds ago$/)
  })
})

describe("the composer while the process lingers", () => {
  it("says a send for the same agent leaves the work running", () => {
    expect(composerStatus(TASK, null)).toEqual({ text: "background work (vite) · send won't stop it", warn: false })
    expect(composerStatus(TASK, null, false, { harness: "claude", model: "claude-opus-5-5", effort: null, fast: false }))
      .toEqual({ text: "background work (vite) · send won't stop it", warn: false })
  })

  it("warns that another agent has to stop it first", () => {
    expect(composerStatus(TASK, null, false, { harness: "claude", model: "claude-sonnet-5", effort: null, fast: false }))
      .toEqual({ text: "background work (vite) · another agent stops it, then sends", warn: true })
  })

  it("keeps the plain note for background work no harness is holding", () => {
    const orphan: ApiTask = { ...TASK, background: { ...lingering(), details: [{ ...lingering().details![0]!, tasks: undefined }] } }
    expect(composerStatus(orphan, null, false, { harness: "codex", model: "gpt-5.6-luna", effort: null, fast: false }))
      .toEqual({ text: "background work (claude, node) · send won't stop it", warn: false })
  })
})
