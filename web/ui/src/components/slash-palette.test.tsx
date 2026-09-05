import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "@/lib/api"
import type { ApiTask, StatusEntry, TaskSkills, Turn } from "@/lib/types"

import { SteerBox } from "./steer-box"

/** claude's registry as the daemon answers it (A4) — fixture, not hardcoded UI */
const SKILLS: TaskSkills = {
  skills: [
    { name: "code-review", description: "Review code changes and find bugs" },
    { name: "security-review", description: "Security review of pending changes" },
    { name: "simplify", description: "Reuse, quality, and efficiency pass" },
  ],
  errors: [],
  partialNote: null,
  invoke: "slash",
  probedAt: "2026-08-30T12:00:00Z",
  cached: false,
}

const SUFFIX_PROMPT = {
  id: "suffix-review",
  name: "Intensive review",
  prompt: "Inspect correctness and security.",
  createdAt: "2026-09-01T00:00:00.000Z",
}

/**
 * The `/` palette (A2) and the note row it reports into.
 *
 * What is worth asserting here is the CONTRACT, not cmdk: what opens the list,
 * what closes it, what a dismissal does to the words already typed (nothing),
 * what a pick does to them (only a pick consumes the token), which tier is
 * marked as costing a turn, and where a daemon refusal lands.
 */

const task = (over: Partial<ApiTask> = {}): ApiTask =>
  ({
    id: "tk9zdy",
    title: "steer",
    repo_path: "/tmp/repo",
    worktree_path: "/tmp/wt",
    branch: "wisp/tk9zdy-steer",
    base_commit: "8f2a1c9",
    harness: "claude",
    model: "claude-sonnet-4-6",
    effort: null,
    slot: 1,
    state: "done",
    state_detail: null,
    session_id: "s-1",
    seq: 4,
    turn_count: 3,
    archived: false,
    mode: "worktree",
    created_at: "2026-08-30T00:00:00Z",
    updated_at: "2026-08-30T00:00:00Z",
    ...over,
  }) as ApiTask

const GIT: StatusEntry = {
  branch: "wisp/tk9zdy-steer",
  dirtyFiles: 2,
  ahead: 1,
  unpushed: true,
  worktreeReason: null,
}

function mount(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrap = (n: ReactNode) => <QueryClientProvider client={client}>{n}</QueryClientProvider>
  const result = render(wrap(node))
  return { ...result, rerender: (n: ReactNode) => result.rerender(wrap(n)) }
}

function box(): HTMLTextAreaElement {
  return screen.getByPlaceholderText("Ask for changes, or / for commands") as HTMLTextAreaElement
}

/** Typing, with the caret where a real caret would be. */
function type(text: string, caret = text.length) {
  fireEvent.change(box(), { target: { value: text, selectionStart: caret } })
}

