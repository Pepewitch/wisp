import { afterEach, describe, expect, it, vi } from "vitest"

import type { TaskNotificationInput } from "./desktop-bridge"
import {
  applyTaskFocusRequest,
  describeTaskTransition,
  publishTaskTransitions,
  shouldNotify,
} from "./desktop-notifications"
import { readSelectedTask } from "./task-selection"
import type { TaskTransition } from "./task-transitions"
import type { ApiTask } from "./types"
import { uiIntentsFor } from "./ui-intents"

function transition(
  overrides: Partial<ApiTask> = {},
  to: ApiTask["state"] = "done"
): TaskTransition {
  const task = {
    id: "t1",
    title: "Fix the flaky test",
    state: to,
    state_detail: null,
    latest_turn_exit_code: null,
    latest_turn_has_result: false,
    archived: false,
    ...overrides,
  } as unknown as ApiTask
  return { task, from: "running", to }
}

afterEach(() => {
  localStorage.clear()
})

describe("notification policy", () => {
  it("stays quiet only for the task on screen in a focused window", () => {
    const onScreen = {
      windowFocused: true,
      activeConnectionId: "local",
      selectedTaskId: "t1",
    }
    expect(shouldNotify("local", "t1", onScreen)).toBe(false)
    expect(shouldNotify("local", "t2", onScreen)).toBe(true)
    expect(shouldNotify("remote", "t1", onScreen)).toBe(true)
    expect(
      shouldNotify("local", "t1", { ...onScreen, windowFocused: false })
    ).toBe(true)
  })

  it("words the banner as the task title and the honest state word", () => {
    expect(describeTaskTransition(transition(), "Local")).toEqual({
      title: "Fix the flaky test",
      body: "Done · Local",
    })
    expect(
      describeTaskTransition(transition({}, "needs-input"), "Office").body
    ).toBe("Needs input · Office")
    expect(
      describeTaskTransition(
        transition(
          { latest_turn_has_result: true, latest_turn_exit_code: 2 },
          "failed"
        ),
        "Local"
      ).body
    ).toBe("Exited 2 · Local")
    expect(
      describeTaskTransition(transition({ title: "  " }), "Local").title
    ).toBe("Untitled task")
  })

  it("posts one notification per transition that passes the policy", () => {
    const sent: TaskNotificationInput[] = []
    const bridge = {
      notifyTaskTransition: vi.fn(async (input: TaskNotificationInput) => {
        sent.push(input)
      }),
    }
    const published = publishTaskTransitions({
      bridge,
      connectionId: "local",
      connectionName: "Local",
      transitions: [
        transition({ id: "shown" }),
        transition({ id: "hidden", title: "Background work" }, "failed"),
      ],
      context: {
        windowFocused: true,
        activeConnectionId: "local",
        selectedTaskId: "shown",
      },
    })
    expect(published).toEqual([
      {
        connectionId: "local",
        taskId: "hidden",
        title: "Background work",
        body: "Failed · Local",
      },
    ])
    expect(sent).toEqual(published)
  })

  it("survives a refused notification", async () => {
    const bridge = {
      notifyTaskTransition: vi.fn(() =>
        Promise.reject(new Error("no bundle identifier"))
      ),
    }
    expect(() =>
      publishTaskTransitions({
        bridge,
        connectionId: "local",
        connectionName: "Local",
        transitions: [transition()],
        context: {
          windowFocused: false,
          activeConnectionId: "local",
          selectedTaskId: null,
        },
      })
    ).not.toThrow()
    await Promise.resolve()
    expect(bridge.notifyTaskTransition).toHaveBeenCalledTimes(1)
  })
})

describe("focus requests", () => {
  it("asks the mounted view to move when its connection is already active", () => {
    const select = vi.fn(async () => undefined)
    const intents = uiIntentsFor("focus-active")
    const before = intents.taskFocusRequest()?.seq ?? 0

    const applied = applyTaskFocusRequest(
      { connectionId: "focus-active", taskId: "t9" },
      {
        connectionIds: ["focus-active", "other"],
        activeConnectionId: "focus-active",
        select,
      }
    )

    expect(applied).toBe(true)
    expect(readSelectedTask("focus-active")).toBe("t9")
    expect(intents.taskFocusRequest()).toEqual({
      taskId: "t9",
      seq: before + 1,
    })
    expect(select).not.toHaveBeenCalled()
  })

  it("persists the selection and switches tabs for an inactive connection", () => {
    const select = vi.fn(async () => undefined)
    const applied = applyTaskFocusRequest(
      { connectionId: "focus-inactive", taskId: "t3" },
      {
        connectionIds: ["local", "focus-inactive"],
        activeConnectionId: "local",
        select,
      }
    )
    expect(applied).toBe(true)
    expect(readSelectedTask("focus-inactive")).toBe("t3")
    expect(select).toHaveBeenCalledWith("focus-inactive")
    expect(uiIntentsFor("focus-inactive").taskFocusRequest()).toBeNull()
  })

  it("drops a request for a connection this shell does not have", () => {
    const select = vi.fn(async () => undefined)
    expect(
      applyTaskFocusRequest(
        { connectionId: "gone", taskId: "t1" },
        { connectionIds: ["local"], activeConnectionId: "local", select }
      )
    ).toBe(false)
    expect(readSelectedTask("gone")).toBeNull()
    expect(select).not.toHaveBeenCalled()
  })
})
