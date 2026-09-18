import { describe, expect, test } from "bun:test";

import { BUILTIN_ADAPTERS } from "../src/adapters";
import type { WispConfig } from "../src/config";
import {
  resolveCreateAgentSettings,
  resolveSendAgent,
} from "../src/routes/task-agent-settings";
import type { Task } from "../src/types";

const cfg = { harnessDefaults: {} } as WispConfig;

describe("task service-tier settings", () => {
  test("Codex creation is Standard unless Fast is explicit", () => {
    expect(resolveCreateAgentSettings(cfg, "codex", BUILTIN_ADAPTERS.codex, "gpt-test", "high", undefined))
      .toMatchObject({ serviceTier: "default" });
    expect(resolveCreateAgentSettings(cfg, "codex", BUILTIN_ADAPTERS.codex, "gpt-test", "high", "priority"))
      .toMatchObject({ serviceTier: "priority" });
  });

  test("an omitted or null Codex tier cannot erase the Standard safety default", () => {
    const task = {
      harness: "codex",
      model: "gpt-test",
      effort: "high",
      service_tier: null,
    } as Task;
    expect(resolveSendAgent(task, {}, cfg, BUILTIN_ADAPTERS)).toMatchObject({ serviceTier: "default" });
    expect(resolveSendAgent(task, { serviceTier: null }, cfg, BUILTIN_ADAPTERS))
      .toMatchObject({ serviceTier: "default" });
  });
});