/** The fetch stub the API client sees; records every call, answers per path. */
interface Call {
  path: string
  method: string
  body: unknown
}
function stubApi(handler: (path: string, method: string) => { status: number; body: unknown }): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      const method = init?.method ?? "GET"
      calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const { status, body } = handler(path, method)
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    }),
  )
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("opening and closing", () => {
  it("`/` on an empty draft opens the palette with all of a claude task's tiers", async () => {
    mount(<SteerBox task={task()} skills={SKILLS} onSend={async () => {}} />)
    expect(screen.queryByTestId("slash-palette")).toBeNull()

    type("/")
    expect(await screen.findByTestId("slash-palette")).toBeInTheDocument()
    expect(screen.getByText("Wisp")).toBeInTheDocument()
    expect(screen.getByText("Skills")).toBeInTheDocument()
    expect(screen.getByTestId("slash-status")).toBeInTheDocument()
    expect(screen.getByTestId("slash-tokens")).toBeInTheDocument()
    expect(screen.getByTestId("slash-code-review")).toBeInTheDocument()
    // /diff is gone: the Changes pane IS the diff and is always on screen
    expect(screen.queryByTestId("slash-diff")).toBeNull()
  })

  it("anchors the palette to the same content-width wrapper as the composer", async () => {
    mount(<SteerBox task={task()} onSend={async () => {}} />)
    type("/")
    const palette = await screen.findByTestId("slash-palette")

    expect(palette.parentElement).toBe(box().parentElement?.parentElement)
    expect(palette).toHaveClass("inset-x-0")
  })

  it("a task whose skills haven't answered yet renders no Skills group — an empty tier is absent, not empty", async () => {
    mount(<SteerBox task={task({ harness: "codex" })} onSend={async () => {}} />)
    type("/")
    await screen.findByTestId("slash-palette")
    expect(screen.getByText("Wisp")).toBeInTheDocument()
    expect(screen.queryByText("Skills")).toBeNull()
    expect(screen.getByTestId("slash-status")).toBeInTheDocument()
  })

  it("a slash token mid-draft opens too, and the filter narrows as it grows", async () => {
    mount(<SteerBox task={task()} onSend={async () => {}} />)
    type("hello")
    expect(screen.queryByTestId("slash-palette")).toBeNull()

    type("hello /")
    await screen.findByTestId("slash-palette")

    type("hello /st")
    await waitFor(() => expect(screen.queryByTestId("slash-archive")).toBeNull())
    expect(screen.getByTestId("slash-status")).toBeInTheDocument()
  })

  it("a word with a slash inside it is a word, not a command", () => {
    mount(<SteerBox task={task()} onSend={async () => {}} />)
    type("src/lib")
    expect(screen.queryByTestId("slash-palette")).toBeNull()
  })

  it("escape closes, keeps the typed text, and stays closed while that token grows", async () => {
    mount(<SteerBox task={task()} onSend={async () => {}} />)
    type("/st")
    await screen.findByTestId("slash-palette")

    fireEvent.keyDown(box(), { key: "Escape" })
    expect(screen.queryByTestId("slash-palette")).toBeNull()
    // the palette never deletes typed text — `/st` is just words now
    expect(box().value).toBe("/st")

    type("/sta")
    expect(screen.queryByTestId("slash-palette")).toBeNull()

    // …but a NEW token is a new question
    type("/sta /")
    expect(await screen.findByTestId("slash-palette")).toBeInTheDocument()
  })

  it("a space closes it even with nothing matched, and leaves the draft alone", async () => {
    mount(<SteerBox task={task()} onSend={async () => {}} />)
    type("/zzz")
    await screen.findByTestId("slash-palette")
    expect(screen.getByText("No matching command")).toBeInTheDocument()

    type("/zzz ")
    expect(screen.queryByTestId("slash-palette")).toBeNull()
    expect(box().value).toBe("/zzz ")
  })

  it("the caret leaving the token closes it", async () => {
    mount(<SteerBox task={task()} onSend={async () => {}} />)
    type("look /st")
    await screen.findByTestId("slash-palette")

    const el = box()
    el.selectionStart = 0
    el.selectionEnd = 0
    fireEvent.keyUp(el, { key: "Home" })
    expect(screen.queryByTestId("slash-palette")).toBeNull()
  })

  it("never opens on an archived task — the box is read-only", () => {
    mount(<SteerBox task={task({ archived: true })} onSend={async () => {}} />)
    const el = screen.getByPlaceholderText("This task is read-only") as HTMLTextAreaElement
    expect(el.disabled).toBe(true)
    fireEvent.change(el, { target: { value: "/", selectionStart: 1 } })
    expect(screen.queryByTestId("slash-palette")).toBeNull()
  })
})

