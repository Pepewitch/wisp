/**
 * Daemon-wide settings as the API serves them: GET/PATCH /api/settings, the
 * write-only secrets' status, and the reusable suffix prompts.
 */
import type { LimitsStatus } from "./harness";

// A type alias, not an interface, so the daemon can hand it to patchConfig's
// Record<string, unknown> without a cast.
/** The daemon-wide preferences a client may read and PATCH. */
export type WispPreferences = {
  autoRenameTasksFromPullRequests: boolean;
  /**
   * harness name -> model ids kept OUT of the model picker. A denylist, so a
   * model a later probe discovers shows up on its own.
   */
  hiddenModels: Record<string, string[]>;
};

/** Where a write-only secret came from: saved through PATCH /api/settings, or the daemon's environment. */
export type SecretKeySource = "settings" | "environment";

/** A write-only daemon secret as a client may see it: never the key, only whether it is set, where from, and its last four characters. */
export interface SecretKeyStatus {
  configured: boolean;
  /** "settings" wins over the daemon's environment. */
  source: SecretKeySource | null;
  /** "…abcd" */
  hint: string | null;
}

/** The review judge's spend this calendar month on this daemon, probes included. */
export interface JudgeUsage {
  month: string;
  calls: number;
  errors: number;
  inputTokens: number;
  costUsd: number;
}

/** The optional review judge as a client may see it. */
export interface ReviewJudgeStatus extends SecretKeyStatus {
  model: string;
  usage: JudgeUsage;
}

/** GET/PATCH /api/settings */
export type WispSettings = WispPreferences & {
  reviewJudge: ReviewJudgeStatus;
  /** The Factory API key droid's plan limits are read with. */
  usageLimits: { factoryKey: SecretKeyStatus };
};

/** POST /api/settings/review-judge/test: one small call with the daemon's current key. */
export type ReviewJudgeTest = { ok: true; ms: number; model: string } | { ok: false; error: string };

/**
 * POST /api/settings/factory-key/test: droid's limits read now with the
 * current key. `account` says whether the key was matched against droid's
 * own login; `unchecked` means droid's account file was not readable.
 */
export type FactoryKeyTest =
  | { ok: true; ms: number; account: "verified" | "unchecked" }
  | { ok: false; error: string; status?: LimitsStatus };

/** A daemon-wide reusable prompt appended to a task or steer submission. */
export interface SuffixPrompt {
  id: string;
  name: string;
  prompt: string;
  createdAt: string;
}
