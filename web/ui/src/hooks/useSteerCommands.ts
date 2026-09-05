import { useFreshSession, useInterruptTask, usePushTask } from "@/hooks/mutations"
import { useArchiveFlow } from "@/hooks/useArchiveFlow"
import { api, ApiError, failureDisplay } from "@/lib/api"
import { statusNote, type Tier1CommandName } from "@/lib/slash"
import type {
  ApiTask,
  CompactAnswer,
  ProbeAnswer,
  ProbeCommandName,
  StatusEntry,
} from "@/lib/types"
import { uiIntents } from "@/lib/ui-intents"
import type { Dispatch, SetStateAction } from "react"

export interface SteerNote {
  taskId: string
  tone: "muted" | "error"
  text: string
  title?: string
  copyable?: string
}

export type ReportState =
  | {
      kind: "probe"
      taskId: string
      command: ProbeCommandName
      answer: ProbeAnswer | null
    }
  | { kind: "tokens"; taskId: string }
  | null

export function useSteerCommands({
  task,
  status,
  setNote,
  setReport,
}: {
  task: ApiTask | null
  status?: StatusEntry
  setNote: Dispatch<SetStateAction<SteerNote | null>>
  setReport: Dispatch<SetStateAction<ReportState>>
}) {
  const interruptTask = useInterruptTask()
  const pushTask = usePushTask()
  const freshSessionTask = useFreshSession()
  const archive = useArchiveFlow(task)

  const dispatch = (name: Tier1CommandName) => {
    if (!task) return
    const id = task.id
    const say = (text: string, extra?: { title?: string; copyable?: string }) =>
      setNote({ taskId: id, tone: "muted", text, ...extra })
    const refuse = (error: unknown) => setNote(failureNote(id, error))
    setReport((current) => (current?.kind === "tokens" ? null : current))

    switch (name) {
      case "status":
        say(statusNote(task, status))
        break
      case "tokens": {
        setReport({ kind: "tokens", taskId: id })
        break
      }
      case "log":
        uiIntents.focusStream()
        say("pinned to the live tail")
        break
      case "interrupt":
        interruptTask.mutate(id, { onSuccess: () => say("interrupt sent"), onError: refuse })
        break
      case "push":
        pushTask.mutate(id, {
          onSuccess: (data) =>
            say(`pushed ${task.branch ?? "the branch"}`, { title: data.output?.trim() || undefined }),
          onError: refuse,
        })
        break
      case "archive":
        archive.request(false)
        break
      case "fresh":
        freshSessionTask.mutate(id, {
          onSuccess: () => say("session cleared — the next turn starts fresh"),
          onError: refuse,
        })
        break
      case "attach":
        void attachCommand(id, say, refuse)
        break
      default: {
        const unreachable: never = name
        throw new Error(`unknown Wisp command: ${unreachable}`)
      }
    }
  }

  const probe = (command: ProbeCommandName) => {
    if (!task) return
    const id = task.id
    setReport({ kind: "probe", taskId: id, command, answer: null })
    void (async () => {
      try {
        const answer = await api<ProbeAnswer>(`/api/tasks/${id}/probe`, { method: "POST", body: { command } })
        setReport((current) =>
          current?.kind === "probe" && current.taskId === id && current.command === command
            ? { ...current, answer }
            : current,
        )
      } catch (error) {
        setReport((current) =>
          current?.kind === "probe" && current.taskId === id && current.command === command ? null : current,
        )
        setNote(failureNote(id, error))
      }
    })()
  }

  const compact = () => {
    if (!task) return
    setReport((current) => (current?.kind === "tokens" ? null : current))
    setNote({ taskId: task.id, tone: "muted", text: "compacting the session…" })
    void compactSession(task.id, setNote)
  }

  return { archive, compact, dispatch, probe }
}

interface AttachResponse {
  argv: string[] | null
  cwd: string | null
  message: string | null
}

async function attachCommand(
  taskId: string,
  say: (text: string, extra?: { title?: string; copyable?: string }) => void,
  refuse: (error: unknown) => void,
): Promise<void> {
  try {
    const response = await api<AttachResponse>(`/api/tasks/${taskId}/attach`)
    if (!response.argv) {
      say(response.message ?? "no session yet")
      return
    }
    const line = `${response.cwd ? `cd ${response.cwd} && ` : ""}${response.argv.join(" ")}`
    say(line, { copyable: line, title: line })
  } catch (error) {
    refuse(error)
  }
}

async function compactSession(
  taskId: string,
  setNote: Dispatch<SetStateAction<SteerNote | null>>,
): Promise<void> {
  try {
    const response = await api<CompactAnswer>(`/api/tasks/${taskId}/compact`, { method: "POST" })
    const bits: string[] = []
    if (response.removedCount !== null) bits.push(`${response.removedCount} messages dropped`)
    if (response.sessionReplaced) bits.push("the session continues as a new one")
    const summary = bits.length > 0 ? `compacted — ${bits.join("; ")}` : "compacted"
    setNote((current) =>
      current?.taskId === taskId
        ? {
            taskId,
            tone: "muted",
            text: response.note ? `${summary} — ${response.note}` : summary,
          }
        : current,
    )
  } catch (error) {
    const base = failureNote(taskId, error)
    const failedMechanism = !(error instanceof ApiError && error.status === 409)
    setNote({
      ...base,
      text: failedMechanism ? `compact failed: ${base.text} — /fresh is the lever that always works` : base.text,
    })
  }
}

export function failureNote(taskId: string, error: unknown): SteerNote {
  return {
    taskId,
    ...failureDisplay(error),
  }
}
