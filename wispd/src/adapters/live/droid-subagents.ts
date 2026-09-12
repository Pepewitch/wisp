import { open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { JsonLineBuffer } from "./json-lines";

interface TaskInvocation {
  parentSessionId?: unknown;
  parentToolUseId?: unknown;
  childSessionId?: unknown;
  parentTranscriptPath?: unknown;
}

interface ChildTranscript {
  parentId: string;
  path: string;
  offset: number;
  decoder: TextDecoder;
  lines: JsonLineBuffer;
}

interface DroidSubagentStreamOptions {
  parentSessionId: string;
  emit: (event: Record<string, unknown>) => void;
  factoryHome?: string;
  pollMs?: number;
}

const DEFAULT_POLL_MS = 250;
const MAX_REGISTRY_BYTES = 16 * 1024 * 1024;
const MAX_TRANSCRIPT_LINE_CHARS = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_READ_BYTES = 1024 * 1024;

function factoryHome(): string {
  const override = process.env.FACTORY_HOME_OVERRIDE?.trim();
  return resolve(override || join(homedir(), ".factory"));
}

function string(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function sessionFile(
  home: string,
  invocation: TaskInvocation,
  childSessionId: string,
): string | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(childSessionId)) return null;
  const parentPath = string(invocation.parentTranscriptPath);
  if (!parentPath) return null;
  const sessions = resolve(home, "sessions");
  const path = resolve(dirname(parentPath), `${childSessionId}.jsonl`);
  return within(sessions, path) ? path : null;
}

/**
 * Droid's parent JSON-RPC stream exposes a Task call and its eventual result,
 * but not the child messages Factory renders in its app. Droid 0.218.0 writes
 * those messages to a child JSONL transcript while the Task is still running,
 * and task-invocations.json publishes the parent-tool → child-session link.
 * This bounded sidecar follows that local stream and projects only assistant
 * activity into the same wire shape as the parent.
 */
