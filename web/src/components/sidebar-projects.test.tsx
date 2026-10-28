import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { Sidebar } from "./sidebar"
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX } from "@/hooks/useProjectDrag"
import type { ProjectOrder } from "@/hooks/useProjectOrder"
import type { ProjectGroup } from "@/lib/projects"
import type { ApiTask } from "@/lib/types"
import { inertProjectSearch } from "@/test/project-search"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

const task = (id: string, repo: string) => ({ id, title: `task ${id}`, repo_path: repo, archived: false, state: "done" }) as ApiTask

function group(name: string, configured = true): ProjectGroup {
  const path = `/src/${name}`
  return { path, name, exists: true, unlisted: !configured, configured, tasks: [task(`t-${name}`, path)] }
}

const GROUPS = [group("alpha"), group("beta"), group("gamma"), group("stray", false)]

function mount(projectOrder?: ProjectOrder, onNewTask: (repoPath: string) => void = () => {}) {
  return render(
    <Sidebar
      groups={GROUPS}
      archivedTasks={[]}
      status={{}}
      pullRequests={{}}
      selectedId={null}
      onSelect={() => {}}
      showArchived={false}
      onShowArchivedChange={() => {}}
      onNewTask={onNewTask}
      onConfigureProject={() => {}}
      search={inertProjectSearch()}
      error={null}
      loading={false}
      projectOrder={projectOrder}
    />,
    { wrapper: runtimeWrapper(fakeDaemonTransport()) },
  )
}

const order = (overrides: Partial<ProjectOrder> = {}): ProjectOrder => ({
  onReorder: vi.fn(),
  pending: null,
  error: null,
  onDismissError: vi.fn(),
  ...overrides,
})
const header = (name: string) => document.querySelector<HTMLElement>(`[data-project-header][data-project-path="/src/${name}"]`)!
const toggle = (name: string) => header(name).querySelector<HTMLElement>("[aria-expanded]")!
const dropLine = () => document.querySelector<HTMLElement>("[data-drop-line]")

/**
 * jsdom lays nothing out, so the list is given one: each header 28px tall,
 * 40px apart, the list at the top of the viewport. A section ends where its
 * header does, as the dragged one does once its tasks fold away.
 */
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const headers = [...document.querySelectorAll("[data-project-header]")]
    const own = this.matches("[data-project-header]") ? this : this.matches("section") ? this.querySelector("[data-project-header]") : null
    const index = own ? headers.indexOf(own) : -1
    const top = index < 0 ? 0 : index * 40
    return { top, bottom: top + 28, height: 28, left: 0, right: 240, width: 240, x: 0, y: top, toJSON: () => ({}) } as DOMRect
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const press = (name: string, init: PointerEventInit = {}) =>
  fireEvent.pointerDown(toggle(name), { button: 0, pointerId: 1, pointerType: "mouse", clientX: 20, clientY: 10, ...init })
const move = (clientY: number) => fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY })
const release = (clientY: number) => fireEvent.pointerUp(window, { pointerId: 1, clientX: 20, clientY })

