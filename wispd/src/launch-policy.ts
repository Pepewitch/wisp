/**
 * The gate every provider CLI and every repository hook passes through.
 *
 * Production runs with no policy: the daemon's whole job is launching the
 * harness a user installed and the setup script their repo committed. The
 * policy exists for the OTHER caller — a test process. An ordinary API test
 * that creates a task with a builtin adapter used to reach the real `claude`
 * or `droid` binary on the contributor's machine, spend their provider quota,
 * run the checkout's `.wisp/setup.sh`, and leave a child process behind (a
 * prior review). Asserting HTTP 201 says nothing about what the asynchronous
 * launch then did.
 *
 * So the default test environment fails CLOSED here (see `tests/setup.ts`):
 * a harness executable must live inside the fixture tree or be one of the
 * generic stand-ins the suite names explicitly (`bash -c "…"`, `true`), and
 * repository hooks may only run inside a fixture working directory. A test
 * that wants a harness supplies a fake one; a test that reaches for the real
 * thing gets a named error instead of a provider bill.
 *
 * What this is NOT: a sandbox. A permitted executable can do anything the
 * daemon user can, and the terminal's shells are deliberately not gated (a
 * PTY test spawns the operator's real shell). This bounds the blast radius of
 * an unhermetic TEST, and nothing more.
 */
import { realpathSync } from "node:fs";
import { basename, isAbsolute, resolve, sep } from "node:path";

/**
 * The env var that selects the policy; unset means production's `allow`.
 *
 * Grammar — `allow`, `block`, or semicolon-separated clauses:
 *   `fixtures:<absolute path>[:<absolute path>…]`
 *       executables that resolve inside one of these trees may run, and
 *       repository hooks may run with a working directory inside one.
 *   `shims:<name>[,<name>…]`
 *       generic stand-ins the suite uses AS a fake harness — `bash -c "…"`,
 *       `true`, and friends. Matched on the basename of both the spelling and
 *       the resolved file, so a symlink named `bash` pointing at an installed
 *       provider CLI is still refused. Never name a real harness here: the
 *       whole point is that `claude` and `droid` cannot run.
 */
export const LAUNCH_POLICY_ENV = "WISP_LAUNCH_POLICY";

const FIXTURES_PREFIX = "fixtures:";
const SHIMS_PREFIX = "shims:";

/**
 * A launch the active policy refused. Named so callers can tell a refusal
 * from a missing binary or a crashed child: the runner turns it into a failed
 * turn with this sentence, and the launch-policy tests assert on it.
 */
export class LaunchBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchBlocked";
  }
}

interface Policy {
  /** fixture trees whose executables and hooks may run */
  roots: string[];
  /** generic stand-in binaries a fixture may use AS a harness */
  shims: Set<string>;
}

/**
 * The active policy, or "allow" when nothing is gated. Read from the
 * environment on EVERY call rather than cached at import: a test suite sets
 * the policy in a preload and individual cases narrow it, and a cached value
 * would silently apply the first case's policy to all the others.
 */
function policy(): Policy | "allow" {
  const raw = (process.env[LAUNCH_POLICY_ENV] ?? "allow").trim();
  if (raw === "" || raw === "allow") return "allow";
  if (raw === "block") return { roots: [], shims: new Set() };
  const parsed: Policy = { roots: [], shims: new Set() };
  for (const clause of raw.split(";").map((part) => part.trim()).filter((part) => part !== "")) {
    if (clause.startsWith(FIXTURES_PREFIX)) {
      for (const root of clause.slice(FIXTURES_PREFIX.length).split(":").map((part) => part.trim())) {
        if (root === "") continue;
        if (!isAbsolute(root)) {
          throw new LaunchBlocked(`${LAUNCH_POLICY_ENV} root ${JSON.stringify(root)} must be an absolute path`);
        }
        parsed.roots.push(root);
      }
      continue;
    }
    if (clause.startsWith(SHIMS_PREFIX)) {
      for (const name of clause.slice(SHIMS_PREFIX.length).split(",").map((part) => part.trim())) {
        if (name !== "") parsed.shims.add(name);
      }
      continue;
    }
    throw new LaunchBlocked(
      `${LAUNCH_POLICY_ENV}=${JSON.stringify(raw)} is not a policy — use "allow", "block", or "fixtures:<absolute path>[…][;shims:<name>[,<name>]]"`,
    );
  }
  return parsed;
}

