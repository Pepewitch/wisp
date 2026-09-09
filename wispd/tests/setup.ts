// Preloaded before any test file: isolate all wisp state (db, logs, worktrees)
// into a throwaway home so tests never touch ~/.wisp.
//
// WISP_HOME alone is NOT isolation. A prior review ran this suite on an
// authenticated machine and watched it launch the operator's real Claude and
// Droid CLIs, execute this checkout's `.wisp/setup.sh`, commit on a fixture
// branch, and leave a child process behind — all from fixtures that only
// asserted `201 Created` on an asynchronous launch. Two ambient facts did
// that: fixture repositories are bare temporary directories, so git happily
// discovered a PARENT repository above them, and nothing stopped a builtin
// adapter from resolving a real harness out of PATH.
//
// Both are closed here, for every test file, before any of them import the
// daemon:
//   * git may not look above the temporary root for a repository, so an
//     "empty" fixture directory can never turn into a worktree of a real
//     checkout;
//   * only executables inside the temporary root may run as a harness, and
//     repository hooks may only run inside it, so a test that reaches for an
//     installed provider CLI gets a named refusal instead of a bill.
//
// Real-provider qualification is a separate, explicit act on a disposable
// host: run the suite with WISP_LAUNCH_POLICY=allow, which this file honors
// rather than overwrites.
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LAUNCH_POLICY_ENV } from "../src/launch-policy";

const TMP_ROOT = tmpdir();
/** macOS hands out /var/folders/… paths that are really /private/var/folders/…; both spellings have to be listed. */
const TMP_ROOTS = [...new Set([TMP_ROOT, realpathSync(TMP_ROOT)])];

process.env.WISP_HOME = mkdtempSync(join(TMP_ROOT, "wisp-test-"));
// Server fixtures share this identity regardless of Bun's test-file order.
writeFileSync(
  join(process.env.WISP_HOME, "instance-id"),
  "123e4567-e89b-42d3-a456-426614174000\n",
  { mode: 0o600 },
);

// Stop git's upward repository discovery at the temporary root. Deliberately
// additive: a caller that already set a ceiling (a contributor whose TMPDIR
// lives inside a checkout) keeps theirs.
process.env.GIT_CEILING_DIRECTORIES = [...TMP_ROOTS, process.env.GIT_CEILING_DIRECTORIES]
  .filter((entry) => entry !== undefined && entry !== "")
  .join(":");

/**
 * The generic stand-ins existing fixtures actually use AS a fake harness: an
 * adapter whose `bin` is `bash` with `["-c", "<script the test wrote>"]`, or
 * `true` for "a harness that exits 0 immediately". Interpreters and nothing
 * else — `claude`, `droid`, `codex`, and `cursor` are deliberately absent and
 * stay refused.
 *
 * Kept to the shortest list that passes: a review pointed out that `env` in
 * particular was a hole rather than a stand-in, because the policy judges
 * `cmd[0]` and `env claude …` resolves to `env`. `cat`, `printf`, `echo`, and
 * `sleep` were never spawned as a harness either — the fixtures call them
 * INSIDE a bash script, where they are children of a permitted launch rather
 * than launches themselves. Add one back only with a fixture that needs it.
 */
const HARNESS_STAND_INS = ["bash", "sh", "true", "false"];

if ((process.env[LAUNCH_POLICY_ENV] ?? "") === "") {
  process.env[LAUNCH_POLICY_ENV] = `fixtures:${TMP_ROOTS.join(":")};shims:${HARNESS_STAND_INS.join(",")}`;
} else if (process.env[LAUNCH_POLICY_ENV] === "allow") {
  console.warn(
    `[wisp tests] ${LAUNCH_POLICY_ENV}=allow — real harnesses and repository hooks CAN run. Only do this on a disposable host with disposable credentials.`,
  );
}

// Unit tests also exercise store operations without a listening daemon. Make
// that fixture initialization explicit, after isolation, under the real lock.
// The fixture connection remains shared; daemon ownership tests take their own
// lock and subprocess tests exercise production startup without this preload.
const { acquireHomeOwnership } = await import("../src/home-lock");
const { initializeStore } = await import("../src/store");
const fixtureOwnership = acquireHomeOwnership();
try { initializeStore(); } finally { fixtureOwnership.release(); }
