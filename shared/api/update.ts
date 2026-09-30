/** GET /api/update and the accepted POST /api/update response. */
export type InstallMethod = "homebrew" | "managed-linux" | "unsupported";
export type UpdateState = "up-to-date" | "available" | "installing" | "restarting" | "failed" | "unavailable";

/** The last self-update this home ran, from any daemon run. */
export interface UpdateAttempt {
  fromVersion: string;
  toVersion: string;
  method: InstallMethod;
  startedAt: string;
  finishedAt: string | null;
  /** `installing` that is not the running daemon's own attempt never finished: the daemon died mid-update. */
  outcome: "installing" | "installed" | "failed";
  /** The end of the failure's message, where a package manager's own error usually is. */
  error: string | null;
}

export interface UpdateStatus {
  currentVersion: string;
  currentApiProtocolVersion: number;
  latestVersion: string | null;
  latestApiProtocolVersion: number | null;
  state: UpdateState;
  installMethod: InstallMethod;
  canAutoUpdate: boolean;
  message: string | null;
  checkedAt: string | null;
  /** Null before the first attempt. */
  lastAttempt: UpdateAttempt | null;
}
