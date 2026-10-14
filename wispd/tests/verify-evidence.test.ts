import { describe, expect, test } from "bun:test";
import type { CaptureRow } from "../src/capture/store";
import { evidenceShortfall, requiredAreas, waiversError } from "../src/verify/evidence";

const area = (name: string, paths: string[], evidence: "screenshot" | "none" = "screenshot") => ({ name, paths, status: "proven" as const, evidence });
const capture = (fields: Partial<CaptureRow>): CaptureRow => ({
  id: "cap", task_id: "t", turn: 1, image_id: "i", review_id: "v", area: "web", status: "ok", reason: null, message: null,
  requested_url: "http://127.0.0.1:20010/", final_url: null, http_status: 200, viewport: "desktop", dpr: 2, width: 1, height: 1, media_type: "image/png",
  full_page: 0, clipped: 0, selector_used: 0, script_used: 0, settled: 1, served_from: "worktree", errors_json: null, blocked_json: null, created_at: "",
  ...fields,
});

describe("which areas need a screenshot", () => {
  test("only areas that ask for one, and only for changes beyond docs and tests", () => {
    const areas = [area("web", ["web/**"]), area("api", ["api/**"], "none")];
    expect(requiredAreas(areas, ["web/src/page.tsx", "api/x.ts"], [])).toEqual(["web"]);
    expect(requiredAreas(areas, ["web/src/page.test.tsx", "web/README.md"], ["web/**/*.md"])).toEqual([]);
    expect(requiredAreas(areas, null, [])).toEqual([]);
  });
});

describe("a pass and its evidence", () => {
  const rule = (captures: CaptureRow[], waivers: { area: string; reason: string }[] = [], images = 1) =>
    evidenceShortfall({ required: ["web"], captures, waivers, images });

  test("a capture of the area from the reviewer's own worktree is enough", () => {
    expect(rule([capture({})])).toBeNull();
  });

  test("no capture, a capture of another area, or one served from elsewhere is not", () => {
    expect(rule([])).toContain("area web needs a screenshot");
    expect(rule([capture({ area: "admin" })])).toContain("area web needs a screenshot");
    expect(rule([capture({ served_from: "elsewhere" })])).toContain("area web needs a screenshot");
  });

  test("a waiver is accepted only where Wisp recorded why, and with a published image", () => {
    const why = [{ area: "web", reason: "Chrome is not installed here" }];
    expect(rule([], why)).toContain("has nothing behind it");
    expect(rule([capture({ status: "failed", reason: "no-chrome", area: null })], why)).toBeNull();
    expect(rule([capture({ status: "failed", reason: "no-chrome", area: null })], why, 0)).toContain("published");
    // an app failure is the app's, not the machine's: it does not back a waiver
    expect(rule([capture({ status: "failed", reason: "http-error" })], why)).toContain("has nothing behind it");
    expect(rule([capture({ served_from: "unknown" })], why)).toBeNull();
  });

  test("the waiver list's shape", () => {
    expect(waiversError([{ area: "web", reason: "no Chrome" }])).toBeNull();
    expect(waiversError([{ area: "web" }])).toContain("says why");
    expect(waiversError([{ area: "web", reason: "x", extra: 1 }])).toContain("{ area, reason }");
    expect(waiversError("web")).toContain("list");
  });
});
