/**
 * `xcrun stapler validate` with retries for Apple's ticket service.
 *
 * Validating a stapled app looks its ticket up in Apple's CloudKit ticket
 * service (`api.apple-cloudkit.com/…/com.apple.gk.ticket-delivery`), and that
 * request drops now and then: NSURLErrorDomain -1005, "The network connection
 * was lost", reported by stapler as "Error 68". One release makes about five
 * of these lookups (the daemon app, its extracted archive, Desktop, and both
 * again at promotion), and 0.7.0, 0.7.1 and 0.7.2 each lost one, so a single
 * dropped request failed the whole signed job.
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

/**
 * Validate the ticket stapled to `app`, retrying a dropped lookup. Returns
 * stapler's output; throws with it when the ticket is bad or every attempt
 * lost its connection.
 */
export function validateStapled(app: string, xcrun = "/usr/bin/xcrun", deps: StaplerDeps = realDeps): string {
  const cmd = [xcrun, "stapler", "validate", app];
  for (let attempt = 0; ; attempt++) {
    const result = deps.spawn(cmd);
    const text = [result.stdout, result.stderr].filter(Boolean).join("\n");
    if (result.exitCode === 0) return text;
    const delay = STAPLER_RETRY_DELAYS_MS[attempt];
    if (delay === undefined || !isTransientStaplerFailure(text)) {
      throw new Error(`${cmd.join(" ")} failed${text ? `: ${text}` : ""}`);
    }
    deps.log(`stapler validate lost its connection to Apple's ticket service; retrying in ${delay / 1000}s (attempt ${attempt + 2} of ${STAPLER_RETRY_DELAYS_MS.length + 1})`);
    deps.sleep(delay);
  }
}
