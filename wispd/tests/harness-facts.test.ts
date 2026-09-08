/**
 * The committed harness facts, asserted against the adapters.
 *
 * This suite is what turns harness drift from "something the maintainer has to
 * notice" into a failing test. `bun run harness:snapshot` observes the
 * installed CLI; these assertions then fail exactly where an adapter no longer
 * agrees with what the CLI advertises.
 *
 * **Every list assertion is containment, never equality**, and each runs in the
 * direction where the failure actually hurts. Equality would also simply be
 * wrong: droid's effortLevels is a documented cross-model union, codex's
 * app-server schema accepts any non-empty effort string, and claude's and
 * cursor's model lists are deliberately curated subsets of a much larger
 * catalog. The opposite direction — the catalog grew — is a *report* from
 * harness:snapshot, not a failure, because curation is the owner's call.
 *
 * Marker presence is likewise reported, never asserted: a phrase missing from
 * a newly installed binary does not prove the marker wrong (an older CLI may
 * still emit it), and replacing one needs a real captured failure, which this
 * repository requires and a test cannot supply.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_ADAPTERS } from "../src/adapters";
import { adapterFlags } from "../scripts/harness/diff";
import { loadAllFacts, parseFacts, serializeFacts, type HarnessFacts } from "../scripts/harness/facts";

const FACTS = loadAllFacts();
const byName = new Map(FACTS.map((f) => [f.harness, f]));

function surfaceList(facts: HarnessFacts, surface: string, key: string): string[] | null {
  return facts.surfaces[surface]?.lists?.[key] ?? null;
}

describe("harness facts files", () => {
  test("every builtin adapter has one", () => {
    expect(FACTS.map((f) => f.harness).sort()).toEqual(Object.keys(BUILTIN_ADAPTERS).sort());
  });

  test("each names the adapter's own binary", () => {
    for (const facts of FACTS) {
      expect(facts.bin).toBe(BUILTIN_ADAPTERS[facts.harness]!.bin);
    }
  });

  test("each is canonically serialized, so a diff is never reordering noise", () => {
    for (const facts of FACTS) {
      const round = parseFacts(serializeFacts(facts), facts.harness);
      expect(serializeFacts(round)).toBe(serializeFacts(facts));
    }
  });

  test("every surface declares whether re-verifying it costs a turn", () => {
    for (const facts of FACTS) {
      for (const [name, surface] of Object.entries(facts.surfaces)) {
        expect(["free", "live"], `${facts.harness}.${name}`).toContain(surface.cost);
        expect(surface.source.length, `${facts.harness}.${name} source`).toBeGreaterThan(0);
      }
    }
  });

  test("every pinned fixture file exists, so a rename cannot orphan a pin", () => {
    for (const facts of FACTS) {
      for (const file of surfaceList(facts, "fixtures", "files") ?? []) {
        expect(existsSync(join(import.meta.dir, "fixtures", file)), `${facts.harness}: ${file}`).toBe(true);
      }
    }
  });
});

describe("adapters agree with the installed CLIs' advertised contract", () => {
  test("staticModels never offers an id the catalog dropped", () => {
    for (const facts of FACTS) {
      const pinned = BUILTIN_ADAPTERS[facts.harness]!.staticModels;
      const catalog = surfaceList(facts, "models", "ids");
      if (!pinned || !catalog) continue;
      // the failure this prevents: a task picking a dead id fails pre-flight
      expect(pinned.filter((id) => !catalog.includes(id)), `${facts.harness} staticModels`).toEqual([]);
    }
  });

  test("defaultModel, when declared, still exists", () => {
    for (const facts of FACTS) {
      const fallback = BUILTIN_ADAPTERS[facts.harness]!.defaultModel;
      const catalog = surfaceList(facts, "models", "ids");
      if (!fallback || !catalog) continue;
      expect(catalog, `${facts.harness} defaultModel`).toContain(fallback);
    }
  });

  test("the effort menu hides no level the CLI accepts", () => {
    for (const facts of FACTS) {
      const declared = BUILTIN_ADAPTERS[facts.harness]!.effortLevels;
      const observed = surfaceList(facts, "effortLevels", "observed");
      if (!declared || !observed) continue;
      // the failure this prevents: a level the harness supports is unreachable
      expect(observed.filter((v) => !declared.includes(v)), `${facts.harness} effortLevels`).toEqual([]);
    }
  });

  test("every flag Wisp passes still exists in the CLI's help", () => {
    for (const facts of FACTS) {
      const observed = surfaceList(facts, "flags", "values");
      if (!observed) continue;
      const def = BUILTIN_ADAPTERS[facts.harness]!;
      // the failure this prevents: a removed flag makes every turn fail
      expect(adapterFlags(def).filter((f) => !observed.includes(f)), `${facts.harness} flags`).toEqual([]);
    }
  });
});

describe("committed facts are safe for a public repository", () => {
  // The extractors are allowlist-based, so this is a backstop rather than the
  // defence: it catches a future extractor that starts copying free text.
  const FORBIDDEN: [string, RegExp][] = [
    ["an absolute path", /(^|["\s:=])\/(Users|home|var|tmp|opt|private)\//],
    ["a home directory", /~\/[A-Za-z._-]/],
    ["an email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
    ["a Windows path", /[A-Za-z]:\\\\/],
  ];

  test("no facts file leaks environment detail", () => {
    for (const facts of FACTS) {
      const raw = serializeFacts(facts);
      for (const [label, pattern] of FORBIDDEN) {
        expect(pattern.test(raw), `${facts.harness}.json contains ${label}`).toBe(false);
      }
    }
  });

  test("recorded values stay short — free prose is how a secret would arrive", () => {
    for (const facts of FACTS) {
      for (const [name, surface] of Object.entries(facts.surfaces)) {
        for (const [key, values] of Object.entries(surface.lists ?? {})) {
          for (const value of values) {
            expect(value.length, `${facts.harness}.${name}.${key}: ${value.slice(0, 40)}`).toBeLessThanOrEqual(80);
          }
        }
      }
    }
  });
});

describe("the droid catalog fixture and the droid facts agree", () => {
  // droid's committed stderr fixture IS a model catalog capture; if the two
  // disagree, one of them was refreshed and the other forgotten.
  test("every model in the facts appears in the invalid-model fixture", () => {
    const facts = byName.get("droid")!;
    const ids = surfaceList(facts, "models", "ids") ?? [];
    const text = readFileSync(join(import.meta.dir, "fixtures", "droid-unknown-model.stderr.txt"), "utf8");
    expect(ids.filter((id) => !text.includes(id))).toEqual([]);
  });
});