describe("reordering projects", () => {
  it("offers no drag, long press or move keys when the daemon cannot save an order", () => {
    vi.useFakeTimers()
    mount(undefined)

    expect(document.querySelector("[data-orderable]")).toBeNull()
    expect(toggle("alpha")).not.toHaveAttribute("aria-keyshortcuts")
    press("alpha")
    move(120)
    expect(dropLine()).toBeNull()
    release(120)
    press("beta", { pointerType: "touch" })
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS))
    expect(header("beta")).not.toHaveAttribute("data-dragging")
    release(10)
    fireEvent.click(toggle("alpha"))
    expect(toggle("alpha")).toHaveAttribute("aria-expanded", "false")
  })

  it("ends the header row with +, with no menu, and says how to move it", () => {
    mount(order())

    expect(screen.queryByRole("button", { name: /^More for / })).toBeNull()
    const buttons = [...header("alpha").querySelectorAll("button")]
    expect(buttons.at(-1)).toHaveAccessibleName("New task in alpha")
    expect(toggle("alpha")).toHaveAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown")
    expect(toggle("alpha")).toHaveAccessibleDescription(/^To reorder, drag the row, or press (Alt|Option)\+Up Arrow or (Alt|Option)\+Down Arrow\.$/)
  })

  it("a project known only from its tasks does not drag and offers no move keys", () => {
    mount(order())

    expect(header("stray")).not.toHaveAttribute("data-orderable")
    expect(toggle("stray")).not.toHaveAttribute("aria-keyshortcuts")
    expect(toggle("stray")).not.toHaveAttribute("aria-describedby")
  })

  it("Alt+↑ and Alt+↓ on a focused header move its project, and nothing past the ends", () => {
    const projectOrder = order()
    mount(projectOrder)

    fireEvent.keyDown(toggle("beta"), { key: "ArrowUp", altKey: true })
    expect(projectOrder.onReorder).toHaveBeenLastCalledWith("/src/beta", { step: -1 })
    fireEvent.keyDown(toggle("beta"), { key: "ArrowDown", altKey: true })
    expect(projectOrder.onReorder).toHaveBeenLastCalledWith("/src/beta", { step: 1 })

    fireEvent.keyDown(toggle("alpha"), { key: "ArrowUp", altKey: true })
    fireEvent.keyDown(toggle("gamma"), { key: "ArrowDown", altKey: true })
    // a bare arrow is the list's, not a move
    fireEvent.keyDown(toggle("beta"), { key: "ArrowDown" })
    expect(projectOrder.onReorder).toHaveBeenCalledTimes(2)
  })

  it("drags a header past the threshold, shows the drop line, and saves the order on release", () => {
    const projectOrder = order()
    mount(projectOrder)

    press("alpha")
    move(12)
    // under the threshold a press is still a click
    expect(header("alpha")).not.toHaveAttribute("data-dragging")
    expect(dropLine()).toBeNull()

    move(100) // below gamma's middle (80 + 14): the slot after the last project
    expect(header("alpha")).toHaveAttribute("data-dragging")
    // the dragged project's tasks fold away while it moves
    expect(screen.queryByText("task t-alpha")).toBeNull()
    expect(dropLine()).toHaveStyle({ top: "112px" })

    move(60) // below beta's middle (40 + 14): the slot before gamma
    expect(dropLine()).toHaveStyle({ top: "76px" })

    release(60)
    expect(projectOrder.onReorder).toHaveBeenCalledWith("/src/alpha", { to: 1 })
    expect(dropLine()).toBeNull()
    // the release's own click does not fold the project it landed on
    fireEvent.click(toggle("alpha"))
    expect(toggle("alpha")).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("task t-alpha")).toBeInTheDocument()
  })

  it("a drop back in its own slot saves nothing", () => {
    const projectOrder = order()
    mount(projectOrder)

    press("beta", { clientY: 50 })
    move(60)
    release(60)
    expect(projectOrder.onReorder).not.toHaveBeenCalled()
  })

  it("Escape cancels a drag, and its release neither saves nor folds", () => {
    const projectOrder = order()
    mount(projectOrder)

    press("alpha")
    move(100)
    expect(dropLine()).not.toBeNull()
    fireEvent.keyDown(window, { key: "Escape" })
    expect(dropLine()).toBeNull()
    expect(header("alpha")).not.toHaveAttribute("data-dragging")
    move(120)
    expect(dropLine()).toBeNull()

    release(120)
    fireEvent.click(toggle("alpha"))
    expect(projectOrder.onReorder).not.toHaveBeenCalled()
    expect(toggle("alpha")).toHaveAttribute("aria-expanded", "true")
  })

  it("shows a refused reorder inline until it is dismissed", () => {
    const projectOrder = order({ error: "Could not save the project order: The project list changed." })
    mount(projectOrder)

    expect(screen.getByText("Could not save the project order: The project list changed.")).toBeInTheDocument()
    act(() => fireEvent.click(screen.getByRole("button", { name: "Dismiss" })))
    expect(projectOrder.onDismissError).toHaveBeenCalledOnce()
  })
})

