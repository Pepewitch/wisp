import type { AdapterDef } from "../types";

function commandArgs(def: AdapterDef): string[] {
  return def.exec[0] === "exec" ? def.exec.slice(1) : def.exec;
}

function droidCommand(def: AdapterDef): string[] {
  const passthrough: string[] = [];
  const source = commandArgs(def);
  for (let i = 0; i < source.length; i++) {
    const arg = source[i]!;
    if (arg === "-o" || arg === "--output-format" || arg === "--input-format") {
      i++;
    } else {
      passthrough.push(arg);
    }
  }
  return [def.bin, "exec", ...passthrough, "--input-format", "stream-jsonrpc", "-o", "stream-jsonrpc"];
}

function codexCommand(def: AdapterDef): string[] {
  const passthrough: string[] = [];
  const source = commandArgs(def);
  for (let i = 0; i < source.length; i++) {
    const arg = source[i]!;
    if (arg === "--json" || arg === "--dangerously-bypass-approvals-and-sandbox") continue;
    if (arg === "-c" || arg === "--config" || arg === "--enable" || arg === "--disable") {
      passthrough.push(arg, source[++i]!);
    }
  }
  return [def.bin, "app-server", "--stdio", ...passthrough];
}

/** Explain an exec shape that the protocol command cannot preserve. */
export function liveCommandIssue(def: AdapterDef): string | null {
  if (def.liveInput !== "codex-app-server") return null;
  const source = commandArgs(def);
  for (let i = 0; i < source.length; i++) {
    const arg = source[i]!;
    if (arg === "--json" || arg === "--dangerously-bypass-approvals-and-sandbox") continue;
    if (arg === "-c" || arg === "--config" || arg === "--enable" || arg === "--disable") {
      if (source[i + 1] === undefined) return `${arg} is missing its value`;
      i++;
      continue;
    }
    return `${arg} cannot be forwarded to codex app-server`;
  }
  return null;
}

/** Swap only the one-shot IO shell; model/session/effort travel in RPC params. */
export function liveCommand(def: AdapterDef): string[] | null {
  const issue = liveCommandIssue(def);
  if (issue) throw new Error(`adapter liveInput '${def.liveInput}' is incompatible with exec: ${issue}`);
  if (def.liveInput === "droid-jsonrpc") return droidCommand(def);
  if (def.liveInput === "codex-app-server") return codexCommand(def);
  return null;
}