describe("keyboard and picking", () => {
  it("↓ then ↵ picks the second row, and Enter never sends while the palette is open", async () => {
    const onSend = vi.fn(async () => {})
    mount(<SteerBox task={task()} onSend={onSend} />)
    type("/")
    await screen.findByTestId("slash-palette")

    // the list opens on /status; one ArrowDown lands on /log
    fireEvent.keyDown(box(), { key: "ArrowDown" })
    fireEvent.keyDown(box(), { key: "Enter" })

    expect(await screen.findByTestId("steer-note")).toHaveTextContent("pinned to the live tail")
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.queryByTestId("slash-palette")).toBeNull()
    expect(box().value).toBe("")
  })

  it("with the palette closed, Enter still sends", async () => {
    const onSend = vi.fn(async () => {})
    mount(<SteerBox task={task()} onSend={onSend} />)
    type("just words")
    fireEvent.keyDown(box(), { key: "Enter" })
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("just words", undefined))
  })

  it("picking a Tier-1 command consumes ONLY the token", async () => {
    mount(<SteerBox task={task()} status={GIT} onSend={async () => {}} />)
    type("hello /st")
    await screen.findByTestId("slash-palette")
    fireEvent.click(screen.getByTestId("slash-status"))

    expect(box().value).toBe("hello ")
    expect(await screen.findByTestId("steer-note")).toHaveTextContent(
      "done · turn 3 · claude · claude-sonnet-4-6 · wisp/tk9zdy-steer · 2 dirty ↑1 unpushed",
    )
  })

  it("a Tier-3 pick prefills the draft and sends nothing at all", async () => {
    const onSend = vi.fn(async () => {})
    const calls = stubApi(() => ({ status: 200, body: { ok: true } }))
    mount(<SteerBox task={task()} skills={SKILLS} onSend={onSend} />)
    type("/code")
    await screen.findByTestId("slash-palette")
    fireEvent.click(screen.getByTestId("slash-code-review"))

    expect(box().value).toBe("/code-review") // no trailing space: a skill takes arguments
    expect(screen.queryByTestId("slash-palette")).toBeNull()
    expect(onSend).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it("a codex skill pick prefills a plain-text ask — no fake slash (SP2: codex has no headless /name)", async () => {
    const onSend = vi.fn(async () => {})
    const codexSkills: TaskSkills = {
      skills: [{ name: "openai-docs", description: "Codex models, pricing, skills" }],
      errors: [],
      partialNote: null,
      invoke: "prompt",
      probedAt: "2026-08-30T12:00:00Z",
      cached: false,
    }
    mount(<SteerBox task={task({ harness: "codex" })} skills={codexSkills} onSend={onSend} />)
    type("/open")
    await screen.findByTestId("slash-palette")
    // and the ROW shows no fake slash either
    expect(screen.getByTestId("slash-openai-docs")).toHaveTextContent("openai-docs")
    expect(screen.getByTestId("slash-openai-docs")).not.toHaveTextContent("/openai-docs")
    fireEvent.click(screen.getByTestId("slash-openai-docs"))

    expect(box().value).toBe("use the openai-docs skill: ")
    expect(onSend).not.toHaveBeenCalled()
  })

  it("the harness's skipped skills are confessed in a muted row, never silently absent", async () => {
    const withErrors: TaskSkills = {
      ...SKILLS,
      errors: ["/bad/SKILL.md: Missing 'description' in frontmatter", "/worse/SKILL.md: Invalid YAML"],
    }
    mount(<SteerBox task={task()} skills={withErrors} onSend={async () => {}} />)
    type("/")
    await screen.findByTestId("slash-palette")
    const row = screen.getByText("2 skills skipped by the harness")
    expect(row.getAttribute("title")).toContain("Missing 'description' in frontmatter")
  })

  it("a partial list says it is partial (claude before its first turn)", async () => {
    const partial: TaskSkills = {
      ...SKILLS,
      skills: [{ name: "my-skill", description: "a personal skill" }],
      partialNote: "user and project skills only — no session has reported its builtins yet",
    }
    mount(<SteerBox task={task()} skills={partial} onSend={async () => {}} />)
    type("/")
    await screen.findByTestId("slash-palette")
    expect(screen.getByText("user and project skills only — no session has reported its builtins yet")).toBeInTheDocument()
    expect(screen.getByTestId("slash-my-skill")).toBeInTheDocument()
  })

  it("only the tier that costs a turn says so", async () => {
    mount(<SteerBox task={task()} skills={SKILLS} onSend={async () => {}} />)
    type("/")
    await screen.findByTestId("slash-palette")
    expect(screen.getByTestId("slash-code-review")).toHaveTextContent("runs a turn")
    for (const name of ["status", "log", "interrupt", "archive", "push", "attach", "fresh"]) {
      expect(screen.getByTestId(`slash-${name}`)).not.toHaveTextContent("runs a turn")
    }
  })
})