describe("reordering projects by touch", () => {
  beforeEach(() => vi.useFakeTimers())

  const touchDown = (name: string, clientY = 10) => press(name, { pointerType: "touch", clientY })
  const hold = (ms = LONG_PRESS_MS) => act(() => vi.advanceTimersByTime(ms))

  it("lifts a header held still, then drags it with the drop line and saves on release", () => {
    const vibrate = vi.fn()
    Object.defineProperty(navigator, "vibrate", { configurable: true, value: vibrate })
    const projectOrder = order()
    mount(projectOrder)

    touchDown("alpha")
    hold(LONG_PRESS_MS - 1)
    expect(header("alpha")).not.toHaveAttribute("data-dragging")
    // a few pixels of drift is still holding still
    move(13)
    hold(1)
    expect(header("alpha")).toHaveAttribute("data-dragging")
    expect(document.body).toHaveAttribute("data-project-drag")
    expect(vibrate).toHaveBeenCalledWith(10)
    // the line shows at once, in the slot the row lifted from
    expect(dropLine()).toHaveStyle({ top: "1px" })

    move(60)
    expect(dropLine()).toHaveStyle({ top: "76px" })
    release(60)
    expect(projectOrder.onReorder).toHaveBeenCalledWith("/src/alpha", { to: 1 })
    expect(header("alpha")).not.toHaveAttribute("data-dragging")
    expect(document.body).not.toHaveAttribute("data-project-drag")
    Reflect.deleteProperty(navigator, "vibrate")
  })

  it("a touch that moves before the hold is up never lifts", () => {
    const projectOrder = order()
    mount(projectOrder)

    touchDown("alpha")
    hold(200)
    move(10 + LONG_PRESS_SLOP_PX + 1)
    hold()
    expect(header("alpha")).not.toHaveAttribute("data-dragging")
    move(100)
    release(100)
    expect(dropLine()).toBeNull()
    expect(projectOrder.onReorder).not.toHaveBeenCalled()
  })

  it("a lifted row let go without moving changes nothing and does not fold", () => {
    const projectOrder = order()
    mount(projectOrder)

    // held over beta's lower half, where the slot measured is the one below it
    touchDown("beta", 60)
    hold()
    expect(header("beta")).toHaveAttribute("data-dragging")
    move(62)
    release(62)
    expect(projectOrder.onReorder).not.toHaveBeenCalled()
    expect(header("beta")).not.toHaveAttribute("data-dragging")
    fireEvent.click(toggle("beta"))
    expect(toggle("beta")).toHaveAttribute("aria-expanded", "true")
  })

  it("a tap still folds the project, and a tap on + still starts a task", () => {
    const onNewTask = vi.fn()
    mount(order(), onNewTask)

    touchDown("alpha")
    hold(100)
    release(10)
    fireEvent.click(toggle("alpha"))
    expect(toggle("alpha")).toHaveAttribute("aria-expanded", "false")

    const plus = screen.getByRole("button", { name: "New task in beta" })
    fireEvent.pointerDown(plus, { button: 0, pointerId: 1, pointerType: "touch", clientX: 200, clientY: 50 })
    hold(100)
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 200, clientY: 50 })
    fireEvent.click(plus)
    expect(onNewTask).toHaveBeenCalledWith("/src/beta")
    hold()
    expect(header("beta")).not.toHaveAttribute("data-dragging")
  })

  it("a lifted row keeps its finger: its touchmoves never scroll or reach the drawer", () => {
    mount(order())
    const outside = vi.fn()
    document.body.addEventListener("touchmove", outside)

    const before = new Event("touchmove", { bubbles: true, cancelable: true })
    toggle("alpha").dispatchEvent(before)
    expect(before.defaultPrevented).toBe(false)
    expect(outside).toHaveBeenCalledOnce()

    toggle("alpha").dispatchEvent(new Event("touchstart", { bubbles: true }))
    touchDown("alpha")
    hold()
    const after = new Event("touchmove", { bubbles: true, cancelable: true })
    toggle("alpha").dispatchEvent(after)
    expect(after.defaultPrevented).toBe(true)
    expect(outside).toHaveBeenCalledOnce()
    // and its release makes no click
    release(10)
    const end = new Event("touchend", { bubbles: true, cancelable: true })
    toggle("alpha").dispatchEvent(end)
    expect(end.defaultPrevented).toBe(true)
    document.body.removeEventListener("touchmove", outside)
  })

  it("Android's long-press context menu is held back while a finger is down", () => {
    mount(order())

    touchDown("alpha")
    hold()
    const menu = new Event("contextmenu", { bubbles: true, cancelable: true })
    toggle("alpha").dispatchEvent(menu)
    expect(menu.defaultPrevented).toBe(true)
    release(10)
  })
})
