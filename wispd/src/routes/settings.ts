import {
  patchConfig,
  persistWispSettings,
  validateHiddenModels,
  wispSettings,
  type WispConfig,
  type WispSettings,
} from "../config";
import { JEV_MODEL, countJudgeUsage, jevClient, jevKey, judgeUsage, type JudgeClient, type JudgeKeySource, type JudgeUsage } from "../autopilot/judge";
import { emit } from "../events";
import type { AdapterDef } from "../adapters";
import { LIMIT_STRATEGIES } from "../adapters";
import { factoryKey, type FactoryKeySource, type HarnessLimitsCache } from "../harness-limits";
import { typeName } from "../validate";
import { err, json, jsonObjectBody } from "./http";

/** Key-order-insensitive, because two equal curations must compare equal. */
function sameHiddenModels(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  // both sides come from validateHiddenModels, so each list is deduped + sorted
  return keys.every((key) => b[key] !== undefined && a[key]!.join("\u0000") === b[key]!.join("\u0000"));
}

/** The review judge as a client may see it: never the key, only whether one is set and its last four characters. */
export interface ReviewJudgeStatus {
  configured: boolean
  source: JudgeKeySource | null
  hint: string | null
  model: string
  usage: JudgeUsage
}

export function reviewJudgeStatus(cfg: Pick<WispConfig, "jevApiKey">, now = new Date()): ReviewJudgeStatus {
  const key = jevKey(cfg);
  return { configured: key !== null, source: key?.source ?? null, hint: key ? `…${key.key.slice(-4)}` : null, model: JEV_MODEL, usage: judgeUsage(now) };
}

/** The Factory API key for droid's plan limits, as a client may see it: never the key. */
export interface FactoryKeyStatus {
  configured: boolean
  source: FactoryKeySource | null
  hint: string | null
}

export function factoryKeyStatus(cfg: Pick<WispConfig, "factoryApiKey">, env?: Record<string, string | undefined>): FactoryKeyStatus {
  const key = factoryKey(cfg, env);
  return { configured: key !== null, source: key?.source ?? null, hint: key ? `…${key.key.slice(-4)}` : null };
}

const settingsView = (cfg: WispConfig) => ({
  ...wispSettings(cfg),
  reviewJudge: reviewJudgeStatus(cfg),
  usageLimits: { factoryKey: factoryKeyStatus(cfg) },
});

type SecretField = "jevApiKey" | "factoryApiKey";

/** A pasted key: printable, no spaces, a sane length. `null` removes it. */
function validKey(field: SecretField, value: unknown): string | null | Response {
  if (value === null) return null;
  if (typeof value !== "string") return err(`${field} must be a string or null, got ${typeName(value)}`, 400);
  const key = value.trim();
  if (!/^[\x21-\x7e]{8,512}$/.test(key)) return err(`${field} must be 8–512 printable characters with no spaces`, 400);
  return key;
}

function saveKey(cfg: WispConfig, field: SecretField, key: string | null): void {
  // undefined drops the key from config.json; JSON has no way to write it
  patchConfig({ [field]: key ?? undefined });
  if (key === null) delete cfg[field];
  else cfg[field] = key;
}

const PROBE = "The build is green and the preview is deployed.";

