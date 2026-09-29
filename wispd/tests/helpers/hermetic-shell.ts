import { afterAll, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Terminal tests spawn real shells. Left to production's choice they run the
 * account's login shell, often an interactive zsh, with the contributor's
 * own dotfiles: hundreds of milliseconds per spawn instead of a few, and
 * behavior that differs by machine. These tests run a POSIX `sh` instead,
 * handed to the daemon through the same `terminalShell` setting a user has.
 * How production picks a shell is covered by `resolveLoginShell`'s own tests.
 */
export const HERMETIC_SHELL = "/bin/sh";

/**
 * Give this test file's shells a HOME with no startup files in it, and put the
 * real one back afterwards. A terminal inherits the daemon's environment, so
 * this is the same seam a service manager's environment would be.
 */
export function useHermeticHome(): void {
  const saved = process.env.HOME;
  beforeAll(() => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "wisp-terminal-home-"));
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  });
}
