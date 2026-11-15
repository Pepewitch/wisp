/** GET /api/update and the accepted POST /api/update response. */
export type InstallMethod = "homebrew" | "managed-linux" | "unsupported";
/**
 * `restart-required`: the update is installed, but nothing supervises this
 * daemon to restart it, so the running process is still the old version until
 * someone restarts it. `message` says how.
 */
export type UpdateState =
  | "up-to-date"
  | "available"
  | "installing"
  | "restarting"
  | "restart-required"
  | "failed"
  | "unavailable";

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
  /** `canInstall && restartsAutomatically`: what clients before `canInstall` offer an update on. */
  canAutoUpdate: boolean;
  /** This daemon can install a newer release (a clean build of a recognized installation). */
  canInstall: boolean;
  /** A supervisor restarts the daemon after an install; otherwise the update ends in `restart-required`. */
  restartsAutomatically: boolean;
  message: string | null;
  checkedAt: string | null;
  /** Null before the first attempt. */
  lastAttempt: UpdateAttempt | null;
}