describe("Tier-1 dispatch", () => {
  it("typing /tokens then Enter opens Cursor task totals instead of sending a prompt", async () => {
    const onSend = vi.fn(async () => {})
    const turns = [
      { id: 1, n: 1, usage: { inputTokens: 10_000, outputTokens: 100, cachedInputTokens: 3_000 } },
      { id: 2, n: 2, usage: { inputTokens: 5_000, outputTokens: 50 } },
    ] as Turn[]
    mount(
      <SteerBox
        task={task({ harness: "cursor", model: "cursor-grok-4.6-high" })}
        turns={turns}
        onSend={onSend}
      />,
    )

    type("/tokens")
    await screen.findByTestId("slash-palette")
    fireEvent.keyDown(box(), { key: "Enter" })

    const panel = await screen.findByTestId("tokens-panel")
    expect(panel).toHaveTextContent("Task total")
    expect(screen.getByTestId("tokens-total")).toHaveTextContent("15.0k in · 150 out · 3.0k cached")
    expect(panel).toHaveTextContent("Sum of 2 reporting turns")
    expect(panel).toHaveTextContent("This is not an account subscription, quota, or cost gauge")
    expect(panel.parentElement).toBe(box().parentElement?.parentElement)
    expect(onSend).not.toHaveBeenCalled()
    expect(box().value).toBe("")

    fireEvent.keyDown(box(), { key: "Escape" })
    expect(screen.queryByTestId("tokens-panel")).toBeNull()
  })

  it("/tokens explains when Cursor has not reported a settled turn yet", async () => {
    mount(
      <SteerBox
        task={task({ harness: "cursor", model: "cursor-grok-4.6-high" })}
        turns={[]}
        onSend={async () => {}}
      />,
    )
    type("/tokens")
    await screen.findByTestId("slash-palette")
    fireEvent.click(screen.getByTestId("slash-tokens"))

    expect(await screen.findByTestId("tokens-panel")).toHaveTextContent(
      "No turn has reported token usage yet. Usage arrives after a turn settles.",
    )
  })

  it("/interrupt POSTs, and its 409 is an expected state — muted, never red", async () => {
    let refuse = false
    const calls = stubApi(() =>
      refuse ? { status: 409, body: { error: "no turn is running" } } : { status: 200, body: { ok: true } },
    )
    mount(<SteerBox task={task({ state: "running" })} onSend={async () => {}} />)

    type("/interrupt")
    await screen.findByTestId("slash-palette")
    fireEvent.click(screen.getByTestId("slash-interrupt"))
    expect(await screen.findByTestId("steer-note")).toHaveTextContent("interrupt sent")
    expect(calls).toEqual([
      { path: "/api/tasks/tk9zdy/interrupt", method: "POST", body: undefined },
    ])

    refuse = true
    type("/interrupt")
    await screen.findByTestId("slash-palette")
    fireEvent.click(screen.getByTestId("slash-interrupt"))
    const note = await screen.findByTestId("steer-note")
    await waitFor(() => expect(note).toHaveTextContent("no turn is running"))
    expect(note.className).toContain("text-muted-foreground")
    expect(note.className).not.toContain("text-destructive")
  })

  it("/push names the branch and keeps git's output on hover", async () => {
    stubApi(() => ({ status: 200, body: { ok: true, output: " To origin\n * [new branch] wisp/tk9zdy-steer\n" } }))
    mount(<SteerBox task={task()} onSend={async () => {}} />)
    type("/push")
    await screen.findByTestId("slash-palette")
    fireEvent.click(screen.getByTestId("slash-push"))

    const note = await screen.findByTestId("steer-note")
    await waitFor(() => expect(note).toHaveTextContent("pushed wisp/tk9zdy-steer"))
    expect(note.getAttribute("title")).toContain("[new branch]")
  })

  it("/archive refuses into the shared dialog, and Archive anyway forces it", async () => {
    let refuse = true
    const calls = stubApi(() =>
      refuse
        ? { status: 409, body: { error: "task has unpushed commits — push first, or archive with force" } }
        : { status: 200, body: { ok: true } },
    )
    mount(<SteerBox task={task()} onSend={async () => {}} />)
    type("/archive")
    await screen.findByTestId("slash-palette")
    fireEvent.click(screen.getByTestId("slash-archive"))

    expect(await screen.findByText("task has unpushed commits — push first, or archive with force")).toBeInTheDocument()
    expect(calls[0]).toEqual({ path: "/api/tasks/tk9zdy/archive", method: "POST", body: { force: false } })

    refuse = false
    fireEvent.click(screen.getByRole("button", { name: "Archive anyway" }))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1]).toEqual({ path: "/api/tasks/tk9zdy/archive", method: "POST", body: { force: true } })
  })

  it("/fresh fires immediately — there is no second confirm", async () => {
    const calls = stubApi(() => ({ status: 200, body: { id: "tk9zdy", session_id: null } }))
    mount(<SteerBox task={task()} onSend={async () => {}} />)
    type("/fresh")
    await screen.findByTestId("slash-palette")
    fireEvent.click(screen.getByTestId("slash-fresh"))

    expect(await screen.findByTestId("steer-note")).toHaveTextContent("session cleared — the next turn starts fresh")
    expect(calls[0]?.path).toBe("/api/tasks/tk9zdy/fresh-session")
  })

  it("/attach puts the assembled command in the note, with a copy button", async () => {
    stubApi(() => ({ status: 200, body: { argv: ["claude", "--resume", "s-1"], cwd: "/tmp/wt", message: null } }))
    mount(<SteerBox task={task()} onSend={async () => {}} />)
    type("/attach")
    await screen.findByTestId("slash-palette")
    fireEvent.click(screen.getByTestId("slash-attach"))

    const note = await screen.findByTestId("steer-note")
    await waitFor(() => expect(note).toHaveTextContent("cd /tmp/wt && claude --resume s-1"))
    expect(screen.getByLabelText("Copy")).toBeInTheDocument()
  })

  it("/attach without a session says the daemon's own message and offers no copy", async () => {
    stubApi(() => ({ status: 200, body: { argv: null, cwd: null, message: "no session yet" } }))
    mount(<SteerBox task={task({ session_id: null })} onSend={async () => {}} />)
    type("/attach")
    await screen.findByTestId("slash-palette")
    fireEvent.click(screen.getByTestId("slash-attach"))

    const note = await screen.findByTestId("steer-note")
    await waitFor(() => expect(note).toHaveTextContent("no session yet"))
    expect(screen.queryByLabelText("Copy")).toBeNull()
  })

  it("a note belongs to the task that produced it — a switch never shows it under another", async () => {
    const { rerender } = mount(<SteerBox task={task()} status={GIT} onSend={async () => {}} />)
    type("hello /status")
    await screen.findByTestId("slash-palette")
    fireEvent.click(screen.getByTestId("slash-status"))
    await screen.findByTestId("steer-note")

    rerender(<SteerBox task={task({ id: "tppxvp" })} onSend={async () => {}} />)
    expect(screen.queryByTestId("steer-note")).toBeNull()
    // …but the draft is the user's words, and it survives the switch
    expect(box().value).toBe("hello ")
  })
})

