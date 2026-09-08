import { trunc } from "../text";
import type { AdapterDef, EventFormatter } from "./types";
import { createEventLineDecoder, cursorToolCall, decodeEventLine, type DecodedEventLine } from "./wire";

/**
 * Reasoning is one logical block even when the harness sends paragraphs.
 * Prefix EVERY line so the web reducer keeps the whole block behind its
 * Thinking row; prefixing only the first line turns the rest into ordinary
 * assistant prose. Truncate before adding markers so the visible-content cap
 * stays 300 characters.
 */
function thinkingLines(value: unknown, pre = "", keepEmpty = true): string | null {
  const thought = trunc(String(value ?? "").trim(), 300);
  if (!thought) return keepEmpty ? `${pre}~` : null;
  return thought
    .split("\n")
    .map((line) => `${pre}~${line ? ` ${line}` : ""}`)
    .join("\n");
}

/**
 * A stream-json terminal event is a SETTLEMENT MARKER, not content. On
 * success its text repeats prose that already streamed as assistant events —
 * claude's result and droid's finalText are the last assistant message
 * exactly, cursor's result is the whole turn's prose concatenated (all
 * byte-verified against real logs, see parse.ts) — so reprinting any of it
 * only duplicates. codex set this precedent: turn.completed → "✓ turn
 * complete". The exception is is_error: an error result's text may be
 * content that never streamed (claude's is_error:true result keeps subtype
 * "success"! — tests/fixtures/claude-unknown-model.jsonl), so it prints, as ✗.
 */
function settlementLine(e: Record<string, unknown>, text: unknown): string {
  return e.is_error ? `✗ ${trunc(String(text ?? ""), 500)}` : "✓ turn complete";
}

export const EVENT_FORMATTERS: Record<string, EventFormatter> = {
  "claude-stream-json": (e) => {
    switch (e.type) {
      case "system":
        return e.subtype === "init" ? `· session ${e.session_id}` : null;
      case "assistant": {
        // message with content items; subagent activity carries parent_tool_use_id
        const pre = e.parent_tool_use_id ? "  [sub] " : "";
        const parts: string[] = [];
        for (const c of e.message?.content ?? []) {
          if (c.type === "text" && c.text?.trim()) parts.push(`${pre}${trunc(c.text.trim(), 300)}`);
          if (c.type === "tool_use") parts.push(`${pre}→ ${c.name}(${trunc(JSON.stringify(c.input ?? {}), 120)})`);
          // `~` is the thinking marker. Verified across 167 real thinking
          // blocks in ~/.wisp/logs: claude-code ships `signature` (encrypted)
          // and an EMPTY `thinking` string every time, so the bare marker is
          // usually all there is — which still answers "is it alive?". The
          // text branch stays for a build that starts populating it.
          if (c.type === "thinking") {
            parts.push(thinkingLines(c.thinking, pre)!);
          }
        }
        return parts.length ? parts.join("\n") : null;
      }
      case "user": {
        const pre = e.parent_tool_use_id ? "  [sub] " : "";
        const results = (e.message?.content ?? [])
          .filter((c: any) => c.type === "tool_result")
          .map(
            (c: any) =>
              `${pre}← ${trunc(String(typeof c.content === "string" ? c.content : JSON.stringify(c.content)).replaceAll("\n", " "), 120)}`,
          );
        return results.length ? results.join("\n") : null;
      }
      case "result": // final
        return settlementLine(e, e.result);
      default:
        return null; // thinking, rate limits, …
    }
  },
  "droid-stream-json": (e) => {
    switch (e.type) {
      case "system":
        return e.subtype === "init" ? `· session ${e.session_id}` : null;
      case "message":
        return e.role === "assistant" && e.text ? trunc(e.text, 300) : null;
      // droid DOES ship its reasoning text (shape captured from real logs:
      // {type:"reasoning", id, text, timestamp, session_id}). Its text often
      // begins with a newline and can contain paragraphs, so every rendered
      // line needs the `~` marker the conversation's grouping contract reads.
      case "reasoning":
        return thinkingLines(e.text, "", false);
      case "tool_call":
        return `→ ${e.toolName}(${trunc(JSON.stringify(e.parameters ?? {}), 120)})`;
      case "tool_result":
        return `← ${trunc(String(e.value ?? "").replaceAll("\n", " "), 120)}`;
      case "completion": // final
        return settlementLine(e, e.finalText);
      default:
        return null; // usage, …
    }
  },
  // cursor-agent 2026.08.11's stream-json is claude's protocol in spirit —
  // system/init, assistant message.content, result — with ONE divergence:
  // tool activity is a top-level `tool_call` event (subtype started/
  // completed) whose payload is keyed by tool variant (readToolCall,
  // shellToolCall, editToolCall, …), not claude's in-message tool_use
  // blocks. Shapes binary-verified against the bundled CLI (slice 9; live
  // verification followed on the first authed run).
  "cursor-stream-json": (e) => {
    switch (e.type) {
      case "system":
        return e.subtype === "init" ? `· session ${e.session_id}` : null;
      case "assistant": {
        const parts: string[] = [];
        for (const c of (e.message as { content?: { type?: string; text?: string }[] } | undefined)?.content ?? []) {
          if (c.type === "text" && c.text?.trim()) parts.push(trunc(c.text.trim(), 300));
        }
        return parts.length ? parts.join("\n") : null;
      }
      case "tool_call": {
        // the tool's name is the payload's single variant key — derived,
        // never a hardcoded list (cursor adds tools faster than wisp tracks)
        const { name, input } = cursorToolCall(e);
        const args = trunc(JSON.stringify(input ?? {}), 120);
        // started says what runs, completed says it finished — the result
        // payload's inner shape is tool-specific and unverified, so it is
        // truncated raw rather than field-guessed
        return e.subtype === "completed" ? `← ${name}(${args})` : `→ ${name}(${args})`;
      }
      case "result": // final
        return settlementLine(e, e.result);
      default:
        return null; // task_notification, approval, …
    }
  },
  // `codex exec --json` speaks JSONL, but nothing like the other two: every
  // action arrives as item.started/item.updated/item.completed wrapping a
  // nested `item`, and the session id comes on its own thread.started line.
  // Shapes captured live (codex-cli 0.149.0) in tests/fixtures/codex-*.jsonl.
  "codex-jsonl": (e) => {
    switch (e.type) {
      case "thread.started":
        return `· session ${e.thread_id}`;
      case "item.started":
        // only the command pre-echo earns a line; everything else repeats on completion
        return e.item?.type === "command_execution" ? `→ ${trunc(String(e.item.command ?? ""), 200)}` : null;
      case "item.completed": {
        const item = e.item ?? {};
        switch (item.type) {
          case "agent_message":
            return item.text?.trim() ? trunc(item.text.trim(), 300) : null;
          case "command_execution":
            return `← [exit ${item.exit_code ?? "?"}] ${trunc(String(item.aggregated_output ?? "").replaceAll("\n", " "), 120)}`;
          case "error": // codex reports recoverable errors as items too, mid-turn
            return `✗ ${trunc(String(item.message ?? ""), 300)}`;
          case "reasoning":
            // Dropped, unlike droid's: no codex reasoning item has ever been
            // captured in a real log, so its text field is unknown and this
            // adapter does not guess shapes (the rule that keeps limitMarkers
            // honest). Add a `~` line here from a real capture, not from docs.
            return null;
          default:
            // item types this build has not captured live (file_change,
            // mcp_tool_call, web_search, todo_list, …): show the type and a
            // truncated payload rather than guess field names — or worse, drop
            // the activity silently.
            return item.type ? `→ ${item.type}(${trunc(JSON.stringify(item), 120)})` : null;
        }
      }
      case "turn.completed":
        return "✓ turn complete"; // carries usage only; the result was the last agent_message
      case "turn.failed":
        return `✗ turn failed: ${trunc(typeof e.error?.message === "string" ? e.error.message : JSON.stringify(e.error ?? {}), 300)}`;
      case "error": // top-level stream error (observed alongside turn.failed)
        return `✗ ${trunc(String(e.message ?? ""), 300)}`;
      default:
        return null; // turn.started, item.updated, …
    }
  },
};

