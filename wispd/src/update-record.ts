import { join } from "node:path";
import { WISP_HOME } from "./config";
import { readStateFile, writeStateFile } from "./state-file";

/**
 * The durable record of the last self-update, kept in the Wisp home. The
 * update manager's in-memory state dies with the restart an update ends in,
 * and a failed `brew upgrade` can leave the service unable to start, so this
 * file is what is left to say what was attempted and how it ended. The update
 * status API and `wisp doctor` both report it.
 */
export interface UpdateAttempt {
  fromVersion: string;
  toVersion: string;
  method: "homebrew" | "managed-linux" | "unsupported";
  startedAt: string;
  finishedAt: string | null;
  /** `installing` that is not the running daemon's own attempt never finished: the daemon died mid-update. */
  outcome: "installing" | "installed" | "failed";
  /** The end of the failure's message, where a package manager's own error usually is. */
  error: string | null;
}

export const UPDATE_RECORD_PATH = join(WISP_HOME, "update-last.json");
const ERROR_CHARS = 1000;

/** The end of a failure message, bounded. */
export function errorTail(message: string): string {
  return message.length > ERROR_CHARS ? `…${message.slice(-ERROR_CHARS)}` : message;
}

export function readUpdateAttempt(path: string = UPDATE_RECORD_PATH): UpdateAttempt | null {
  const value = readStateFile(path) as Partial<UpdateAttempt> | null;
  if (!value || typeof value !== "object") return null;
  const { fromVersion, toVersion, startedAt, outcome } = value;
  if (typeof fromVersion !== "string" || typeof toVersion !== "string" || typeof startedAt !== "string") return null;
  if (outcome !== "installing" && outcome !== "installed" && outcome !== "failed") return null;
  const text = (field: unknown): string | null => (typeof field === "string" ? field : null);
  return {
    fromVersion,
    toVersion,
    method: value.method === "homebrew" || value.method === "managed-linux" ? value.method : "unsupported",
    startedAt,
    finishedAt: text(value.finishedAt),
    outcome,
    error: text(value.error),
  };
}

/** Persist and log one step of an attempt; a record that cannot be written is logged, never fatal. */
export function recordUpdateAttempt(path: string, attempt: UpdateAttempt, log: (line: string) => void): void {
  const route = `${attempt.fromVersion} → ${attempt.toVersion} (${attempt.method})`;
  if (attempt.outcome === "installing") log(`[wisp] self-update ${route}: installing`);
  else if (attempt.outcome === "installed") log(`[wisp] self-update ${route}: installed; restarting`);
  else log(`[wisp] self-update ${route}: failed: ${attempt.error ?? "unknown error"}`);
  if (!writeStateFile(path, attempt)) log(`[wisp] self-update: could not record the attempt in ${path}`);
}
