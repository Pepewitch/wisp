import { describe, expect, test } from "bun:test";
import { canonicalBriefJson, TASK_BRIEF_LIMITS, validateTaskBrief } from "../../shared/task-brief";

const minimal = { version: 1, outcome: "The duplicate-save bug is fixed.", remaining: ["Verify it in a browser."] };

function fails(value: unknown): { field: string; message: string } {
  const check = validateTaskBrief(value);
  if (check.ok) throw new Error("expected the brief to be rejected");
  return { field: check.field, message: check.message };
}

const option = (label: string) => ({ label, gain: "g", downside: "d", impact: "Only editors.", effort: null });

describe("task brief v1 validation", () => {
  test("accepts the help's minimal example and keeps it unchanged", () => {
    const check = validateTaskBrief({ ...minimal, goal: "Prevent duplicate saves." });
    expect(check).toEqual({ ok: true, brief: { ...minimal, goal: "Prevent duplicate saves." } });
  });

  test("[] and null for remaining are different, and both are accepted", () => {
    expect(validateTaskBrief({ ...minimal, remaining: [] }).ok).toBe(true);
    expect(validateTaskBrief({ ...minimal, remaining: null }).ok).toBe(true);
    expect(fails({ version: 1, outcome: "x" }).field).toBe("remaining");
  });

  test("required fields, versions and unknown properties are named", () => {
    expect(fails({ outcome: "x", remaining: [] }).field).toBe("version");
    expect(fails({ ...minimal, version: 2 }).message).toContain("brief version 2");
    expect(fails({ version: 1, remaining: [] }).field).toBe("outcome");
    expect(fails({ ...minimal, confidence: 0.9 }).field).toBe("confidence");
    expect(fails({ ...minimal, decision: { ...validDecision(), extra: 1 } }).field).toBe("decision.extra");
    expect(fails([minimal]).message).toContain("an array");
  });

  test("blank strings are refused rather than stored as content", () => {
    expect(fails({ ...minimal, outcome: "   " }).field).toBe("outcome");
    expect(fails({ ...minimal, goal: "" }).field).toBe("goal");
    expect(fails({ ...minimal, remaining: ["ok", " \n"] }).field).toBe("remaining[1]");
    // null is the allowed way to say "nothing here"
    expect(validateTaskBrief({ ...minimal, goal: null, scopeChange: null, decision: null }).ok).toBe(true);
  });

  test("limits count code points, not UTF-16 units", () => {
    const emoji = "😀".repeat(TASK_BRIEF_LIMITS.goal);
    expect(validateTaskBrief({ ...minimal, goal: emoji }).ok).toBe(true);
    expect(fails({ ...minimal, goal: `${emoji}x` }).message).toBe(`must be at most ${TASK_BRIEF_LIMITS.goal} characters (got ${TASK_BRIEF_LIMITS.goal + 1})`);
    expect(fails({ ...minimal, outcome: "x".repeat(601) }).field).toBe("outcome");
    expect(fails({ ...minimal, scopeChange: "x".repeat(401) }).field).toBe("scopeChange");
    expect(fails({ ...minimal, remaining: ["a", "b", "c", "d", "e", "f"] }).message).toContain("group related items");
  });

  test("a decision needs 1–3 options, and a lone option explains its alternatives", () => {
    expect(validateTaskBrief({ ...minimal, decision: validDecision() }).ok).toBe(true);
    expect(fails({ ...minimal, decision: { ...validDecision(), options: [] } }).field).toBe("decision.options");
    expect(fails({ ...minimal, decision: { ...validDecision(), options: [1, 2, 3, 4].map((n) => option(`o${n}`)) } }).message)
      .toContain("1 to 3");
    expect(fails({ ...minimal, decision: { ...validDecision(), options: [option("only")] } }).field).toBe("decision.alternativesNote");
    expect(validateTaskBrief({
      ...minimal,
      decision: { ...validDecision(), options: [option("only")], alternativesNote: "Alternatives were not explored." },
    }).ok).toBe(true);
    const { recommendation: _r, ...noRecommendation } = validDecision();
    expect(fails({ ...minimal, decision: noRecommendation }).field).toBe("decision.recommendation");
    expect(fails({ ...minimal, decision: { ...validDecision(), options: [{ ...option("a"), effort: undefined }, option("b")] } }).field)
      .toBe("decision.options[0].effort");
    expect(fails({ ...minimal, decision: { ...validDecision(), unknowns: ["a", "b", "c", "d"] } }).field).toBe("decision.unknowns");
  });

  test("the serialized payload is capped at 12 KiB", () => {
    const wide = "界".repeat(240);
    const decision = { question: wide, recommendation: wide, options: [1, 2, 3].map(() => ({ label: wide, gain: wide, downside: wide, impact: wide, effort: wide })), unknowns: [wide, wide, wide] };
    const huge = { ...minimal, outcome: "界".repeat(600), goal: wide, scopeChange: "界".repeat(400), remaining: [wide, wide, wide, wide, wide], decision };
    expect(fails(huge).message).toContain(`limit is ${TASK_BRIEF_LIMITS.payloadBytes}`);
  });

  test("canonical JSON ignores property order and keeps array order", () => {
    expect(canonicalBriefJson({ remaining: ["a", "b"], outcome: "x", version: 1 }))
      .toBe(canonicalBriefJson({ version: 1, outcome: "x", remaining: ["a", "b"] }));
    expect(canonicalBriefJson({ remaining: ["b", "a"] })).not.toBe(canonicalBriefJson({ remaining: ["a", "b"] }));
  });
});

function validDecision() {
  return {
    question: "Where should the guard live?",
    recommendation: "In the store.",
    options: [option("In the store"), option("In the button")],
  };
}
