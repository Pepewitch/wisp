import { VERSION } from "../version";
import { buildArgv } from "./argv";
import { parseOutput } from "./parse";
import type {
  AdapterDef,
  ContextBreakdown,
  HarnessUsageReport,
  ProbeCommand,
  ProbeCtx,
  ProbeIo,
  ProbeReport,
  ProbeStrategy,
} from "./types";

/**
 * Out-of-turn harness reads. `/context` and
 * the harness's `/usage` are NOT steers — they must not create a turn, flip a
 * settled task back to running, or pollute the conversation. Each strategy
 * here is a short-lived out-of-band client, the same pattern as
 * model-discovery: spawn, one read, kill. A failure degrades to a named
 * ProbeError — never to a fabricated report.
 *
 * All three protocols are private and versioned (droid's
 * factoryProtocolVersion, codex's [experimental] app-server), so every shape
 * assumption fails LOUD: a missing field is absent from the normalized
 * report, a changed envelope is a ProbeError naming what was expected.
 */

/** A probe failure with the HTTP status the route should answer. */
export class ProbeError extends Error {
  constructor(
    message: string,
    /** 409 for expected task states (no session yet), 502 for harness trouble */
    readonly status: number = 502,
  ) {
    super(message);
  }
}

/** Copy a number or leave the field out — probes never invent zeros (Theme B's law). */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function record(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ProbeError(`the harness's ${what} is not a JSON object — the protocol shape may have changed`);
  }
  return v as Record<string, unknown>;
}

function noSession(): never {
  throw new ProbeError("no session yet — the first turn creates one", 409);
}

/** droid's get_context_breakdown payload → ContextBreakdown (SP1 has the verbatim shape). */
function normalizeContextBreakdown(raw: unknown): ContextBreakdown {
  const r = record(raw, "context breakdown");
  const list = (key: string): Record<string, unknown>[] =>
    Array.isArray(r[key]) ? (r[key] as unknown[]).filter((e) => typeof e === "object" && e !== null) as Record<string, unknown>[] : [];
  return {
    model: str(r.modelDisplayName) ?? str(r.modelId),
    budgetTokens: num(r.contextBudget),
    usedTokens: num(r.usedTokens),
    freeTokens: num(r.freeTokens),
    categories: list("categories")
      .map((c) => ({ name: str(c.name) ?? "?", tokens: num(c.tokens) ?? 0 }))
      .filter((c) => c.name !== "?"),
    skills: list("skills")
      .map((s) => ({ name: str(s.name) ?? "?", tokens: num(s.tokens) ?? 0 }))
      .filter((s) => s.name !== "?"),
    mcpServers: list("mcpServers").map((s) => ({
      name: str(s.name) ?? "?",
      toolCount: num(s.toolCount),
      tokens: num(s.tokens) ?? 0,
    })),
  };
}

/** codex's rateLimits + usage reads → HarnessUsageReport (SP1 has the verbatim shapes). */
function normalizeHarnessUsage(rateLimitsRaw: unknown, usageRaw: unknown): HarnessUsageReport {
  const window = (v: unknown): HarnessUsageReport["primary"] => {
    if (typeof v !== "object" || v === null) return null;
    const w = v as Record<string, unknown>;
    const usedPercent = num(w.usedPercent);
    if (usedPercent === null) return null;
    return {
      usedPercent,
      windowMins: num(w.windowDurationMins),
      resetsAt: typeof w.resetsAt === "number" ? new Date(w.resetsAt * 1000).toISOString() : null,
    };
  };
  const rl = record(rateLimitsRaw, "rate-limits report");
  const limits = record(rl.rateLimits ?? rl, "rate-limits report");
  const creditsRaw = limits.credits;
  const usage = record(usageRaw, "usage report");
  const summary = typeof usage.summary === "object" && usage.summary !== null ? (usage.summary as Record<string, unknown>) : {};
  return {
    planType: str(limits.planType),
    primary: window(limits.primary),
    secondary: window(limits.secondary),
    credits:
      typeof creditsRaw === "object" && creditsRaw !== null
        ? {
            hasCredits: (creditsRaw as Record<string, unknown>).hasCredits === true,
            unlimited: (creditsRaw as Record<string, unknown>).unlimited === true,
            balance: num((creditsRaw as Record<string, unknown>).balance),
          }
        : null,
    lifetimeTokens: num(summary.lifetimeTokens),
  };
}

