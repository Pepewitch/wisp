import { logFailure } from "./failure-log";
import { errorDetail } from "./text";

/**
 * Last-resort handlers for the daemon process. Only `wisp serve` installs
 * them; tests call serve() in-process without them, so a stray rejection in
 * a test still fails the run instead of being logged away.
 *
 * **An unhandled rejection is logged and the daemon keeps serving.** This is
 * a trade-off, not a guarantee. Bun ends the process on one, which takes down
 * every live terminal, live-input channel and in-flight request with the one
 * chain that forgot its `.catch`, and takes them down again after the restart
 * when the trigger is still there (a line in a turn log was). Keeping the
 * process gives up the one thing a crash is sure to do: discard whatever
 * state that chain left behind. The async function that threw has run its
 * own finally blocks by then, but it may still have stopped between two
 * updates it meant to make together (a turn left `running`, a slot never
 * released). We accept that risk because such a chain is one task's work,
 * while a crash is every task's; the log line, with its stack and a repeat
 * count, is the bug report. Each known chain catches for itself; this is the
 * net under the one nobody has found yet.
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
    logFailure("unhandled promise rejection; the daemon keeps serving", reason);
  });
  target.on("uncaughtException", (error) => {
    console.error(`[wisp] uncaught exception; the daemon exits so its service manager restarts it: ${errorDetail(error)}`);
    target.exit(1);
  });
}
