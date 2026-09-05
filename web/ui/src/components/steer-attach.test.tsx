import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import type { ApiTask } from "@/lib/types"
import { fakeDaemonTransport, runtimeWrapper } from "@/test/runtime"

import { SteerBox } from "./steer-box"

/**
 * A1a fixed a dead control: the steer box shipped a paperclip that was wired to
 * nothing and a textarea with no paste handler, so the one box you steer from
 * could not take an image at all. A button that looks available and does nothing
 * is the failure mode this product refuses, so it gets a test.
 */

/** The box owns its own writes now (A2), so every render needs a client. */
function render_(node: ReactNode) {
  return render(node, { wrapper: runtimeWrapper(fakeDaemonTransport()) })
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(24).fill(1)])

const task = (over: Partial<ApiTask> = {}): ApiTask =>
  ({
    id: "tk9zdy",
    title: "steer",
    harness: "codex",
    model: "gpt-5",
    state: "done",
    state_detail: null,
    archived: false,
    turn_count: 1,
    seq: 4,
    branch: "wisp/tk9zdy-steer",
    worktree_path: "/tmp/wt",
    repo_path: "/tmp/repo",
    ...over,
  }) as ApiTask

const pngFile = () => new File([PNG], "shot.png", { type: "image/png" })

describe("SteerBox agent metadata", () => {
  it("keeps the task's selected effort visible after its model", () => {
    render_(<SteerBox task={task({ effort: "xhigh" })} hasImage onSend={() => {}} />)
    const effort = screen.getByText("xhigh effort")
    expect(effort.parentElement?.textContent).toMatch(/codex.*gpt-5.*xhigh effort/)
  })
})

describe("SteerBox attachments", () => {
  it("the paperclip opens a real file input and a picked image becomes a pending row", async () => {
    render_(<SteerBox task={task()} hasImage onSend={() => {}} />)

    const input = screen.getByTestId("attach-input") as HTMLInputElement
    expect(input.accept).toBe("image/png,image/jpeg,image/gif,image/webp")
    expect(input.multiple).toBe(true)

    fireEvent.change(input, { target: { files: [pngFile()] } })

    await waitFor(() => expect(screen.getByTestId("pending-attachment")).toBeTruthy())
    expect(screen.getByTestId("pending-attachments").textContent).toContain("shot.png")
    expect(screen.getByTestId("pending-attachments").textContent).toContain("32 B")
  })

  it("a picked image rides along with the message and the box clears after", async () => {
    const onSend = vi.fn()
    render_(<SteerBox task={task()} hasImage onSend={onSend} />)

    fireEvent.change(screen.getByTestId("attach-input"), { target: { files: [pngFile()] } })
    await waitFor(() => expect(screen.getByTestId("pending-attachment")).toBeTruthy())

    const box = screen.getByPlaceholderText("Ask for changes, or / for commands")
    fireEvent.change(box, { target: { value: "look at this" } })
    fireEvent.click(screen.getByLabelText("Send"))

    expect(onSend).toHaveBeenCalledWith("look at this", [{ name: "shot.png", dataBase64: expect.any(String) }])
    // the queue clears only once the send has RESOLVED — a refusal keeps it
    await waitFor(() => expect(screen.queryByTestId("pending-attachment")).toBeNull())
  })

  it("a plain message sends no attachments field at all", () => {
    const onSend = vi.fn()
    render_(<SteerBox task={task()} hasImage onSend={onSend} />)
    fireEvent.change(screen.getByPlaceholderText("Ask for changes, or / for commands"), {
      target: { value: "just text" },
    })
    fireEvent.click(screen.getByLabelText("Send"))
    expect(onSend).toHaveBeenCalledWith("just text", undefined)
  })

  it("a harness without image capability disables the paperclip and says why", () => {
    render_(<SteerBox task={task({ harness: "opencode" })} hasImage={false} onSend={() => {}} />)
    const button = screen.getByLabelText("Attach an image")
    expect(button).toBeDisabled()
    expect(button.getAttribute("title")).toBe("harness 'opencode' has no image-attachment capability")
  })

  it("A1c: the harness's delivery caveat shows only once an image is pending", async () => {
    // the strategy's note is harness-generic (it serves droid AND cursor)
    const note = "this harness has no image flag: wisp names the file's path in the prompt and the harness reads it."
    render_(<SteerBox task={task({ harness: "droid" })} hasImage imageNote={note} onSend={() => {}} />)
    // nothing attached yet — a caveat about images with no images is noise
    expect(screen.queryByTestId("attachment-note")).toBeNull()
    const box = screen.getByPlaceholderText("Ask for changes, or / for commands")
    fireEvent.paste(box, { clipboardData: { files: [pngFile()], getData: () => "" } })
    await waitFor(() => expect(screen.getByTestId("pending-attachment")).toBeTruthy())
    expect(screen.getByTestId("attachment-note").textContent).toBe(note)
  })

  it("pasting an image attaches it instead of inserting junk text", async () => {
    render_(<SteerBox task={task()} hasImage onSend={() => {}} />)
    const box = screen.getByPlaceholderText("Ask for changes, or / for commands")
    fireEvent.paste(box, { clipboardData: { files: [pngFile()], getData: () => "" } })
    await waitFor(() => expect(screen.getByTestId("pending-attachment")).toBeTruthy())
    expect((box as HTMLTextAreaElement).value).toBe("")
  })

  it("pasting Slack-style HTML hyperlinks inserts markdown links, not the label alone", () => {
    render_(<SteerBox task={task()} hasImage onSend={() => {}} />)
    const box = screen.getByPlaceholderText("Ask for changes, or / for commands") as HTMLTextAreaElement
    fireEvent.paste(box, {
      clipboardData: {
        files: [],
        getData: (type: string) =>
          type === "text/html"
            ? `<ol><li><a href="https://example.com/issues/APP-101">APP-101: improve retry handling</a></li></ol>`
            : "APP-101: improve retry handling",
      },
    })
    expect(box.value).toBe("1. [APP-101: improve retry handling](https://example.com/issues/APP-101)")
  })
})
