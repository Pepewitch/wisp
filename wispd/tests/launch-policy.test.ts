/**
 * The guard that keeps this suite hermetic, tested as its own subject.
 *
 * These cases are deliberately adversarial: every one of them is an attempt to
 * get a real executable or a real repository's hook to run from inside a test,
 * because that is exactly what happened before the policy existed (a prior
 * review: real provider CLIs, this checkout's `.wisp/setup.sh`, a
 * harness-generated commit, and a surviving child process, all from fixtures
 * that only asserted a 201).
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BUILTIN_ADAPTERS } from "../src/adapters";
import {
  assertExecutableAllowed,
  assertWorkingDirectoryAllowed,
  LAUNCH_POLICY_ENV,
  LaunchBlocked,
  launchPolicyDescription,
} from "../src/launch-policy";

/** Run `fn` under an explicit policy, then restore whatever the preload set. */
function withPolicy<T>(policy: string, fn: () => T): T {
  const previous = process.env[LAUNCH_POLICY_ENV];
  process.env[LAUNCH_POLICY_ENV] = policy;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[LAUNCH_POLICY_ENV];
    else process.env[LAUNCH_POLICY_ENV] = previous;
  }
}

function fixtureExecutable(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

describe("the default test environment fails closed on real launches", () => {
  test("the preload installed a fixtures-only policy", () => {
    expect(launchPolicyDescription()).toStartWith("fixtures:");
  });

  /**
   * The stand-ins the suite allows must stay generic AND minimal. `env` used
   * to be on this list, which was a hole rather than a stand-in: the policy
   * judges `cmd[0]`, so `env claude …` resolves to `env` and would have been
   * permitted (a review caught it).
   */
  test("the stand-in list is interpreters only — no harness, no argv wrapper", () => {
    const policy = launchPolicyDescription() ?? "";
    const shims = /;shims:([^;]*)/.exec(policy)?.[1]?.split(",") ?? [];
    for (const def of Object.values(BUILTIN_ADAPTERS)) expect(shims).not.toContain(def.bin);
    for (const wrapper of ["env", "xargs", "nice", "timeout", "sudo", "nohup"]) {
      expect(shims).not.toContain(wrapper);
    }
    expect(shims.every((shim) => ["bash", "sh", "true", "false"].includes(shim))).toBe(true);
  });

  /**
   * The exact escape the review reproduced: an ordinary create request with a
   * builtin adapter. Whether or not this machine has the CLI installed, the
   * policy must refuse to run it.
   */
  test("every builtin harness command is refused", () => {
    for (const [id, def] of Object.entries(BUILTIN_ADAPTERS)) {
      expect(() => assertExecutableAllowed([def.bin], `builtin ${id}`)).toThrow(LaunchBlocked);
    }
  });

  /**
   * The OTHER ambient fact from the ENG-12 incident, which had no test: a bare
   * temporary fixture directory was discovered as part of THIS checkout, so
   * "an empty directory" became a worktree of the real project and its
   * `.wisp/setup.sh` ran. `GIT_CEILING_DIRECTORIES` is what stops the upward
   * walk; this asserts the walk actually stops.
   */
  test("git cannot discover a repository above a bare temp fixture", () => {
    const fixture = mkdtempSync(join(tmpdir(), "wisp-ceiling-"));
    const probe = Bun.spawnSync({
      cmd: ["git", "rev-parse", "--show-toplevel"],
      cwd: fixture,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(process.env.GIT_CEILING_DIRECTORIES ?? "").not.toBe("");
    expect(probe.exitCode).not.toBe(0);
    expect(probe.stdout.toString()).not.toContain("wisp");
    expect(probe.stderr.toString()).toContain("not a git repository");
  });

  test("the checkout's own repository hooks are refused", () => {
    expect(() => assertWorkingDirectoryAllowed(join(import.meta.dir, ".."), "repo hook")).toThrow(LaunchBlocked);
  });
});

describe("fixtures-only launch policy", () => {
  test("an executable inside the fixture tree runs, one outside does not", () => {
    const root = mkdtempSync(join(tmpdir(), "wisp-launch-root-"));
    const outside = mkdtempSync(join(tmpdir(), "wisp-launch-outside-"));
    const inside = fixtureExecutable(root, "fake-harness");
    const elsewhere = fixtureExecutable(outside, "fake-harness");

    withPolicy(`fixtures:${root}`, () => {
      expect(() => assertExecutableAllowed([inside, "--json"], "fixture harness")).not.toThrow();
      expect(() => assertExecutableAllowed([elsewhere], "stray harness")).toThrow(LaunchBlocked);
    });
  });

  test("a bare PATH name is resolved before it is judged", () => {
    const root = mkdtempSync(join(tmpdir(), "wisp-launch-path-"));
    withPolicy(`fixtures:${root}`, () => {
      // `sh` exists on every supported platform and is never inside a fixture
      expect(() => assertExecutableAllowed(["sh", "-c", "true"], "shell")).toThrow(LaunchBlocked);
    });
  });

  test("a named stand-in runs; a symlink wearing its name does not", () => {
    const root = mkdtempSync(join(tmpdir(), "wisp-launch-shim-"));
    const disguise = join(root, "bash");
    symlinkSync(Bun.which("git") ?? "/usr/bin/git", disguise);
    withPolicy(`fixtures:/nonexistent-root;shims:bash,true`, () => {
      expect(() => assertExecutableAllowed(["bash", "-c", "echo hi"], "fixture harness")).not.toThrow();
      expect(() => assertExecutableAllowed(["true"], "fixture harness")).not.toThrow();
      expect(() => assertExecutableAllowed([disguise, "-c", "echo hi"], "disguised harness")).toThrow(LaunchBlocked);
    });
  });

  test("a relative path cannot climb out of the fixture tree", () => {
    const root = mkdtempSync(join(tmpdir(), "wisp-launch-climb-"));
    const nested = join(root, "bin");
    mkdirSync(nested);
    fixtureExecutable(root, "fake-harness");
    withPolicy(`fixtures:${nested}`, () => {
      expect(() => assertExecutableAllowed(["../fake-harness"], "climbing harness", nested)).toThrow(LaunchBlocked);
    });
  });

  test("a symlink inside the fixture tree cannot point at a real binary", () => {
    const root = mkdtempSync(join(tmpdir(), "wisp-launch-symlink-"));
    const link = join(root, "claude");
    symlinkSync("/bin/sh", link);
    withPolicy(`fixtures:${root}`, () => {
      expect(() => assertExecutableAllowed([link], "symlinked harness")).toThrow(LaunchBlocked);
    });
  });

  test("an executable that does not exist is refused, not assumed harmless", () => {
    const root = mkdtempSync(join(tmpdir(), "wisp-launch-missing-"));
    withPolicy(`fixtures:${root}`, () => {
      expect(() => assertExecutableAllowed([join(root, "never-installed")], "absent harness")).toThrow(
        /not found/,
      );
    });
  });

  test("repository hooks are judged by their working directory", () => {
    const root = mkdtempSync(join(tmpdir(), "wisp-launch-hooks-"));
    const worktree = join(root, "worktrees", "t1");
    mkdirSync(worktree, { recursive: true });
    withPolicy(`fixtures:${root}`, () => {
      expect(() => assertWorkingDirectoryAllowed(worktree, "setup script")).not.toThrow();
      expect(() => assertWorkingDirectoryAllowed(join(import.meta.dir, ".."), "setup script")).toThrow(LaunchBlocked);
    });
  });

  test("the refusal names the launch, the policy, and the resolved path", () => {
    const root = mkdtempSync(join(tmpdir(), "wisp-launch-message-"));
    withPolicy(`fixtures:${root}`, () => {
      const error = (() => {
        try {
          assertExecutableAllowed(["sh"], "task t1 turn 3 harness 'claude'");
          return null;
        } catch (thrown) {
          return thrown as Error;
        }
      })();
      expect(error).not.toBeNull();
      expect(error!.message).toContain("task t1 turn 3 harness 'claude'");
      expect(error!.message).toContain(LAUNCH_POLICY_ENV);
      expect(error!.message).toContain(root);
    });
  });
});

describe("other policies", () => {
  test("allow is production: nothing is gated", () => {
    withPolicy("allow", () => {
      expect(() => assertExecutableAllowed(["sh"], "shell")).not.toThrow();
      expect(() => assertWorkingDirectoryAllowed(import.meta.dir, "hook")).not.toThrow();
      expect(launchPolicyDescription()).toBeNull();
    });
  });

  test("block refuses everything, including a fixture executable", () => {
    const root = mkdtempSync(join(tmpdir(), "wisp-launch-block-"));
    const inside = fixtureExecutable(root, "fake-harness");
    withPolicy("block", () => {
      expect(() => assertExecutableAllowed([inside], "fixture harness")).toThrow(LaunchBlocked);
      expect(() => assertWorkingDirectoryAllowed(root, "hook")).toThrow(LaunchBlocked);
    });
  });

  test("an unreadable policy is a refusal, never a silent allow", () => {
    withPolicy("nonsense", () => {
      expect(() => assertExecutableAllowed(["sh"], "shell")).toThrow(/is not a policy/);
    });
    withPolicy("fixtures:relative/path", () => {
      expect(() => assertExecutableAllowed(["sh"], "shell")).toThrow(/must be an absolute path/);
    });
  });
});
