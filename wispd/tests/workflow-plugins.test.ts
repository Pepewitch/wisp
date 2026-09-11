import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePlugin, installedWorkflows, validateDecision } from "../src/workflows/plugins";

function manifest() {
  return {
    protocol: 1, id: "sample-watch", name: "Sample watch", version: "1", description: "A synthetic watcher.",
    command: ["/bin/sh", "-c", "cat >/dev/null; printf '%s' '{\"action\":\"wait\",\"reason\":\"Still waiting\",\"checkpoint\":{}}'"],
    parameters: [{ key: "target", label: "Target", type: "string", default: "", required: true, description: "What to watch" }],
  };
}
test("local manifests expose parameter schemas, protect built-ins, and pin effective versions", () => {
  const dir = mkdtempSync(join(tmpdir(), "wisp-workflow-plugin-"));
  const path = join(dir, "workflows.json"), plugin = manifest();
  writeFileSync(path, JSON.stringify([plugin]));
  const types = installedWorkflows(path);
  expect(types).toHaveLength(4);
  expect(types[3]?.definition.parameters.some(p => p.key === "maxWakeups")).toBe(true);
  const version = types[3]!.definition.version;
  writeFileSync(path, JSON.stringify([{ ...plugin, description: "Updated" }]));
  expect(installedWorkflows(path)[3]!.definition.version).not.toBe(version);
  writeFileSync(path, JSON.stringify([{ ...plugin, id: "heartbeat" }]));
  expect(() => installedWorkflows(path)).toThrow();
  writeFileSync(path, JSON.stringify([{ ...plugin, command: ["relative-executable"] }]));
  expect(() => installedWorkflows(path)).toThrow();
  writeFileSync(path, JSON.stringify([{ ...plugin, parameters: [{ ...plugin.parameters[0], key: "maxWakeups" }] }]));
  expect(() => installedWorkflows(path)).toThrow();
});

test("executable protocol reads stdin, validates stdout, and handles failures without agent work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wisp-workflow-protocol-"));
  const path = join(dir, "workflows.json");
  writeFileSync(path, JSON.stringify([manifest()]));
  const plugin = installedWorkflows(path)[3]!;
  expect((await evaluatePlugin(plugin, { protocol: 1, checkpoint: {} }, dir, new AbortController().signal)).action).toBe("wait");
  await expect(evaluatePlugin({ ...plugin, command: ["/bin/sh", "-c", "printf 'not json'"] }, {}, dir, new AbortController().signal)).rejects.toThrow();
  await expect(evaluatePlugin({ ...plugin, command: ["/bin/sh", "-c", "exit 1"] }, {}, dir, new AbortController().signal)).rejects.toThrow("Plugin check failed");
  const controller = new AbortController();
  const aborted = evaluatePlugin({ ...plugin, command: ["/bin/sh", "-c", "sleep 60"] }, {}, dir, controller.signal);
  controller.abort();
  await expect(aborted).rejects.toThrow("Plugin check failed");
});

test("malformed and oversized results are refused", () => {
  expect(() => validateDecision({ action: "wake", reason: "New evidence", checkpoint: {}, key: "same", message: "Check it" })).not.toThrow();
  for (const value of [
    null, [], { action: "unknown" },
    { action: "wake", reason: "New evidence", checkpoint: {}, key: "same" },
    { action: "wait", reason: "Wait", checkpoint: { data: "字".repeat(30_000) } },
  ]) expect(() => validateDecision(value)).toThrow();
});
