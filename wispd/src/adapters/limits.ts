import { VERSION } from "../version";
import type { AdapterDef, ProbeSpawnFn, RpcFactory } from "./types";

/**
 * Account plan limits: how much of each usage window a harness's account has
 * spent, read out of band with no task, no session and no model tokens. Each
 * strategy is one harness's own read, normalized here so the API, the CLI and
 * the web popover only ever see `HarnessLimits`.
 *
 * The discipline is probe.ts's: numbers are copied, never invented. A window
 * the harness did not report is absent, and a read that cannot be trusted is a
 * named `LimitsError`, never an empty report that reads as "nothing used".
 */

export type LimitsStatus = "ok" | "needs-key" | "account-mismatch" | "unavailable" | "error";

/** One usage window, as the harness reports it. */
export interface LimitWindow {
  /** stable within the harness, so a client can key rows */
  id: string;
  /** what the harness calls the window: `5h`, `7d`, `weekly`, a model name */
  label: string;
  /** a separate allowance inside one account (droid's standard/core, a codex per-model limit) */
  pool: string | null;
  /** the one model this window limits (claude's per-model week); null for a window every model draws from */
  model: string | null;
  usedPercent: number;
  /** null when the window has not started (droid's idle 5h) or the harness named no reset */
  resetsAt: string | null;
  /** the window's length when the harness states or implies it; null when it varies (a month) */
  windowMins: number | null;
}

export interface HarnessLimits {
  /** the plan name, when the harness reports one */
  plan: string | null;
  windows: LimitWindow[];
  /**
   * droid only: whether the API key's account was checked against the one
   * droid's own login uses. `unchecked` means droid's cache file could not be
   * read, so the numbers are the key's account and nothing more is known.
   */
  account?: "verified" | "unchecked";
}

/** A read that answered with something other than limits. `status` is what the client should say. */
export class LimitsError extends Error {
  constructor(
    message: string,
    readonly status: Exclude<LimitsStatus, "ok"> = "error",
  ) {
    super(message);
  }
}

export interface LimitsCtx {
  now: Date;
  signal?: AbortSignal;
  /** the credential a strategy declared it needs, resolved by the daemon; null when none is set */
  credential: string | null;
}

