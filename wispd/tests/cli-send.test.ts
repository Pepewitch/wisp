import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli-args";
import { agentOfferError, sendAgentFields, sendCommand } from "../src/cli-send";

const HARNESSES = [
  { name: "codex", models: ["gpt-6.1-sol", "gpt-6-astra"], effortLevels: ["low", "medium", "high"] },
  { name: "claude", models: ["claude-opus-5-5", "claude-sonnet-5-5"], effortLevels: ["low", "high"] },
  { name: "cursor", models: [], effortLevels: [] },
];

describe("wisp send agent flags", () => {
  test("map onto the API's own fields", () => {
    const { flags } = parseArgs(["t1", "continue", "--model", "gpt-6-astra", "--effort", "high", "--when", "next-turn"]);
    expect(sendAgentFields(flags)).toEqual({ model: "gpt-6-astra", effort: "high", when: "next-turn" });
    const harness = parseArgs(["t1", "go", "--harness", "claude", "--model", "claude-opus-5-5", "--fresh-context"]).flags;
    expect(sendAgentFields(harness)).toEqual({ harness: "claude", model: "claude-opus-5-5", startFreshContext: true });
    expect(sendAgentFields(parseArgs(["t1", "go"]).flags)).toEqual({});
  });

  test("a malformed flag is refused before anything is sent", () => {
    expect(sendAgentFields(parseArgs(["t1", "go", "--when", "later"]).flags)).toBe("--when must be now or next-turn");
    expect(sendAgentFields(parseArgs(["t1", "go", "--model"]).flags)).toBe("--model requires a value");
  });

  test("a model or effort the target harness does not offer is named, with what it does offer", () => {
    expect(agentOfferError({ model: "gpt-6-astra" }, "codex", HARNESSES)).toBeNull();
    expect(agentOfferError({ model: "gpt-5" }, "codex", HARNESSES)).toBe(
      "codex does not offer model gpt-5 (offered: gpt-6.1-sol, gpt-6-astra; a hidden model must be shown again first)",
    );
    expect(agentOfferError({ effort: "max" }, "codex", HARNESSES)).toBe("codex has no effort level max (levels: low, medium, high)");
    // a harness switch is checked against the new harness's list
    expect(agentOfferError({ harness: "claude", model: "gpt-6-astra" }, "codex", HARNESSES)).toMatch(/^claude does not offer/);
    // a list not known yet, and an unknown harness, are left to the daemon
    expect(agentOfferError({ model: "anything" }, "cursor", HARNESSES)).toBeNull();
    expect(agentOfferError({ model: "anything" }, "nope", HARNESSES)).toBeNull();
  });

  test("sends the switch with the message and says what the next turn runs on", async () => {
    const requests: { path: string; method: string; body: unknown }[] = [];
    const printed: string[] = [];
    const log = console.log;
    console.log = (line: string) => printed.push(line);
    try {
      await sendCommand({
        positional: ["t1", "continue", "please"],
        attachmentFlags: parseArgs(["--model", "gpt-6-astra", "--when", "next-turn"]).flags,
        commandName: "wisp",
        readAttachments: async () => undefined,
        discardAttachment: async () => undefined,
        requestError: (error) => {
          throw error;
        },
        request: async (path, method, body) => {
          requests.push({ path, method, body });
          if (path === "/api/tasks/t1") return { harness: "codex" };
          if (path === "/api/harnesses") return { harnesses: HARNESSES };
          return {
            id: "t1", harness: "codex", model: "gpt-6-astra", effort: null, turn_count: 3,
            disposition: "queued-next", message: { id: "m1", delivery_uncertain: false, turn_n: null },
          };
        },
      });
    } finally {
      console.log = log;
    }
    const send = requests.find((r) => r.method === "POST")!;
    expect(send.path).toBe("/api/tasks/t1/send");
    expect(send.body).toMatchObject({ message: "continue please", model: "gpt-6-astra", when: "next-turn" });
    expect(printed).toEqual(["t1 message m1 queued for the next turn", "t1 runs on codex gpt-6-astra from that turn"]);
  });
});
