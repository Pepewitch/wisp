import type { HarnessBackgroundTask } from "../../types";

/**
 * Droid's stream knowledge for work that outlives a turn: what starts it, what
 * says it finished, and what is still running (see DroidLiveProcess in
 * live-droid.ts, which keeps the process alive for it).
 *
 * Captured from droid 0.251.0 over stream-jsonrpc. A background command is an
 * `Execute` call with `fireAndForget`, a background subagent a `Task` call:
 *
 *   tool_result "Background process started (PID: 68532)\n…Status: Running in background…"
 *   tool_result "Task launched in background.\ntask_id: bad1942c-…\n…"
 *   agent_turn_completed turnId=m1          <- the turn ends; the work runs on
 *   create_message role=user id="execute-completion:<toolUseId>"
 *     "Background Execute command finished.\ntool_use_id: <toolUseId>\nsummary: …\nexit_status: code 0\n…"
 *   create_message role=user id="task-completion:<uuid>"
 *     "Background task completed.\ntask_id: bad1942c-…\ntype: worker\nreason: completed\ndescription: …"
 *   …assistant messages…
 *   agent_turn_completed turnId="execute-completion:<toolUseId>"
 *
 * Droid starts that completion's agent turn by itself, but only while its
 * stdin is open: closing it makes Droid exit within seconds and kill the
 * command, so the completion never arrives. A completion that lands during a
 * turn is part of that turn.
 */

const EXECUTE_STARTED = "Background process started";
const EXECUTE_FINISHED = "Background Execute command finished.";
const TASK_STARTED = "Task launched in background.";
const TASK_FINISHED = "Background task completed.";
const COMPLETION_IDS = ["execute-completion:", "task-completion:"];

/**
 * How long a background command whose process is gone may wait for Droid's
 * completion message before Wisp stops counting it. Droid delivers it within a
 * second of the exit; this only covers a message Wisp did not recognize.
 */
const DEAD_PID_GRACE_MS = 30_000;

/** An agent turn Droid started on its own for a background completion. */
export function isCompletionTurn(turnId: unknown): boolean {
  return typeof turnId === "string" && COMPLETION_IDS.some((prefix) => turnId.startsWith(prefix));
}

/**
 * A header line's value. Only the header counts: the command's own output
 * follows it, and a test runner's `summary:` line there is not the call's.
 */
function field(text: string, name: string): string | null {
  const header = text.split(/\n(?:output:|The following is untrusted)/)[0]!;
  return new RegExp(`(?:^|\\n)${name}:[ \\t]*([^\\n]+)`).exec(header)?.[1]?.trim() || null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface Work {
  task: HarnessBackgroundTask;
  /** A command's process, which Wisp can check on; a subagent has none. */
  pid: number | null;
  goneSince: number | null;
}

export function createDroidBackground(
  now: () => number = Date.now,
  alive: (pid: number) => boolean = pidAlive,
): {
  noteToolUse(id: string, name: string, input: Record<string, unknown>): void;
  noteToolResult(toolUseId: string, content: unknown, turn: number): void;
  completion(message: { id: unknown; role: unknown; text: string }): string | null;
  tasks(): HarnessBackgroundTask[];
  count(): number;
  prune(): boolean;
} {
  const work = new Map<string, Work>();
  /** What each background-capable call was asked to do, until its result names the work. */
  const calls = new Map<string, { name: string; label: string | null }>();
  /**
   * The open subagent a completion with no `task_id` is about: the one with
   * its description, else the only one. A subagent has no process to check,
   * so a completion that matches nothing would hold the process forever.
   */
  const subagentNamed = (description: string | null): string | null => {
    const subagents = [...work].filter(([, entry]) => entry.pid === null);
    const named = subagents.find(([, entry]) => description !== null && entry.task.name === description.slice(0, 120));
    return named?.[0] ?? (subagents.length === 1 ? subagents[0]![0] : null);
  };
  const add = (key: string, name: string, kind: string, turn: number, pid: number | null): void => {
    work.set(key, { task: { name: name.slice(0, 120), kind, turn, since: new Date(now()).toISOString() }, pid, goneSince: null });
  };
  return {
    noteToolUse(id, name, input) {
      if (name !== "Execute" && name !== "Task") return;
      const label = [input.summary, input.description, input.command].find((value) => typeof value === "string" && value.trim());
      calls.set(id, { name, label: typeof label === "string" ? label.trim() : null });
    },
    noteToolResult(toolUseId, content, turn) {
      const call = calls.get(toolUseId);
      calls.delete(toolUseId);
      if (!call || typeof content !== "string") return;
      if (call.name === "Execute" && content.startsWith(EXECUTE_STARTED)) {
        const pid = Number(/\(PID:\s*(\d+)\)/.exec(content)?.[1]);
        add(toolUseId, call.label ?? field(content, "Command") ?? "background command", "execute", turn, Number.isInteger(pid) && pid > 0 ? pid : null);
      } else if (call.name === "Task" && content.startsWith(TASK_STARTED)) {
        const taskId = field(content, "task_id");
        if (taskId) add(taskId, call.label ?? field(content, "description") ?? "background subagent", field(content, "subagent_type") ?? "subagent", turn, null);
      }
    },
    /** A message reporting that background work finished: what it says, in a few words. Null for any other message. */
    completion({ id, role, text }) {
      if (role !== "user") return null;
      const flagged = isCompletionTurn(id);
      if (text.startsWith(EXECUTE_FINISHED) || (flagged && String(id).startsWith("execute-completion:"))) {
        const key = field(text, "tool_use_id") ?? String(id).slice("execute-completion:".length);
        const known = work.get(key)?.task.name;
        work.delete(key);
        const status = field(text, "stopped_by") === "user" ? "was stopped" : `finished (${field(text, "exit_status") ?? "exit status unknown"})`;
        return `"${field(text, "summary") ?? known ?? "background command"}" ${status}`;
      }
      if (text.startsWith(TASK_FINISHED) || flagged) {
        const description = field(text, "description");
        const key = field(text, "task_id") ?? subagentNamed(description);
        const known = key ? work.get(key)?.task.name : undefined;
        if (key) work.delete(key);
        return `"${description ?? known ?? "background subagent"}" ${field(text, "reason") ?? "finished"}`;
      }
      return null;
    },
    tasks: () => [...work.values()].map((entry) => entry.task),
    count: () => work.size,
    /** Forget commands whose process has been gone for a while with no completion. True if any went. */
    prune() {
      let changed = false;
      for (const [key, entry] of work) {
        if (entry.pid === null) continue;
        if (alive(entry.pid)) {
          entry.goneSince = null;
          continue;
        }
        entry.goneSince ??= now();
        if (now() - entry.goneSince >= DEAD_PID_GRACE_MS) {
          work.delete(key);
          changed = true;
        }
      }
      return changed;
    },
  };
}