describe("a refused send", () => {
  it("renders the daemon's reason muted and keeps both the draft and the images", async () => {
    const onSend = vi.fn(async () => {
      throw new ApiError("turn 3 is still running", 409)
    })
    mount(<SteerBox task={task()} onSend={onSend} />)
    type("one more thing")
    fireEvent.click(screen.getByLabelText("Send"))

    const note = await screen.findByTestId("steer-note")
    expect(note).toHaveTextContent("turn 3 is still running")
    expect(note.className).toContain("text-muted-foreground")
    expect(box().value).toBe("one more thing")
    expect(box().disabled).toBe(false)
  })

  it("a real failure earns destructive", async () => {
    const onSend = vi.fn(async () => {
      throw new ApiError("unknown harness: droid", 500)
    })
    mount(<SteerBox task={task()} onSend={onSend} />)
    type("go")
    fireEvent.click(screen.getByLabelText("Send"))

    const note = await screen.findByTestId("steer-note")
    expect(note).toHaveTextContent("unknown harness: droid")
    expect(note.className).toContain("text-destructive")
    expect(box().value).toBe("go")
  })

  it("a successful send clears the draft and the note", async () => {
    let fail = true
    const onSend = vi.fn(async () => {
      if (fail) throw new ApiError("turn 3 is still running", 409)
    })
    mount(<SteerBox task={task()} onSend={onSend} />)
    type("again")
    fireEvent.click(screen.getByLabelText("Send"))
    await screen.findByTestId("steer-note")

    fail = false
    fireEvent.click(screen.getByLabelText("Send"))
    await waitFor(() => expect(box().value).toBe(""))
    expect(screen.queryByTestId("steer-note")).toBeNull()
  })

  it("the default send posts to /api/tasks/:id/send — no wiring left at the call site", async () => {
    const calls = stubApi(() => ({ status: 200, body: { id: "tk9zdy" } }))
    mount(<SteerBox task={task()} />)
    type("do the thing")
    fireEvent.click(screen.getByLabelText("Send"))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({
      path: "/api/tasks/tk9zdy/send",
      method: "POST",
      body: {
        message: "do the thing",
        clientMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    })
    await waitFor(() => expect(box().value).toBe(""))
  })
})

describe("steer suffix prompts", () => {
  async function pickSuffix() {
    fireEvent.click(screen.getByRole("button", { name: "Suffix prompt" }))
    fireEvent.click(await screen.findByText(SUFFIX_PROMPT.name))
  }

  it("sends the selected id without changing the draft, then resets after success", async () => {
    stubApi(() => ({ status: 200, body: { suffixPrompts: [SUFFIX_PROMPT] } }))
    const onSend = vi.fn(async () => {})
    mount(<SteerBox task={task()} onSend={onSend} />)
    type("Review this change")

    await pickSuffix()
    expect(box().value).toBe("Review this change")
    expect(screen.getByRole("button", { name: SUFFIX_PROMPT.name })).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText("Send"))
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("Review this change", undefined, SUFFIX_PROMPT.id),
    )
    await waitFor(() => expect(screen.getByRole("button", { name: "Suffix prompt" })).toBeInTheDocument())
  })

  it("keeps the suffix and draft after refusal, but resets the suffix on a task switch", async () => {
    stubApi(() => ({ status: 200, body: { suffixPrompts: [SUFFIX_PROMPT] } }))
    const onSend = vi.fn(async () => {
      throw new ApiError("turn is still running", 409)
    })
    const { rerender } = mount(<SteerBox task={task()} onSend={onSend} />)
    type("Review this change")
    await pickSuffix()

    fireEvent.click(screen.getByLabelText("Send"))
    await screen.findByTestId("steer-note")
    expect(box().value).toBe("Review this change")
    expect(screen.getByRole("button", { name: SUFFIX_PROMPT.name })).toBeInTheDocument()

    rerender(<SteerBox task={task({ id: "next-task" })} onSend={onSend} />)
    expect(box().value).toBe("Review this change")
    expect(screen.getByRole("button", { name: "Suffix prompt" })).toBeInTheDocument()
  })
})

