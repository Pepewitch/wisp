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
  expect(script.match(/cgroup_diagnostics/g)).toHaveLength(4);
});