/** Everything a strategy needs from the outside, injected so tests never spawn a CLI or reach a network. */
export interface LimitsIo {
  spawnOnce: ProbeSpawnFn;
  openRpc: RpcFactory;
  fetch: (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
  /** a file's text, or null when it is missing or unreadable */
  readFile: (path: string) => string | null;
  homeDir: string;
  /** a neutral cwd for a CLI that would otherwise load the daemon's project settings */
  scratchDir: string;
}

export interface LimitsStrategy {
  /** the daemon-held secret this read needs; absent = the harness's own login is enough */
  credential?: "factoryApiKey";
  run(def: AdapterDef, ctx: LimitsCtx, io: LimitsIo): Promise<HarnessLimits>;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function epochIso(v: unknown): string | null {
  const seconds = num(v);
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

/** A window's length in the words the popover uses: 300 → `5h`, 10080 → `7d`. */
export function windowLabel(mins: number | null): string {
  if (mins === null || mins <= 0) return "limit";
  if (mins % 1440 === 0) return `${mins / 1440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

/* ---------------- claude ---------------- */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * `Sep 30 at 3:59am (UTC)`, `Sep 30, 2027 at 4am (UTC)` or `5:49am (UTC)` →
 * ISO. claude names no year, so the reset is the next such instant: a date
 * more than a day and a half behind `now` belongs to next year. Anything not
 * stated in UTC is refused, because the probe runs claude with `TZ=UTC` and a
 * different zone means the wording moved.
 */
export function parseClaudeReset(text: string, now: Date): string | null {
  const m = text
    .trim()
    .match(/^(?:([A-Za-z]{3})[a-z]* (\d{1,2})(?:, (\d{4}))? at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm) \(UTC\)$/i);
  if (!m) return null;
  let hour = Number(m[4]) % 12;
  if (m[6]!.toLowerCase() === "pm") hour += 12;
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  if (hour > 23 || minute > 59) return null;
  if (m[1] === undefined) {
    let at = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute);
    if (at < now.getTime() - 60_000) at += 86_400_000;
    return new Date(at).toISOString();
  }
  const month = MONTHS.indexOf(m[1].toLowerCase());
  const day = Number(m[2]);
  if (month < 0 || day < 1 || day > 31) return null;
  if (m[3] !== undefined) return new Date(Date.UTC(Number(m[3]), month, day, hour, minute)).toISOString();
  let at = Date.UTC(now.getUTCFullYear(), month, day, hour, minute);
  if (at < now.getTime() - 36 * 3_600_000) at = Date.UTC(now.getUTCFullYear() + 1, month, day, hour, minute);
  return new Date(at).toISOString();
}

/**
 * claude's `/usage` report (live-verified 2.1.282):
 *
 *     Current session: 33% used · resets Sep 25 at 5:49am (UTC)
 *     Current week (all models): 51% used · resets Sep 30 at 3:59am (UTC)
 *     Current week (Fable): 0% used · resets Sep 30 at 4am (UTC)
 *
 * The session window is claude's 5-hour one and a week is seven days. A
 * report with none of these lines is an account without plan limits (an API
 * key, not a subscription): that is `unavailable`, in claude's own words.
 */
export function parseClaudeUsage(text: string, now: Date): HarnessLimits {
  const windows: LimitWindow[] = [];
  const line = /^\s*Current (session|week)(?: \(([^)]+)\))?: (\d+(?:\.\d+)?)% used(?: · resets (.+?))?\s*$/gim;
  for (const m of text.matchAll(line)) {
    const session = m[1]!.toLowerCase() === "session";
    const scope = m[2]?.trim() ?? null;
    const model = scope !== null && scope.toLowerCase() !== "all models" ? scope : null;
    windows.push({
      id: session ? "session" : model ? `week:${model.toLowerCase()}` : "week",
      label: session ? "5h" : model ?? "7d",
      pool: null,
      model,
      usedPercent: Number(m[3]),
      resetsAt: m[4] === undefined ? null : parseClaudeReset(m[4], now),
      windowMins: session ? 300 : 10_080,
    });
  }
  if (windows.length === 0) {
    const first = text.trim().split("\n")[0]?.trim();
    throw new LimitsError(first ? `claude reports no plan limits: ${first}` : "claude reports no plan limits", "unavailable");
  }
  return { plan: null, windows };
}

/* ---------------- codex ---------------- */

/** One of codex's `primary`/`secondary` rate-limit windows; shared with the `/usage` probe so both agree. */
export function codexRateWindow(
  v: unknown,
): { usedPercent: number; windowMins: number | null; resetsAt: string | null } | null {
  if (!isRecord(v)) return null;
  const usedPercent = num(v.usedPercent);
  if (usedPercent === null) return null;
  return { usedPercent, windowMins: num(v.windowDurationMins), resetsAt: epochIso(v.resetsAt) };
}

/**
 * codex's `account/rateLimits/read` (live-verified 0.156.1). Which windows
 * exist depends on the plan: a team plan reported a 7-day `primary` and a
 * null `secondary`, so windows are labelled by their stated length and never
 * by position. `rateLimitsByLimitId` carries every limit (per-model ones
 * included); the default `codex` limit has no pool name. An `individualLimit`
 * is a per-seat credit allowance with its own reset.
 */
export function normalizeCodexLimits(raw: unknown): HarnessLimits {
  if (!isRecord(raw)) {
    throw new LimitsError("codex's rate-limits report is not a JSON object — the protocol shape may have changed");
  }
  const byId = isRecord(raw.rateLimitsByLimitId) ? Object.values(raw.rateLimitsByLimitId) : [];
  const limits = (byId.length > 0 ? byId : [raw.rateLimits]).filter(isRecord);
  const windows: LimitWindow[] = [];
  let plan: string | null = null;
  for (const limit of limits) {
    const limitId = str(limit.limitId) ?? "codex";
    const pool = limitId === "codex" ? null : (str(limit.limitName) ?? limitId);
    if (pool === null) plan = str(limit.planType) ?? plan;
    for (const slot of ["primary", "secondary"] as const) {
      const w = codexRateWindow(limit[slot]);
      if (w) windows.push({ id: `${limitId}:${slot}`, label: windowLabel(w.windowMins), pool, model: null, ...w });
    }
    const seat = limit.individualLimit;
    const remaining = isRecord(seat) ? num(seat.remainingPercent) : null;
    if (isRecord(seat) && remaining !== null) {
      windows.push({
        id: `${limitId}:credits`,
        label: "credits",
        pool,
        model: null,
        usedPercent: Math.max(0, 100 - remaining),
        resetsAt: epochIso(seat.resetsAt),
        windowMins: null,
      });
    }
    plan ??= str(limit.planType);
  }
  if (windows.length === 0) throw new LimitsError("codex reports no rate-limit windows for this account", "unavailable");
  return { plan, windows };
}

/* ---------------- droid ---------------- */

/** The host droid itself calls. Hardcoded: the destination of a request carrying the key is never configurable. */
export const FACTORY_API = "https://api.factory.ai";

const FACTORY_BUCKETS = [
  { key: "fiveHour", label: "5h", windowMins: 300 },
  { key: "weekly", label: "weekly", windowMins: 10_080 },
  { key: "monthly", label: "monthly", windowMins: null },
] as const;

/**
 * Factory's `GET /api/billing/limits` (read out of the droid CLI; live-verified
 * 2026-09-25): `limits.standard` and `limits.core`, each with `fiveHour`,
 * `weekly` and `monthly` buckets of `{usedPercent, windowEnd}`. A window that
 * has not opened yet has `windowEnd: null`, and one whose end has passed is
 * the next, untouched window — droid's own panel shows both as 0% with no
 * countdown, and so does this.
 */
export function normalizeFactoryLimits(raw: unknown, now: Date): HarnessLimits {
  const limits = isRecord(raw) && isRecord(raw.limits) ? raw.limits : null;
  if (!limits || !isRecord(limits.standard)) {
    throw new LimitsError("this Factory plan reports no usage windows", "unavailable");
  }
  const windows: LimitWindow[] = [];
  for (const pool of ["standard", "core"] as const) {
    const buckets = limits[pool];
    if (!isRecord(buckets)) continue;
    for (const bucket of FACTORY_BUCKETS) {
      const b = buckets[bucket.key];
      if (!isRecord(b)) continue;
      const used = num(b.usedPercent);
      if (used === null) continue;
      const end = str(b.windowEnd);
      const endMs = end === null ? NaN : Date.parse(end);
      const live = Number.isFinite(endMs) && endMs > now.getTime();
      windows.push({
        id: `${pool}:${bucket.key}`,
        label: bucket.label,
        pool,
        model: null,
        usedPercent: live ? used : 0,
        resetsAt: live ? new Date(endMs).toISOString() : null,
        windowMins: bucket.windowMins,
      });
    }
  }
  if (windows.length === 0) throw new LimitsError("this Factory plan reports no usage windows", "unavailable");
  return { plan: null, windows };
}

async function factoryGet(io: LimitsIo, path: string, key: string, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await io.fetch(`${FACTORY_API}${path}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new LimitsError(`could not reach Factory: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new LimitsError("Factory rejected the API key. Replace it in Settings.", "needs-key");
  }
  if (!res.ok) throw new LimitsError(`the Factory API answered ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new LimitsError("the Factory API answered with something other than JSON");
  }
}

/** The account droid's own login uses, from the one file droid keeps it in unencrypted; null when unknown. */
export function droidLoginAccount(io: LimitsIo): { userId: string; orgId: string } | null {
  const text = io.readFile(`${io.homeDir}/.factory/org-managed-settings.cache.json`);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    const userId = str(parsed.userId);
    const orgId = str(parsed.orgId);
    return userId && orgId ? { userId, orgId } : null;
  } catch {
    return null;
  }
}

/**
 * The key's account against droid's login. Limits are per user within an
 * organization, so a key for the same person in another organization is a
 * different allowance, and both ids must match. An unreadable login file is
 * not a mismatch: it only means Wisp cannot say.
 */
function checkAccount(whoami: unknown, login: { userId: string; orgId: string } | null): "verified" | "unchecked" {
  if (login === null) return "unchecked";
  const key = isRecord(whoami) ? { userId: str(whoami.userId), orgId: str(whoami.orgId) } : null;
  if (!key?.userId || !key.orgId) return "unchecked";
  if (key.userId !== login.userId || key.orgId !== login.orgId) {
    throw new LimitsError(
      "This Factory API key belongs to a different account than the one droid is logged in to.",
      "account-mismatch",
    );
  }
  return "verified";
}

export const LIMIT_STRATEGIES: Record<string, LimitsStrategy> = {
  /**
   * claude (live-verified 2.1.282): `/usage` is a local command, so print
   * mode answers it with zero model tokens in ~0.5s. `--no-session-persistence`
   * keeps the read out of the user's session history, and `TZ=UTC` makes
   * claude state every reset in UTC, which is the only zone the parser reads.
   */
  "claude-usage": {
    async run(def, ctx, io) {
      const res = await io.spawnOnce(
        [def.bin, "-p", "/usage", "--output-format", "json", "--no-session-persistence"],
        { cwd: io.scratchDir, env: { TZ: "UTC" }, signal: ctx.signal },
      );
      const line = res.stdout.split("\n").reverse().find((l) => l.trim().startsWith("{"));
      let parsed: unknown;
      try {
        parsed = line ? JSON.parse(line) : null;
      } catch {
        parsed = null;
      }
      const result = isRecord(parsed) ? str(parsed.result) : null;
      if (!isRecord(parsed) || result === null) {
        const stderr = res.stderr.trim().split("\n")[0];
        throw new LimitsError(`claude answered /usage with no report (exit ${res.exitCode})${stderr ? `: ${stderr}` : ""}`);
      }
      if (parsed.is_error === true) throw new LimitsError(`claude refused /usage: ${result.split("\n")[0]}`);
      return parseClaudeUsage(result, ctx.now);
    },
  },

  /** codex (live-verified 0.156.1): the app-server's account read, the same channel as the `/usage` probe. */
  "codex-rate-limits": {
    async run(def, ctx, io) {
      const rpc = io.openRpc([def.bin, "app-server"], { envelope: "plain", signal: ctx.signal });
      try {
        await rpc.call("initialize", { clientInfo: { name: "wisp", version: VERSION } });
        return normalizeCodexLimits(await rpc.call("account/rateLimits/read", {}));
      } catch (error) {
        if (error instanceof LimitsError) throw error;
        throw new LimitsError(error instanceof Error ? error.message : String(error));
      } finally {
        rpc.close();
      }
    },
  },

  /**
   * droid: there is no limits RPC and exec's `/limits` runs a model turn, so
   * this reads the endpoint droid's own usage panel calls, with a Factory API
   * key the user gave Wisp. droid's login files are encrypted and never read;
   * only its unencrypted account cache is, to check the key is for the same
   * account (both ids come back from `GET /api/cli/whoami`).
   */
  "factory-billing": {
    credential: "factoryApiKey",
    async run(_def, ctx, io) {
      const key = ctx.credential;
      if (!key) throw new LimitsError("Add a Factory API key in Settings to show droid's limits.", "needs-key");
      const [whoami, billing] = await Promise.all([
        factoryGet(io, "/api/cli/whoami", key, ctx.signal),
        factoryGet(io, "/api/billing/limits", key, ctx.signal),
      ]);
      const account = checkAccount(whoami, droidLoginAccount(io));
      return { ...normalizeFactoryLimits(billing, ctx.now), account };
    },
  },
};

/**
 * Run one harness's limits read. The unknown-strategy throw is unreachable
 * through config (validate.ts rejects unknown names at load); it fires only
 * for a def built in code.
 */
export function runLimits(def: AdapterDef, ctx: LimitsCtx, io: LimitsIo): Promise<HarnessLimits> {
  const strategy = def.limits ? LIMIT_STRATEGIES[def.limits] : undefined;
  if (!def.limits || !strategy) {
    const known = Object.keys(LIMIT_STRATEGIES).join(", ");
    throw new LimitsError(`adapter limits strategy '${def.limits}' is not a known strategy (known: ${known})`);
  }
  return strategy.run(def, ctx, io);
}