describe("Tier 2 — the harness's own reads (A3)", () => {
  const MARKDOWN_ANSWER = {
    command: "context",
    probedAt: "2026-08-30T12:00:00Z",
    cached: false,
    report: { format: "markdown", text: "## Context Usage\n\n**Tokens:** 13.3k / 1m" },
  }

  it("a claude task keeps /tokens under Wisp and the familiar /usage under the harness", async () => {
    mount(<SteerBox task={task()} probeCommands={["context", "usage"]} onSend={async () => {}} />)
    type("/")
    await screen.findByTestId("slash-palette")
    // the Tier-2 group is headed by the harness, not "Wisp" — a relayed claim,
    // not a recorded fact (Q5). Scoped to the palette: the composer's footer
    // names the harness too.
    expect(within(screen.getByTestId("slash-palette")).getByText("claude")).toBeInTheDocument()
    expect(screen.getByTestId("slash-probe:context")).toBeInTheDocument()
    expect(screen.getByTestId("slash-tokens")).toBeInTheDocument()
    expect(screen.getByTestId("slash-probe:usage")).toBeInTheDocument()
    expect(screen.queryByTestId("slash-usage")).toBeNull()
    // and a read is free: no "runs a turn" on either
    expect(screen.getByTestId("slash-probe:context")).not.toHaveTextContent("runs a turn")
  })

  it("typing /usage then Enter runs the harness's plan and limits probe", async () => {
    const calls = stubApi(() => ({
      status: 200,
      body: {
        command: "usage",
        probedAt: "2026-09-04T12:00:00Z",
        cached: false,
        report: { format: "markdown", text: "Current session: 41% used" },
      },
    }))
    const onSend = vi.fn(async () => {})
    mount(<SteerBox task={task()} probeCommands={["context", "usage"]} onSend={onSend} />)

    type("/")
    await screen.findByTestId("slash-palette")
    type("/usage")
    await waitFor(() => expect(screen.getByTestId("slash-probe:usage")).toHaveAttribute("data-selected"))
    fireEvent.keyDown(box(), { key: "Enter" })

    const panel = await screen.findByTestId("probe-panel")
    await waitFor(() => expect(panel).toHaveTextContent("Current session: 41% used"))
    expect(calls).toEqual([
      { path: "/api/tasks/tk9zdy/probe", method: "POST", body: { command: "usage" } },
    ])
    expect(screen.queryByTestId("tokens-panel")).toBeNull()
    expect(onSend).not.toHaveBeenCalled()
  })

  it("does not fall back to /tokens when a harness has no /usage read", async () => {
    mount(
      <SteerBox task={task({ harness: "droid" })} probeCommands={["context"]} onSend={async () => {}} />,
    )
    type("/")
    await screen.findByTestId("slash-palette")
    type("/usage")

    await waitFor(() => expect(screen.getByText("No matching command")).toBeInTheDocument())
    expect(screen.queryByTestId("slash-tokens")).toBeNull()
  })

  it("uneven availability is data: codex offers only its usage read; no commands, no group", async () => {
    const { rerender } = mount(
      <SteerBox task={task({ harness: "codex" })} probeCommands={["usage"]} onSend={async () => {}} />,
    )
    type("/")
    await screen.findByTestId("slash-palette")
    expect(screen.getByTestId("slash-probe:usage")).toBeInTheDocument()
    expect(screen.queryByTestId("slash-probe:context")).toBeNull()

    rerender(<SteerBox task={task({ harness: "codex" })} probeCommands={[]} onSend={async () => {}} />)
    expect(screen.queryByTestId("slash-probe:usage")).toBeNull()
    // scoped: the composer's footer always names the harness
    expect(within(screen.getByTestId("slash-palette")).queryByText("codex")).toBeNull()
  })

  it("a pick POSTs the probe and the markdown answer opens in the panel, not the note row", async () => {
    const calls = stubApi(() => ({ status: 200, body: MARKDOWN_ANSWER }))
    mount(<SteerBox task={task()} probeCommands={["context"]} onSend={async () => {}} />)
    type("hello /ctx")
    await screen.findByTestId("slash-palette")
    fireEvent.click(screen.getByTestId("slash-probe:context"))

    // the token is consumed like any wisp command — the harness never sees it
    expect(box().value).toBe("hello ")
    expect(await screen.findByTestId("probe-panel")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId("probe-panel")).toHaveTextContent("13.3k / 1m"))
    expect(calls).toEqual([
      { path: "/api/tasks/tk9zdy/probe", method: "POST", body: { command: "context" } },
    ])
    expect(screen.queryByTestId("steer-note")).toBeNull()
  })

  it("a cached answer says so — staleness is news; a fresh one just says when", async () => {
    stubApi(() => ({ status: 200, body: { ...MARKDOWN_ANSWER, cached: true } }))
    mount(<SteerBox task={task()} probeCommands={["context"]} onSend={async () => {}} />)
    type("/ctx")
    await screen.findByTestId("slash-palette")
    fireEvent.click(screen.getByTestId("slash-probe:context"))

    const panel = await screen.findByTestId("probe-panel")
    await waitFor(() => expect(panel).toHaveTextContent(/cached · /))
  })

  it("a structured answer renders as Wisp's table, with no invented zeros", async () => {
    stubApi(() => ({
      status: 200,
      body: {
        command: "context",
        probedAt: "2026-08-30T12:00:00Z",
        cached: false,
        report: {
          format: "context",
          context: {
            model: "Opus 5",
            budgetTokens: 250000,
            usedTokens: 11981,
            freeTokens: 238019,
            categories: [{ name: "System prompt", tokens: 1330 }],
            skills: [], // the harness said nothing — so no Skills heading at all
            mcpServers: [{ name: "linear", toolCount: 62, tokens: 371 }],
          },
        },
      },
    }))
    mount(<SteerBox task={task({ harness: "droid" })} probeCommands={["context"]} onSend={async () => {}} />)
    type("/ctx")
    await screen.findByTestId("slash-palette")
    fireEvent.click(screen.getByTestId("slash-probe:context"))

    const panel = await screen.findByTestId("probe-context")
    await waitFor(() => expect(panel).toHaveTextContent("12.0k of 250.0k"))
    expect(panel).toHaveTextContent("System prompt")
    expect(panel).toHaveTextContent("62 tools · 371")
    expect(panel).not.toHaveTextContent("Skills")
  })

  it("a refusal is the same one muted note every command's refusal is — never a panel", async () => {
    stubApi(() => ({ status: 409, body: { error: "no session yet — the first turn creates one" } }))
    mount(<SteerBox task={task({ session_id: null })} probeCommands={["context"]} onSend={async () => {}} />)
    type("/ctx")
    await screen.findByTestId("slash-palette")
    fireEvent.click(screen.getByTestId("slash-probe:context"))

    const note = await screen.findByTestId("steer-note")
    await waitFor(() => expect(note).toHaveTextContent("no session yet — the first turn creates one"))
    expect(note.className).toContain("text-muted-foreground")
    expect(screen.queryByTestId("probe-panel")).toBeNull()
  })

  it("Escape and the close button both dismiss the panel", async () => {
    stubApi(() => ({ status: 200, body: MARKDOWN_ANSWER }))
    mount(<SteerBox task={task()} probeCommands={["context"]} onSend={async () => {}} />)
    type("/ctx")
    await screen.findByTestId("slash-palette")
    fireEvent.click(screen.getByTestId("slash-probe:context"))
    await screen.findByTestId("probe-panel")

    fireEvent.keyDown(box(), { key: "Escape" })
    expect(screen.queryByTestId("probe-panel")).toBeNull()

    // and a fresh pick reopens it; the × closes it too
    type("/ctx")
    await screen.findByTestId("slash-palette")
    fireEvent.click(screen.getByTestId("slash-probe:context"))
    await screen.findByTestId("probe-panel")
    fireEvent.click(screen.getByLabelText("Close"))
    expect(screen.queryByTestId("probe-panel")).toBeNull()
  })

  it("the panel belongs to the task that asked — a switch never shows it over another", async () => {
    stubApi(() => ({ status: 200, body: MARKDOWN_ANSWER }))
    const { rerender } = mount(<SteerBox task={task()} probeCommands={["context"]} onSend={async () => {}} />)
    type("/ctx")
    await screen.findByTestId("slash-palette")
    fireEvent.click(screen.getByTestId("slash-probe:context"))
    await screen.findByTestId("probe-panel")

    rerender(<SteerBox task={task({ id: "tppxvp", harness: "claude" })} probeCommands={["context"]} onSend={async () => {}} />)
    expect(screen.queryByTestId("probe-panel")).toBeNull()
  })
})

