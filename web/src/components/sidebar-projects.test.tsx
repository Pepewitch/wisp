import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { Sidebar } from "./sidebar"
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

function mount(projectOrder?: ProjectOrder) {
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
      onNewTask={() => {}}
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
afterEach(() => vi.restoreAllMocks())

const press = (name: string, init: PointerEventInit = {}) =>
  fireEvent.pointerDown(toggle(name), { button: 0, pointerId: 1, pointerType: "mouse", clientX: 20, clientY: 10, ...init })
const move = (clientY: number) => fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY })
const release = (clientY: number) => fireEvent.pointerUp(window, { pointerId: 1, clientX: 20, clientY })

describe("reordering projects", () => {
  it("offers no menu and no drag when the daemon cannot save an order", () => {
    mount(undefined)

    expect(screen.queryByRole("button", { name: /^More for / })).toBeNull()
    expect(document.querySelector("[data-orderable]")).toBeNull()
    press("alpha")
    move(120)
    expect(dropLine()).toBeNull()
    release(120)
    fireEvent.click(toggle("alpha"))
    expect(toggle("alpha")).toHaveAttribute("aria-expanded", "false")
  })

  it("moves a project up or down from its menu, with the ends disabled", async () => {
    const projectOrder = order()
    mount(projectOrder)

    fireEvent.click(screen.getByRole("button", { name: "More for alpha" }))
    expect(await screen.findByRole("menuitem", { name: /Move up/ })).toHaveAttribute("aria-disabled", "true")
    fireEvent.click(screen.getByRole("menuitem", { name: /Move down/ }))
    expect(projectOrder.onReorder).toHaveBeenLastCalledWith("/src/alpha", { step: 1 })

    fireEvent.click(screen.getByRole("button", { name: "More for gamma" }))
    expect(await screen.findByRole("menuitem", { name: /Move down/ })).toHaveAttribute("aria-disabled", "true")
    fireEvent.click(screen.getByRole("menuitem", { name: /Move up/ }))
    expect(projectOrder.onReorder).toHaveBeenLastCalledWith("/src/gamma", { step: -1 })
  })

  it("a project known only from its tasks has no menu and does not drag", () => {
    mount(order())

    expect(screen.queryByRole("button", { name: "More for stray" })).toBeNull()
    expect(header("stray")).not.toHaveAttribute("data-orderable")
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

  it("a touch press never drags: the phone reorders from the menu", () => {
    const projectOrder = order()
    mount(projectOrder)

    press("alpha", { pointerType: "touch" })
    move(100)
    release(100)
    expect(dropLine()).toBeNull()
    expect(projectOrder.onReorder).not.toHaveBeenCalled()
  })

  it("shows a refused reorder inline until it is dismissed", () => {
    const projectOrder = order({ error: "Could not save the project order: The project list changed." })
    mount(projectOrder)

    expect(screen.getByText("Could not save the project order: The project list changed.")).toBeInTheDocument()
    act(() => fireEvent.click(screen.getByRole("button", { name: "Dismiss" })))
    expect(projectOrder.onDismissError).toHaveBeenCalledOnce()
  })
})
