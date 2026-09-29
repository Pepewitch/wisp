/**
 * The public installer's download path, which the container contract
 * (`test:install`) never reaches: it installs from WISP_ARTIFACT_PATH.
 *
 * Each case runs the real script under `sh` with a fake `curl` and `uname` on
 * PATH and a throwaway HOME, so nothing is downloaded or installed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALLER = readFileSync(new URL("../scripts/install.sh", import.meta.url), "utf8");
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A fake-bin sandbox. `curl` records its arguments and fails, like an unreachable host. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "wisp-install-script-"));
  roots.push(root);
  const bin = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(bin);
  mkdirSync(home);
  const tool = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  tool("uname", 'case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) echo Linux ;; esac');
  tool("curl", `printf '%s\\n' "$*" >> "${join(root, "curl.log")}"\nexit 7`);
  const run = (script: string, env: Record<string, string> = {}) => {
    writeFileSync(join(root, "install.sh"), script);
    return Bun.spawnSync({
      cmd: ["/bin/sh", join(root, "install.sh"), "--no-service"],
      env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
  };
  const curlCalls = () => (existsSync(join(root, "curl.log")) ? readFileSync(join(root, "curl.log"), "utf8").trim().split("\n") : []);
  return { run, curlCalls, home };
}

describe("the public installer", () => {
  test("downloads over https only, redirects included, and fails on a short transfer", () => {
    const box = sandbox();
    const result = box.run(INSTALLER);
    expect(result.exitCode).not.toBe(0);
    const [call] = box.curlCalls();
    expect(call).toContain("--proto =https --proto-redir =https --tlsv1.2 --fail");
    expect(call).toContain("https://github.com/Pepewitch/wisp/releases/download/");
    expect(readdirSync(box.home)).toEqual([]);
  });

  test("refuses a release URL that is not https before fetching anything", () => {
    const box = sandbox();
    const result = box.run(INSTALLER, { WISP_RELEASE_BASE_URL: "http://mirror.example.invalid/wisp" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("WISP_RELEASE_BASE_URL must be an https:// URL");
    expect(box.curlCalls()).toEqual([]);
  });

  test("accepts an https release URL whatever the scheme's case", () => {
    const box = sandbox();
    const result = box.run(INSTALLER, { WISP_RELEASE_BASE_URL: "HTTPS://mirror.example.invalid/wisp" });
    expect(result.stderr.toString()).not.toContain("must be an https:// URL");
    const [call] = box.curlCalls();
    expect(call).toContain("HTTPS://mirror.example.invalid/wisp/");
    expect(call).toContain("--proto =https");
  });

  // `curl … | sh` executes whatever arrived. A connection that drops mid-script
  // must leave a prefix that does nothing, rather than one that downloads,
  // creates directories, or replaces the command link.
  test("a download cut short at any line runs nothing", () => {
    const lines = INSTALLER.split("\n");
    const lastLine = lines.findLastIndex((line) => line.trim() !== "");
    expect(lines[lastLine]).toBe('main "$@"');
    for (let cut = 1; cut < lastLine; cut++) {
      const box = sandbox();
      box.run(`${lines.slice(0, cut).join("\n")}\n`);
      expect({ cut, calls: box.curlCalls(), home: readdirSync(box.home) }).toEqual({ cut, calls: [], home: [] });
    }
  });
});
