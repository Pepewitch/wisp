import { describe, expect, test } from "bun:test";

import { isTransientStaplerFailure, STAPLER_RETRY_DELAYS_MS, validateStapled, type StaplerDeps } from "../scripts/stapler";

// Shapes stapler printed on the 0.7.2 release runner, trimmed.
const DROPPED = `Processing: /tmp/Wisp Daemon.app
error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost." UserInfo={NSErrorFailingURLKey=https://api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup}
CloudKit's response is inconsistent with expections: (null)
The validate action failed! Error 68.`;
const NO_TICKET = `Processing: /tmp/Wisp Daemon.app
Wisp Daemon.app does not have a ticket stapled to it.`;
const VALID = `Processing: /tmp/Wisp Daemon.app
The validate action worked!`;

function scripted(results: { exitCode: number; stderr: string }[]) {
  const calls: string[][] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const deps: StaplerDeps = {
    spawn(cmd) {
      calls.push(cmd);
      const next = results.shift();
      if (!next) throw new Error("stapler ran more often than scripted");
      return { exitCode: next.exitCode, stdout: "", stderr: next.stderr };
    },
    sleep: (ms) => void sleeps.push(ms),
    log: (line) => void logs.push(line),
  };
  return { deps, calls, sleeps, logs };
}

describe("stapler validate", () => {
  test("a dropped ticket lookup is a network failure; a missing ticket is not", () => {
    expect(isTransientStaplerFailure(DROPPED)).toBe(true);
    expect(isTransientStaplerFailure(NO_TICKET)).toBe(false);
  });

  test("passes through after dropped lookups, waiting between attempts", () => {
    const run = scripted([
      { exitCode: 65, stderr: DROPPED },
      { exitCode: 65, stderr: DROPPED },
      { exitCode: 0, stderr: VALID },
    ]);
    expect(validateStapled("/tmp/Wisp Daemon.app", "/usr/bin/xcrun", run.deps)).toContain("worked");
    expect(run.calls).toHaveLength(3);
    expect(run.calls[0]).toEqual(["/usr/bin/xcrun", "stapler", "validate", "/tmp/Wisp Daemon.app"]);
    expect(run.sleeps).toEqual([STAPLER_RETRY_DELAYS_MS[0], STAPLER_RETRY_DELAYS_MS[1]]);
    expect(run.logs).toHaveLength(2);
  });

  test("a ticket problem fails at once, without retrying", () => {
    const run = scripted([{ exitCode: 65, stderr: NO_TICKET }]);
    expect(() => validateStapled("/tmp/Wisp Daemon.app", "/usr/bin/xcrun", run.deps)).toThrow("does not have a ticket");
    expect(run.calls).toHaveLength(1);
    expect(run.sleeps).toEqual([]);
  });

  test("gives up after every attempt lost its connection, naming the last failure", () => {
    const attempts = STAPLER_RETRY_DELAYS_MS.length + 1;
    const run = scripted(Array.from({ length: attempts }, () => ({ exitCode: 65, stderr: DROPPED })));
    expect(() => validateStapled("/tmp/Wisp Daemon.app", "xcrun", run.deps)).toThrow("Error 68");
    expect(run.calls).toHaveLength(attempts);
    expect(run.sleeps).toEqual([...STAPLER_RETRY_DELAYS_MS]);
  });
});
