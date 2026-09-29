import { errorDetail } from "./text";

/**
 * Last-resort handlers for the daemon process. Only `wisp serve` installs
 * them; tests call serve() in-process without them, so a stray rejection in
 * a test still fails the run instead of being logged away.
 *
 * **An unhandled rejection is logged and the daemon keeps serving.** Bun ends
 * the process on one, and for the daemon that is the wrong trade: the process
 * owns every live terminal, live-input channel and in-flight request, and one
 * fire-and-forget chain without a `.catch` (a log stream's tick, a background
 * pass) took all of that down, and took it down again after the restart when
 * the trigger was a line in a turn log. By the time a rejection is reported
 * unhandled, the async function that threw has already unwound through its own
 * finally blocks, so nothing it was guarding is left half-written. The
 * failure stays confined to that one chain, and the log line (with its stack)
 * is the bug report. Each known chain catches for itself; this is the net
 * under the one nobody has found yet.
 *
 * **An uncaught exception still ends the process**, after the same logging.
 * It is a synchronous throw that escaped a callback, possibly between two
 * updates to in-memory state the daemon relies on when it signals process
 * groups, re-adopts turns and removes worktrees. Carrying on with that state
 * risks acting on the wrong process or the wrong checkout. Exiting costs a
 * restart, which the service manager performs, and restart is the case boot
 * recovery is built for: running turns are re-adopted from the database and
 * their log files.
 */
export function installDaemonCrashGuards(target: NodeJS.Process = process): void {
  target.on("unhandledRejection", (reason) => {
    console.error(`[wisp] unhandled promise rejection; the daemon keeps serving: ${errorDetail(reason)}`);
  });
  target.on("uncaughtException", (error) => {
    console.error(`[wisp] uncaught exception; the daemon exits so its service manager restarts it: ${errorDetail(error)}`);
    target.exit(1);
  });
}
