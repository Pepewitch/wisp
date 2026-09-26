import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("the activation fixture waits for the daemon before launching the CLI", () => {
  const script = readFileSync(new URL("../wispd/scripts/test-activation.sh", import.meta.url), "utf8");
  const readiness = script.indexOf(": <> /dev/tcp/127.0.0.1/8710");
  const registration = script.indexOf("wisp project add /workspace/repo");

  expect(script).toContain('"$IMAGE" /bin/bash -euo pipefail -c');
  expect(script).toContain('while [ "$ATTEMPT" -lt 300 ]');
  expect(readiness).toBeGreaterThan(-1);
  expect(registration).toBeGreaterThan(readiness);
  expect(script.slice(readiness, registration)).not.toContain("wisp project add");
  expect(script).toContain("activation daemon did not listen after $ATTEMPT attempts");
  expect(script.match(/cgroup_diagnostics/g)).toHaveLength(6);
});

test("the activation fixture enforces a memory budget after the daemon is ready", () => {
  const script = readFileSync(new URL("../wispd/scripts/test-activation.sh", import.meta.url), "utf8");
  const doctor = script.indexOf('wisp doctor --harness droid >"$HOME/doctor.log"');
  const budget = script.indexOf('[ "$PEAK_MIB" -le "$MEMORY_BUDGET_MIB" ]');

  expect(script).toContain("--memory=1536m");
  expect(script).toMatch(/MEMORY_BUDGET_MIB=\d+/);
  expect(doctor).toBeGreaterThan(-1);
  expect(budget).toBeGreaterThan(doctor);
  expect(script).toContain("activation exceeded its memory budget");
});

test("the activation fixture fails instead of skipping a budget it cannot measure", () => {
  const script = readFileSync(new URL("../wispd/scripts/test-activation.sh", import.meta.url), "utf8");
  const refusal = script.indexOf("test -r /sys/fs/cgroup/memory.peak || {");
  const install = script.indexOf("/bin/sh /install.sh");

  expect(refusal).toBeGreaterThan(-1);
  expect(refusal).toBeLessThan(install);
  expect(script).toContain("/sys/fs/cgroup/memory.peak is unreadable");
  expect(script).not.toMatch(/if test -r \/sys\/fs\/cgroup\/memory\.peak/);
});

test("the exact main candidate must pass artifact and verifier contracts before publication", () => {
  const candidate = readFileSync(new URL("../.github/workflows/release-candidate.yml", import.meta.url), "utf8");
  const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const push = candidate.slice(candidate.indexOf("push:"), candidate.indexOf("pull_request:"));

  expect(push).toContain("branches: [main]");
  expect(push).not.toContain("paths:");
  expect(candidate).toContain("github.event.pull_request.number || github.sha");
  expect(candidate).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  expect(candidate).toContain("bun run wispd/scripts/release-linux.ts");
  expect(candidate).toContain("bun run test:install");
  expect(candidate).toContain("bun run test:activation");
  expect(candidate).toContain("name: validate the standalone updater verifier");
  expect(candidate).toContain("cargo clippy --locked --manifest-path scripts/update-verifier/Cargo.toml");
  expect(candidate).not.toContain("--require-tag");
  expect(release).toContain("require the exact commit's release candidate");
  expect(release).toContain("for check_name in linux-contract update-verifier");
  expect(release.indexOf("completed:success")).toBeLessThan(release.indexOf("scan history with Gitleaks"));
});
