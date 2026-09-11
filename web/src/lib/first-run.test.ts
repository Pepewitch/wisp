import { describe, expect, it, vi } from "vitest"

import {
  allStepsDone,
  buildFirstRunSteps,
  outstandingSentence,
  primaryStepKey,
  type FirstRunActions,
  type FirstRunData,
} from "./first-run"
import type { HarnessInfo } from "./types"

function harness(name: string, models: string[]): HarnessInfo {
  return {
    name,
    hasModel: true,
    hasEffort: false,
    hasImage: false,
    models: models.length > 0 ? { list: models, source: "probe" } : null,
    defaults: { model: "", reasoningEffort: "" },
  } as unknown as HarnessInfo
}

const ACTIONS: FirstRunActions = {
  onSetUpDaemon: vi.fn(),
  onRecheckHarnesses: vi.fn(),
  recheckPending: false,
  onAddProject: vi.fn(),
  addProjectPending: false,
}

const READY_DAEMON: FirstRunData["daemon"] = {
  ready: true,
  problem: null,
  summary: "Local · http://127.0.0.1:8710",
}

function build(data: Partial<FirstRunData>, actions: Partial<FirstRunActions> = {}) {
  return buildFirstRunSteps(
    {
      daemon: READY_DAEMON,
      harnesses: [harness("claude", ["opus"])],
      harnessesError: null,
      projectCount: 1,
      ...data,
    },
    { ...ACTIONS, ...actions }
  )
}

describe("the row count is derived, never authored", () => {
  it("gives the browser no daemon row, because the daemon served the page", () => {
    const steps = build({ daemon: null })

    expect(steps.map((s) => s.key)).toEqual(["harness", "project"])
    expect(outstandingSentence(steps)).toBe("Two things, then your first task.")
  })

  it("gives Desktop's Local one, and counts it", () => {
    const steps = build({})

    expect(steps.map((s) => s.key)).toEqual(["daemon", "harness", "project"])
    expect(outstandingSentence(steps)).toBe("Three things, then your first task.")
  })
})

describe("a daemon that is not answering gates what can be claimed about it", () => {
  it("refuses to report harnesses or projects it never asked for", () => {
    const steps = build({
      daemon: { ready: false, problem: "Local Wisp is not initialized.", summary: "" },
      // the stale answers a previous connection left in cache
      harnesses: [harness("claude", ["opus"])],
      projectCount: 4,
    })

    expect(steps[0]).toMatchObject({
      key: "daemon",
      state: "blocked",
      detail: "Local Wisp is not initialized.",
    })
    // NOT "4 projects" — nothing asked this daemon anything
    expect(steps.slice(1).map((s) => [s.state, s.detail, s.action])).toEqual([
      ["todo", "Checked once Wisp is running.", undefined],
      ["todo", "Checked once Wisp is running.", undefined],
    ])
  })

  it("carries its own repair even when the daemon named no reason", () => {
    const steps = build({ daemon: { ready: false, problem: null, summary: "" } })

    expect(steps[0]!.detail).toBe("Local Wisp is not running on this computer.")
    expect(steps[0]!.action?.label).toBe("Set up local Wisp")
  })
})

describe("exactly one primary action (§1)", () => {
  it("belongs to the FIRST outstanding step that can be acted on from here", () => {
    const steps = build({ harnesses: [harness("claude", [])], projectCount: 0 })

    // both are outstanding and both have an action; only one can be primary
    expect(steps.filter((s) => s.state !== "done" && s.action)).toHaveLength(2)
    expect(primaryStepKey(steps)).toBe("harness")
  })

  it("skips an outstanding step that has no action to give it", () => {
    const steps = build({
      daemon: { ready: false, problem: "stopped", summary: "" },
    })

    expect(primaryStepKey(steps)).toBe("daemon")
  })

  it("names nothing once every step is done", () => {
    const steps = build({})

    expect(allStepsDone(steps)).toBe(true)
    expect(primaryStepKey(steps)).toBeNull()
  })
})

describe("the agent row warns rather than gates", () => {
  it("leaves the project row actionable when no harness reported a model", () => {
    const steps = build({ harnesses: [harness("droid", [])], projectCount: 0 })
    const [agent, project] = [steps[0 + 1]!, steps[0 + 2]!]

    expect(agent).toMatchObject({
      state: "todo",
      detail: "No agent on this machine reported a model.",
      note: "Looked for droid.",
    })
    // installing a CLI happens in a terminal, and the row says so
    expect(agent.hint).toContain("Install one")
    expect(project.action?.label).toBe("Add project…")
  })

  it("names the usable agents, and keeps the unusable ones as a muted note", () => {
    const steps = build({
      harnesses: [harness("claude", ["opus"]), harness("droid", [])],
    })

    expect(steps[1]).toMatchObject({
      state: "done",
      detail: "claude",
      note: "droid not probed on this machine",
    })
  })

  it("offers another try when the list itself could not be read", () => {
    const steps = build({ harnesses: undefined, harnessesError: "503" })

    expect(steps[1]).toMatchObject({ state: "todo", note: "503" })
    expect(steps[1]!.action?.label).toBe("Check again")
  })

  it("says it is still asking rather than answering either way", () => {
    const steps = build({ harnesses: undefined, projectCount: undefined })

    expect(steps[1]).toMatchObject({ state: "todo", detail: "Checking…" })
    expect(steps[1]!.action).toBeUndefined()
    expect(steps[2]).toMatchObject({ state: "todo", detail: "Checking…" })
  })
})

describe("the project row", () => {
  it("counts what is registered", () => {
    expect(build({ projectCount: 1 })[2]!.detail).toBe("1 project")
    expect(build({ projectCount: 3 })[2]!.detail).toBe("3 projects")
  })

  it("keeps the CLI sentence for a client that cannot register one", () => {
    const steps = build({ projectCount: 0 }, { onAddProject: undefined })

    expect(steps[2]!.action).toBeUndefined()
    expect(steps[2]!.hint).toBe("Run wisp project add <path> on the daemon host.")
  })
})