export const PROBE_STRATEGIES: Record<string, ProbeStrategy> = {
  /**
   * claude (live-verified 2.1.251, SP1): `/context` and `/usage` are
   * `type:"local"` commands with `supportsNonInteractive: true` — print mode
   * answers them with zero model tokens and the report as the result event's
   * markdown. The probe is the adapter's own turn argv with the slash command
   * as the prompt and the task's session resumed: the SAME parse strategy
   * then lifts the report off the result line. A resumed session may record
   * the intercepted command in its transcript (the one probe SP1 declined to
   * spend); zero tokens either way.
   */
  "print-slash": {
    commands: ["context", "usage"],
    async run(def, ctx, io): Promise<ProbeReport> {
      if (!ctx.sessionId) noSession();
      const argv = buildArgv(def, { prompt: `/${ctx.command}`, session: ctx.sessionId });
      const res = await io.spawnOnce(argv, { cwd: ctx.cwd ?? undefined, signal: ctx.signal });
      const parsed = parseOutput(def, res.stdout);
      if (!parsed.result) {
        const stderr = res.stderr.trim().split("\n")[0];
        throw new ProbeError(
          `claude answered /${ctx.command} with no report (exit ${res.exitCode})${stderr ? `: ${stderr}` : ""}`,
        );
      }
      return { format: "markdown", text: parsed.result };
    },
  },

  /**
   * droid (live-verified 0.205.0, SP1): the JSON-RPC session mode is the
   * channel — `droid exec --input-format stream-jsonrpc -o stream-jsonrpc`
   * (the pairing is enforced), the Factory envelope, `droid.load_session`
   * against the task's session, one read of `droid.get_context_breakdown`,
   * kill. Zero tokens, not zero latency: opening the session took ~10–12s and
   * spins up the user's real MCP servers, so the caller caches. There is NO
   * usage read — the method table has no credits/usage RPC (SP1) — so this
   * strategy declares context only.
   */
  "factory-jsonrpc": {
    commands: ["context"],
    async run(def, ctx, io): Promise<ProbeReport> {
      if (!ctx.sessionId) noSession();
      const rpc = io.openRpc([def.bin, "exec", "--input-format", "stream-jsonrpc", "-o", "stream-jsonrpc"], {
        cwd: ctx.cwd ?? undefined,
        envelope: "factory",
        signal: ctx.signal,
      });
      try {
        await rpc.call("droid.load_session", { sessionId: ctx.sessionId });
        const breakdown = await rpc.call("droid.get_context_breakdown", {});
        return { format: "context", context: normalizeContextBreakdown(breakdown) };
      } finally {
        rpc.close();
      }
    },
  },

  /**
   * codex (live-verified 0.149.0, SP1): `codex app-server` speaks plain
   * JSON-RPC over stdio and needs only a trivial `initialize`. The honest
   * reads are account-level: `account/rateLimits/read` (the two windows) and
   * `account/usage/read` (lifetime summary). There is no per-thread context
   * read (token usage arrives as a notification, never an answer — SP1), so
   * this strategy declares usage only, and the panel must say "account".
   */
  "codex-app-server": {
    commands: ["usage"],
    async run(def, ctx, io): Promise<ProbeReport> {
      // account-level reads: no session and no cwd needed (SP1) — but the
      // caller's timeout still applies
      const rpc = io.openRpc([def.bin, "app-server"], { envelope: "plain", signal: ctx.signal });
      try {
        await rpc.call("initialize", { clientInfo: { name: "wisp", version: VERSION } });
        const [rateLimits, usage] = await Promise.all([
          rpc.call("account/rateLimits/read", {}),
          rpc.call("account/usage/read", {}),
        ]);
        return { format: "usage", usage: normalizeHarnessUsage(rateLimits, usage) };
      } finally {
        rpc.close();
      }
    },
  },
};

/** The reads a harness honestly offers — what the route and the palette enumerate. */
export function probeCommands(def: AdapterDef): ProbeCommand[] {
  if (!def.probe) return [];
  return PROBE_STRATEGIES[def.probe]?.commands ?? [];
}

/**
 * Run one out-of-turn read. The unknown-strategy throw is unreachable via
 * config (validateAdapter rejects unknown names at load); it fires only for
 * defs built in code — loud beats a silent "no report".
 */
export async function runProbe(
  def: AdapterDef,
  command: ProbeCommand,
  ctx: Omit<ProbeCtx, "command">,
  io: ProbeIo,
): Promise<ProbeReport> {
  const strategy = def.probe ? PROBE_STRATEGIES[def.probe] : undefined;
  if (!def.probe || !strategy) {
    const known = Object.keys(PROBE_STRATEGIES).join(", ");
    throw new ProbeError(`adapter probe strategy '${def.probe}' is not a known strategy (known: ${known})`, 500);
  }
  return strategy.run(def, { ...ctx, command }, io);
}
