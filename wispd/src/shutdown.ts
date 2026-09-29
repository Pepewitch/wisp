import { killAll } from "./terminal";
import { errorDetail } from "./text";

/**
 * How long a SIGTERM or SIGINT waits for the daemon's graceful stop before
 * the process exits anyway. The service manager, a terminal's Ctrl-C and
 * self-update all expect the process to go promptly; what did not settle in
 * time is what boot recovery is built for.
 */
export const SHUTDOWN_DEADLINE_MS = 5_000;

export type ShutdownSignal = "SIGTERM" | "SIGINT";

export interface ShutdownSteps {
  /** The daemon's graceful stop; null before serve() has returned. */
  stop: (() => Promise<void>) | null;
  killShells?: () => Promise<void>;
  exit?: (code: number) => void;
  deadlineMs?: number;
  log?: (line: string) => void;
}

/**
 * Graceful stop, bounded by the deadline; then every terminal shell; then
 * exit with the code a signal-terminated process reports. Each step runs even
 * when the one before it failed or ran out of time.
 */
export async function shutDown(signal: ShutdownSignal, steps: ShutdownSteps): Promise<void> {
  const log = steps.log ?? ((line: string) => console.error(line));
  const deadlineMs = steps.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
  try {
    if (steps.stop) {
      log(`[wisp] ${signal}: stopping the daemon (waiting up to ${deadlineMs / 1000} s)`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), deadlineMs); });
      const outcome = await Promise.race([
        steps.stop().then(() => "stopped" as const, (error: unknown) => {
          log(`[wisp] ${signal}: graceful stop failed: ${errorDetail(error)}`);
          return "failed" as const;
        }),
        deadline,
      ]);
      clearTimeout(timer);
      if (outcome === "stopped") log(`[wisp] ${signal}: daemon stopped`);
      if (outcome === "late") log(`[wisp] ${signal}: graceful stop did not finish within ${deadlineMs / 1000} s; exiting anyway`);
    }
    await (steps.killShells ?? killAll)();
    log(`[wisp] ${signal}: terminal shells stopped`);
  } finally {
    (steps.exit ?? ((code: number) => process.exit(code)))(signal === "SIGTERM" ? 143 : 130);
  }
}

/**
 * Only `wisp serve` installs these, before serve() so a signal during boot
 * still stops the shells. Tests call serve() in-process without them. The
 * returned setter hands over the graceful stop once the server exists. A
 * second signal gets the default action, so a stop that hangs can still be
 * cut short by hand.
 */
export function installShutdownSignals(target: NodeJS.Process = process): (stop: () => Promise<void>) => void {
  let stop: (() => Promise<void>) | null = null;
  let started = false;
  const handle = (signal: ShutdownSignal): void => {
    if (started) return;
    started = true;
    void shutDown(signal, { stop });
  };
  target.once("SIGTERM", () => handle("SIGTERM"));
  target.once("SIGINT", () => handle("SIGINT"));
  return (next) => { stop = next; };
}
