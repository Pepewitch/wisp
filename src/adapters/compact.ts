/**
 * COMPACT_STRATEGIES (v0.3 A5, settled by SP1): compaction IS reachable
 * headless, which overturns v0.2 — so it ships as a feature, and Q7's
 * `/fresh` + precise-absence wording survives one layer lower as the runtime
 * failure fallback (the route names what failed; the palette offers /fresh).
 *
 * claude needs no entry here: its `/compact` is a local command print mode
 * executes (documented + binary-verified, SP1; executed headless in v0.2),
 * so it rides the normal turn path via AdapterDef.compactPrompt — recorded
 * like any other turn, which is more honest than hiding it out of band.
 *
 * Both strategies here are ACTIONS, not reads: they summarize, so they cost
 * tokens. The palette marks the entry for exactly that (Q6's law). Both
 * protocols are private and versioned; every shape assumption fails loud —
 * a missing newSessionId is reported absent, never invented.
 */
import { VERSION } from "../version";
import { ProbeError } from "./probe";
import type {
  AdapterDef,
  CompactCtx,
  CompactResult,
  CompactStrategy,
  ProbeIo,
} from "./types";

function noSession(): never {
  throw new ProbeError("no session yet — compaction needs a session to compact; run a turn first", 409);
}

export const COMPACT_STRATEGIES: Record<string, CompactStrategy> = {
  /**
   * droid (live-verified 0.205.0, SP1): same JSON-RPC session mode as the
   * context probe — load the task's session, then `droid.compact_session`.
   * The result is `{newSessionId, removedCount}`: compaction MINTS a session
   * (the CLI's own words: "This will start a new session with the resulting
   * summary"), so the caller replaces the task's stored session_id — a field
   * update on an existing column, no schema change.
   */
  "factory-jsonrpc": {
    recordsTurn: false,
    async run(def, ctx, io): Promise<CompactResult> {
      if (!ctx.sessionId) noSession();
      const rpc = io.openRpc([def.bin, "exec", "--input-format", "stream-jsonrpc", "-o", "stream-jsonrpc"], {
        cwd: ctx.cwd ?? undefined,
        envelope: "factory",
        signal: ctx.signal,
      });
      try {
        await rpc.call("droid.load_session", { sessionId: ctx.sessionId });
        // params schema (SP1, from the shipped binary): { customInstructions?:
        // string } — none given, the harness summarizes with its own default
        const res = (await rpc.call("droid.compact_session", {})) as {
          newSessionId?: unknown;
          removedCount?: unknown;
        } | null;
        return {
          removedCount: typeof res?.removedCount === "number" ? res.removedCount : null,
          newSessionId: typeof res?.newSessionId === "string" ? res.newSessionId : null,
          note: null,
        };
      } finally {
        rpc.close();
      }
    },
  },

  /**
   * codex (live-verified 0.149.0, SP1): `codex app-server`, trivial
   * initialize, `thread/resume`, then `thread/compact/start {threadId}`.
   * The response is `{}` — an ACK. The compaction itself is a real turn on
   * codex's side: turn/started … item(contextCompaction) … turn/completed
   * (~4 s live). The honest "it finished" is the turn/completed notification
   * for OUR thread, so we wait for it; a client without notification support
   * reports the ack and says "started" rather than claiming completion.
   */
  "codex-app-server": {
    recordsTurn: true,
    async run(def, ctx, io): Promise<CompactResult> {
      if (!ctx.sessionId) noSession();
      const rpc = io.openRpc([def.bin, "app-server"], { envelope: "plain", signal: ctx.signal });
      try {
        await rpc.call("initialize", { clientInfo: { name: "wisp", version: VERSION } });
        await rpc.call("thread/resume", { threadId: ctx.sessionId });
        // registered BEFORE the start call so a fast compaction can't race us
        const completed = rpc.onNotification
          ? rpc.onNotification(
              "turn/completed",
              (p) => (p as { threadId?: unknown } | null)?.threadId === ctx.sessionId,
            )
          : null;
        await rpc.call("thread/compact/start", { threadId: ctx.sessionId });
        if (completed) await completed;
        return {
          removedCount: null, // codex doesn't say what it dropped
          newSessionId: null, // same thread, less context
          note: completed
            ? "codex recorded it as a turn in its own thread"
            : "started — codex records it as a turn in its own thread",
        };
      } finally {
        rpc.close();
      }
    },
  },
};

/**
 * Run one out-of-turn compaction. The unknown-strategy throw is unreachable
 * via config (validateAdapter rejects unknown names at load); it fires only
 * for defs built in code — loud beats a silent "compacted".
 */
export async function runCompact(
  def: AdapterDef,
  ctx: CompactCtx,
  io: ProbeIo,
): Promise<CompactResult> {
  const strategy = def.compact ? COMPACT_STRATEGIES[def.compact] : undefined;
  if (!def.compact || !strategy) {
    const known = Object.keys(COMPACT_STRATEGIES).join(", ");
    throw new ProbeError(`adapter compact strategy '${def.compact}' is not a known strategy (known: ${known})`, 500);
  }
  return strategy.run(def, ctx, io);
}