/** POST /api/settings/review-judge/test: one small call with the current key, to show it works and how fast. */
async function testReviewJudge(cfg: WispConfig, client?: JudgeClient): Promise<Response> {
  const key = jevKey(cfg);
  if (!key && !client) return json({ ok: false, error: "No Jev API key is set" });
  const started = performance.now();
  // a probe costs like any call, so it is counted like one
  const at = new Date().toISOString();
  try {
    const answer = await (client ?? jevClient(key!.key))({ text: PROBE, bot: true, postedAs: "comment" }, AbortSignal.timeout(15_000));
    countJudgeUsage(at, answer.inputTokens, false);
    return json({ ok: true, ms: Math.round(performance.now() - started), model: answer.model });
  } catch (e) {
    countJudgeUsage(at, 0, true);
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export interface FactoryKeyTestContext {
  cache: HarnessLimitsCache
  adapters: Record<string, AdapterDef>
}

/**
 * POST /api/settings/factory-key/test: read droid's limits now, past the
 * cache, with the current key. `account` says whether the key was matched
 * against droid's own login; a mismatch is a failed test.
 */
async function testFactoryKey(cfg: WispConfig, ctx?: FactoryKeyTestContext): Promise<Response> {
  if (!factoryKey(cfg)) return json({ ok: false, error: "No Factory API key is set" });
  const harness = ctx
    ? Object.entries(ctx.adapters).find(([, def]) => def.limits && LIMIT_STRATEGIES[def.limits]?.credential === "factoryApiKey")
    : undefined;
  if (!ctx || !harness) return json({ ok: false, error: "No loaded harness reads its limits with a Factory API key" });
  const started = performance.now();
  const entry = await ctx.cache.readNow(harness[0], harness[1], cfg);
  if (entry.status !== "ok") return json({ ok: false, error: entry.message ?? "The read failed", status: entry.status });
  return json({ ok: true, ms: Math.round(performance.now() - started), account: entry.limits?.account ?? "unchecked" });
}

/**
 * GET/PATCH /api/settings
 *
 * This is deliberately a narrow public view rather than config.json over
 * HTTP: credentials and operational settings never leave the daemon.
 *
 * PATCH is a real patch — each key is independent, and an older client that
 * only knows `autoRenameTasksFromPullRequests` must not blank a curation it
 * has never heard of.
 */
export function settingsRoute(
  req: Request,
  path: string,
  method: string,
  cfg: WispConfig,
  judge?: JudgeClient,
  factory?: FactoryKeyTestContext,
): Response | Promise<Response> | null {
  if (path === "/api/settings/review-judge/test") return method === "POST" ? testReviewJudge(cfg, judge) : null;
  if (path === "/api/settings/factory-key/test") return method === "POST" ? testFactoryKey(cfg, factory) : null;
  if (path !== "/api/settings") return null;
  if (method === "GET") return json(settingsView(cfg));
  if (method !== "PATCH") return null;

  return (async () => {
    const parsed = await jsonObjectBody(req);
    if (parsed instanceof Response) return parsed;
    const current = wispSettings(cfg);
    const next: WispSettings = { ...current };

    const rename = parsed.autoRenameTasksFromPullRequests;
    const hidden = parsed.hiddenModels;
    const jev = parsed.jevApiKey;
    const factoryRaw = parsed.factoryApiKey;
    if (rename === undefined && hidden === undefined && jev === undefined && factoryRaw === undefined) {
      return err("autoRenameTasksFromPullRequests, hiddenModels, jevApiKey or factoryApiKey is required", 400);
    }
    const key = jev === undefined ? undefined : validKey("jevApiKey", jev);
    if (key instanceof Response) return key;
    const factoryValue = factoryRaw === undefined ? undefined : validKey("factoryApiKey", factoryRaw);
    if (factoryValue instanceof Response) return factoryValue;
    if (rename !== undefined) {
      if (typeof rename !== "boolean") {
        return err(
          `autoRenameTasksFromPullRequests must be a boolean, got ${typeName(rename)}`,
          400,
        );
      }
      next.autoRenameTasksFromPullRequests = rename;
    }
    if (hidden !== undefined) {
      try {
        next.hiddenModels = validateHiddenModels(hidden, "hiddenModels");
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e), 400);
      }
    }

    const keyChanged = key !== undefined && key !== (cfg.jevApiKey ?? null);
    const factoryChanged = factoryValue !== undefined && factoryValue !== (cfg.factoryApiKey ?? null);
    if (
      !keyChanged &&
      !factoryChanged &&
      next.autoRenameTasksFromPullRequests === current.autoRenameTasksFromPullRequests &&
      sameHiddenModels(next.hiddenModels, current.hiddenModels)
    ) {
      // no-op: rewriting config.json and waking every client would be noise
      return json(settingsView(cfg));
    }
    if (keyChanged) saveKey(cfg, "jevApiKey", key);
    if (factoryChanged) saveKey(cfg, "factoryApiKey", factoryValue);
    persistWispSettings(cfg, next);
    emit({ type: "settings" });
    return json(settingsView(cfg));
  })();
}