describe("compact (A5)", () => {
  it("claude's compact is a prompt: the entry prefills /compact, marked as the turn it is", async () => {
    const onSend = vi.fn(async () => {})
    const calls = stubApi(() => ({ status: 200, body: { ok: true } }))
    mount(
      <SteerBox
        task={task()}
        compact={{ kind: "prompt", prompt: "/compact" }}
        onSend={onSend}
      />,
    )
    type("/comp")
    await screen.findByTestId("slash-palette")
    const row = screen.getByTestId("slash-compact")
    expect(row).toHaveTextContent("runs a turn")
    fireEvent.click(row)

    expect(box().value).toBe("/compact")
    expect(onSend).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0) // nothing dispatched — the user reviews what costs a turn
  })

  it("droid's compact dispatches, and the note reports exactly what the harness said", async () => {
    const calls = stubApi(() => ({
      status: 200,
      body: { ok: true, removedCount: 3, sessionReplaced: true, note: null },
    }))
    mount(
      <SteerBox
        task={task({ harness: "droid" })}
        compact={{ kind: "action", recordsTurn: false }}
        onSend={async () => {}}
      />,
    )
    type("/comp")
    await screen.findByTestId("slash-palette")
    const row = screen.getByTestId("slash-compact")
    expect(row).toHaveTextContent("costs tokens") // droid records no turn — the label says so
    fireEvent.click(row)

    expect(box().value).toBe("") // an action is not prompt text
    await waitFor(() => expect(calls.some((c) => c.path === "/api/tasks/tk9zdy/compact" && c.method === "POST")).toBe(true))
    const note = await screen.findByTestId("steer-note")
    await waitFor(() =>
      expect(note).toHaveTextContent("compacted — 3 messages dropped; the session continues as a new one"),
    )
  })

  it("codex's compact says it runs a turn, and the note names the thread's own record", async () => {
    stubApi(() => ({
      status: 200,
      body: { ok: true, removedCount: null, sessionReplaced: false, note: "codex recorded it as a turn in its own thread" },
    }))
    mount(
      <SteerBox
        task={task({ harness: "codex" })}
        compact={{ kind: "action", recordsTurn: true }}
        onSend={async () => {}}
      />,
    )
    type("/comp")
    await screen.findByTestId("slash-palette")
    expect(screen.getByTestId("slash-compact")).toHaveTextContent("runs a turn")
    fireEvent.click(screen.getByTestId("slash-compact"))

    const note = await screen.findByTestId("steer-note")
    await waitFor(() =>
      expect(note).toHaveTextContent("compacted — codex recorded it as a turn in its own thread"),
    )
  })

  it("a failed mechanism names what failed and offers /fresh — Q7's fallback, one layer lower", async () => {
    stubApi(() => ({ status: 502, body: { error: "the droid compaction timed out after 60s" } }))
    mount(
      <SteerBox
        task={task({ harness: "droid" })}
        compact={{ kind: "action", recordsTurn: false }}
        onSend={async () => {}}
      />,
    )
    type("/comp")
    await screen.findByTestId("slash-palette")
    fireEvent.click(screen.getByTestId("slash-compact"))

    const note = await screen.findByTestId("steer-note")
    await waitFor(() =>
      expect(note).toHaveTextContent(
        "compact failed: the droid compaction timed out after 60s — /fresh is the lever that always works",
      ),
    )
    expect(note.className).toContain("text-destructive")
  })

  it("a 409 is an expected state, not a failed mechanism — muted, and no /fresh offer", async () => {
    stubApi(() => ({ status: 409, body: { error: "turn 1 is still running — compaction waits for it" } }))
    mount(
      <SteerBox
        task={task({ harness: "droid" })}
        compact={{ kind: "action", recordsTurn: false }}
        onSend={async () => {}}
      />,
    )
    type("/comp")
    await screen.findByTestId("slash-palette")
    fireEvent.click(screen.getByTestId("slash-compact"))

    const note = await screen.findByTestId("steer-note")
    await waitFor(() => expect(note).toHaveTextContent("turn 1 is still running — compaction waits for it"))
    expect(note).not.toHaveTextContent("/fresh")
    expect(note.className).toContain("text-muted-foreground")
  })

  it("a harness with no compaction shows no entry — honest absence, not a dead button", async () => {
    mount(<SteerBox task={task()} compact={null} onSend={async () => {}} />)
    type("/comp")
    await screen.findByTestId("slash-palette")
    expect(screen.queryByTestId("slash-compact")).toBeNull()
  })
})