/**
 * Render one captured log line for a human. Harness-agnostic shell: non-JSON
 * lines pass through truncated; JSON events go to the adapter's named
 * formatter; without one (text harnesses, adapters unknown to this client)
 * the raw line passes through rather than silently vanishing.
 */
export function formatEvent(line: string, def?: AdapterDef): string | null {
  const decoded = decodeEventLine(line);
  return decoded ? formatDecodedEvent(decoded, def) : null;
}

function formatDecodedEvent(decoded: DecodedEventLine, def?: AdapterDef): string | null {
  if (!decoded.event) return trunc(decoded.text, 200);
  return formatParsedEvent(decoded.event, def);
}

export function formatParsedEvent(e: Record<string, any>, def?: AdapterDef): string | null {
  const format = def?.events ? EVENT_FORMATTERS[def.events] : undefined;
  // an unknown name is unreachable via config (validateAdapter rejects it at
  // load); for a def built in code, a silent raw passthrough would masquerade
  // as "the harness emitted noise" — same loud contract as parse/errors/usage
  if (def?.events && !format) {
    const known = Object.keys(EVENT_FORMATTERS).join(", ");
    throw new Error(`adapter events '${def.events}' is not a known event formatter (known: ${known})`);
  }
  return format ? format(e) : trunc(JSON.stringify(e), 200);
}

/**
 * Stateful human-log renderer. Droid 0.205.0 sometimes writes each reasoning
 * JSON event twice, byte-for-byte (same id, timestamp, and text). Raw JSONL is
 * evidence and stays untouched; human surfaces suppress only an immediately
 * repeated, identical reasoning record. Any intervening event, or an update
 * with the same id but different bytes, is preserved.
 */
export function createEventFormatter(def?: AdapterDef): (line: string) => string | null {
  const decode = createEventLineDecoder(def?.events === "droid-stream-json");
  return (line) => {
    const decoded = decode(line);
    return decoded ? formatDecodedEvent(decoded, def) : null;
  };
}
