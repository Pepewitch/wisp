/**
 * `xcrun stapler staple` and `validate`, with retries for Apple's ticket service.
 *
 * Stapling downloads a notarized app's ticket from Apple's CloudKit ticket
 * service (`api.apple-cloudkit.com/…/com.apple.gk.ticket-delivery`), and
 * validating a stapled app looks it up there. That request drops now and
 * then: NSURLErrorDomain -1005, "The network connection was lost", reported
 * by stapler as "Error 68". One release makes about seven of these requests
 * (stapling the daemon and Desktop; validating the daemon, its extracted
 * archive and Desktop; both again at promotion), and 0.7.0, 0.7.1 and 0.7.2
 * each lost one, so a single dropped request failed the whole signed job.
 *
 * Only a failure that names the network is retried. A ticket that is missing
 * or invalid fails at once, exactly as before.
 */

export interface StaplerDeps {
  spawn(cmd: string[]): { exitCode: number; stdout: string; stderr: string };
  sleep(ms: number): void;
  log(line: string): void;
}

/** Waits between attempts: about 2.5 minutes in all before giving up. */
export const STAPLER_RETRY_DELAYS_MS = [10_000, 20_000, 40_000, 80_000] as const;

const NETWORK_FAILURE = [
  /NSURLErrorDomain/,
  /network connection was lost/i,
  /The request timed out/i,
  /CloudKit's response is inconsistent/,
];

/** A stapler failure caused by the lookup's connection, not by the ticket. */
export function isTransientStaplerFailure(text: string): boolean {
  return NETWORK_FAILURE.some((pattern) => pattern.test(text));
}

function output(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8").trim();
}

const realDeps: StaplerDeps = {
  spawn(cmd) {
    const result = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
    return { exitCode: result.exitCode, stdout: output(result.stdout), stderr: output(result.stderr) };
  },
  sleep: (ms) => Bun.sleepSync(ms),
  log: (line) => console.error(line),
};

/** Run `xcrun stapler <action> <app>`, retrying a lookup that lost its connection. */
function stapler(action: "staple" | "validate", app: string, xcrun: string, deps: StaplerDeps): string {
  const cmd = [xcrun, "stapler", action, app];
  for (let attempt = 0; ; attempt++) {
    const result = deps.spawn(cmd);
    const text = [result.stdout, result.stderr].filter(Boolean).join("\n");
    if (result.exitCode === 0) return text;
    const delay = STAPLER_RETRY_DELAYS_MS[attempt];
    if (delay === undefined || !isTransientStaplerFailure(text)) {
      throw new Error(`${cmd.join(" ")} failed${text ? `: ${text}` : ""}`);
    }
    deps.log(`stapler ${action} lost its connection to Apple's ticket service; retrying in ${delay / 1000}s (attempt ${attempt + 2} of ${STAPLER_RETRY_DELAYS_MS.length + 1})`);
    deps.sleep(delay);
  }
}

/**
 * Validate the ticket stapled to `app`, retrying a dropped lookup. Returns
 * stapler's output; throws with it when the ticket is bad or every attempt
 * lost its connection.
 */
export function validateStapled(app: string, xcrun = "/usr/bin/xcrun", deps: StaplerDeps = realDeps): string {
  return stapler("validate", app, xcrun, deps);
}

/**
 * Staple a notarized app's ticket to it, retrying a dropped download. The
 * ticket comes from the same CloudKit service validation asks.
 */
export function stapleTicket(app: string, xcrun = "/usr/bin/xcrun", deps: StaplerDeps = realDeps): string {
  return stapler("staple", app, xcrun, deps);
}