export class DroidSubagentStream {
  private readonly home: string;
  private readonly registryPath: string;
  private readonly watchedSessions = new Map<string, string | null>();
  private readonly watchedTools = new Set<string>();
  private readonly children = new Map<string, ChildTranscript>();
  private readonly timer: ReturnType<typeof setInterval>;
  private polling: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly options: DroidSubagentStreamOptions) {
    this.home = resolve(options.factoryHome ?? factoryHome());
    this.registryPath = join(this.home, "task-invocations.json");
    this.watchedSessions.set(options.parentSessionId, null);
    this.timer = setInterval(() => void this.poll(), options.pollMs ?? DEFAULT_POLL_MS);
    this.timer.unref?.();
  }

  follow(parentToolUseId: string): void {
    this.watchedTools.add(parentToolUseId);
  }

  async poll(): Promise<void> {
    if (this.polling) return this.polling;
    if (
      this.closed ||
      (this.watchedTools.size === 0 && this.children.size === 0)
    ) {
      return;
    }
    this.polling = this.pollOnce();
    try {
      await this.polling;
    } finally {
      this.polling = null;
    }
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.poll();
    // If close joined an in-flight poll, make one last pass for bytes that
    // landed while that pass was reading another child.
    await this.poll();
    this.closed = true;
  }

  private async pollOnce(): Promise<void> {
    if (this.watchedTools.size > 0) await this.discover();
    await Promise.all([...this.children.values()].map((child) => this.readChild(child)));
    // A newly read nested Task may already have an invocation registry row.
    if (this.watchedTools.size > 0) await this.discover();
  }

  private async discover(): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(this.registryPath);
    } catch {
      return;
    }
    if (bytes.byteLength > MAX_REGISTRY_BYTES) return;
    let registry: unknown;
    try {
      registry = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return;
    }
    const invocations = (registry as { invocations?: unknown })?.invocations;
    if (!Array.isArray(invocations)) return;
    for (const raw of invocations) {
      if (!raw || typeof raw !== "object") continue;
      const invocation = raw as TaskInvocation;
      const parentSessionId = string(invocation.parentSessionId);
      const parentToolUseId = string(invocation.parentToolUseId);
      const childSessionId = string(invocation.childSessionId);
      if (
        !parentSessionId ||
        !parentToolUseId ||
        !childSessionId ||
        !this.watchedSessions.has(parentSessionId) ||
        !this.watchedTools.has(parentToolUseId) ||
        this.children.has(childSessionId)
      ) {
        continue;
      }
      const path = sessionFile(this.home, invocation, childSessionId);
      if (!path) continue;
      this.children.set(childSessionId, {
        parentId: parentToolUseId,
        path,
        offset: 0,
        decoder: new TextDecoder(),
        lines: new JsonLineBuffer({ maxFrameChars: MAX_TRANSCRIPT_LINE_CHARS }),
      });
      this.watchedTools.delete(parentToolUseId);
      this.watchedSessions.set(childSessionId, parentToolUseId);
    }
  }

  private async readChild(child: ChildTranscript): Promise<void> {
    let file;
    try {
      file = await open(child.path, "r");
    } catch {
      return;
    }
    try {
      const size = (await file.stat()).size;
      if (size < child.offset) {
        child.offset = 0;
        child.decoder = new TextDecoder();
        child.lines = new JsonLineBuffer({ maxFrameChars: MAX_TRANSCRIPT_LINE_CHARS });
      }
      const length = Math.min(MAX_TRANSCRIPT_READ_BYTES, size - child.offset);
      if (length <= 0) return;
      const bytes = new Uint8Array(length);
      const { bytesRead } = await file.read(bytes, 0, length, child.offset);
      child.offset += bytesRead;
      const chunk = bytes.subarray(0, bytesRead);
      for (const line of child.lines.push(child.decoder.decode(chunk, { stream: true }))) {
        this.projectLine(line, child);
      }
    } catch {
      return;
    } finally {
      await file.close().catch(() => {});
    }
  }

  private projectLine(line: string, child: ChildTranscript): void {
    let entry: Record<string, any>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      entry = parsed as Record<string, any>;
    } catch {
      return;
    }
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return;
    const message = entry.message as Record<string, any>;
    if (message.role === "assistant") {
      this.projectAssistant(entry, message, child);
      return;
    }
    if (message.role === "user") this.projectUser(entry, message, child);
  }

  private projectAssistant(
    entry: Record<string, any>,
    message: Record<string, any>,
    child: ChildTranscript,
  ): void {
    const content = Array.isArray(message.content) ? message.content : [];
    for (const raw of content) {
      if (!raw || typeof raw !== "object") continue;
      const block = raw as Record<string, any>;
      if (block.type === "text" && typeof block.text === "string" && block.text) {
        this.options.emit({
          type: "message",
          id: entry.id,
          role: "assistant",
          text: block.text,
          timestamp: entry.timestamp,
          parent_tool_use_id: child.parentId,
        });
      } else if (
        (block.type === "thinking" || block.type === "reasoning") &&
        typeof block.thinking === "string"
      ) {
        this.options.emit({
          type: "reasoning",
          id: entry.id,
          text: block.thinking,
          timestamp: entry.timestamp,
          parent_tool_use_id: child.parentId,
        });
      } else if (block.type === "tool_use" && string(block.id) && string(block.name)) {
        this.options.emit({
          type: "tool_call",
          id: block.id,
          toolName: block.name,
          parameters: block.input ?? {},
          timestamp: entry.timestamp,
          parent_tool_use_id: child.parentId,
        });
        if (block.name === "Task") this.watchedTools.add(block.id);
      }
    }
  }

  private projectUser(
    entry: Record<string, any>,
    message: Record<string, any>,
    child: ChildTranscript,
  ): void {
    const content = Array.isArray(message.content) ? message.content : [];
    for (const raw of content) {
      if (!raw || typeof raw !== "object") continue;
      const block = raw as Record<string, any>;
      if (block.type !== "tool_result" || !string(block.tool_use_id)) continue;
      this.options.emit({
        type: "tool_result",
        id: block.tool_use_id,
        value: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? ""),
        isError: block.is_error === true,
        timestamp: entry.timestamp,
        parent_tool_use_id: child.parentId,
      });
    }
  }
}