/**
 * The real path of `target`, following symlinks and resolving `..`, or null
 * when it does not exist. Both sides of the containment test go through this:
 * macOS hands out `/var/folders/…` temporary directories that are really
 * `/private/var/folders/…`, so a raw prefix compare between a resolved
 * executable and an unresolved root would reject every legitimate fixture.
 * It also closes the obvious escapes — a `..` path and a symlink inside the
 * fixture tree pointing at the operator's real harness both resolve out.
 */
function realOrNull(target: string): string | null {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function containedBy(path: string, roots: string[]): boolean {
  const real = realOrNull(path);
  if (real === null) return false;
  for (const root of roots) {
    const realRoot = realOrNull(root);
    if (realRoot !== null && within(real, realRoot)) return true;
  }
  return false;
}

/**
 * Where `cmd[0]` actually lives. A bare name is resolved the way the spawn
 * itself would resolve it (PATH), because "did this launch the operator's
 * installed harness?" is a question about the resolved file, not the spelling
 * in the argv. Returns null when nothing resolves — a launch that was going
 * to fail anyway, which the policy reports as a refusal rather than letting
 * an unresolvable name look permitted.
 */
function resolveExecutable(exe: string, cwd?: string): string | null {
  if (exe.includes("/")) return realOrNull(resolve(cwd ?? process.cwd(), exe));
  const found = Bun.which(exe);
  return found === null ? null : realOrNull(found);
}

/**
 * Gate a provider/harness executable. `what` names the caller in the error —
 * the sentence lands in a task's state detail, so it has to say which launch
 * was refused and where the policy came from.
 */
export function assertExecutableAllowed(cmd: readonly string[], what: string, cwd?: string): void {
  const active = policy();
  if (active === "allow") return;
  const exe = cmd[0] ?? "";
  const resolved = resolveExecutable(exe, cwd);
  if (resolved !== null) {
    if (containedBy(resolved, active.roots)) return;
    // A generic stand-in, allowed by name. Both spellings must agree, so a
    // symlink called `bash` cannot smuggle in an installed harness.
    if (active.shims.has(basename(exe)) && active.shims.has(basename(resolved))) return;
  }
  throw new LaunchBlocked(
    `${what}: ${LAUNCH_POLICY_ENV} refused ${JSON.stringify(exe)}${resolved === null ? " (not found)" : ` (${resolved})`} — only executables inside ${active.roots.length === 0 ? "nothing" : active.roots.join(", ")}${active.shims.size === 0 ? "" : ` (or the stand-ins ${[...active.shims].join(", ")})`} may run`,
  );
}

/**
 * Gate a repository hook (`.wisp/setup.sh`, a project's configured setup or
 * archive script). The check is on the working directory, not the executable:
 * every hook runs through `bash`, which lives outside any fixture tree, while
 * what actually matters is whose repository code is about to execute. A
 * fixture worktree is fine; the contributor's real checkout is not.
 */
export function assertWorkingDirectoryAllowed(cwd: string, what: string): void {
  const active = policy();
  if (active === "allow") return;
  if (containedBy(cwd, active.roots)) return;
  throw new LaunchBlocked(
    `${what}: ${LAUNCH_POLICY_ENV} refused a hook in ${JSON.stringify(cwd)} — repository hooks may only run inside ${active.roots.length === 0 ? "nothing" : active.roots.join(", ")}`,
  );
}

/** Whether a policy is in force at all — for the one-line boot warning. */
export function launchPolicyDescription(): string | null {
  const raw = (process.env[LAUNCH_POLICY_ENV] ?? "").trim();
  return raw === "" || raw === "allow" ? null : raw;
}
