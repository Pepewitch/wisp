import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECTS_DIR } from "../src/config";
import {
  activateDraft, activeRecipe, changedFiles, latestDraft, matchAreas, parseAreaFrontmatter, projectDir, readRecipeFile, recipeDir,
  recipeFiles, recipeFilesError, recipePathError, recipeVersion, saveDraft, type RecipeFile,
} from "../src/verify/recipe";

function repo(): string {
  return mkdtempSync(join(tmpdir(), "wisp-recipe-repo-"));
}

const area = (name: string, paths: string, status = "proven"): RecipeFile => ({
  path: `areas/${name}/AREA.md`,
  content: `---\npaths: ${paths}\nstatus: ${status}\n---\n\n## Launch\n\nbun run dev\n`,
});

const recipe = (...extra: RecipeFile[]): RecipeFile[] => [{ path: "RECIPE.md", content: "# Fixture\n\nRun `bun test` first.\n" }, ...extra];

describe("the recipe's place", () => {
  test("lives in the Wisp home, one directory per project, never in the repository", () => {
    const path = repo();
    expect(projectDir(path).startsWith(`${PROJECTS_DIR}/`)).toBe(true);
    expect(recipeDir(path).startsWith(path)).toBe(false);
    // two repos with one name do not share it
    expect(projectDir(join(path, "a", "app"))).not.toBe(projectDir(join(path, "b", "app")));
  });
});

describe("what a recipe may hold", () => {
  test("a path is relative, plain and not hidden", () => {
    expect(recipePathError("areas/web/AREA.md")).toBeNull();
    expect(recipePathError("../escape.md")).not.toBeNull();
    expect(recipePathError("/abs.md")).not.toBeNull();
    expect(recipePathError("areas/.hidden/AREA.md")).not.toBeNull();
    expect(recipePathError("a//b.md")).not.toBeNull();
  });

  test("needs RECIPE.md, and every area its AREA.md with paths", () => {
    expect(recipeFilesError(recipe())).toBeNull();
    expect(recipeFilesError([area("web", "apps/web/**")])).toContain("RECIPE.md");
    expect(recipeFilesError(recipe({ path: "areas/web/features/one.md", content: "x" }))).toContain("has no AREA.md");
    expect(recipeFilesError(recipe({ path: "areas/web/AREA.md", content: "no frontmatter" }))).toContain("frontmatter");
    expect(recipeFilesError(recipe({ path: "areas/Web/AREA.md", content: "---\npaths: x\n---" }))).toContain("lowercase");
    expect(recipeFilesError(recipe({ path: "areas/AREA.md", content: "x" }))).toContain("inside an area");
    expect(recipeFilesError(recipe({ path: "RECIPE.md", content: "again" }))).toContain("twice");
    expect(recipeFilesError(recipe({ path: "bin.dat", content: "a\u0000b" }))).toContain("text");
  });

  test("an area's paths may be a comma list or a YAML list, and must stay inside the repository", () => {
    expect(parseAreaFrontmatter("---\npaths: apps/web/**, packages/ui/**\nstatus: proven\n---")).toEqual({ paths: ["apps/web/**", "packages/ui/**"], status: "proven" });
    expect(parseAreaFrontmatter("---\npaths:\n  - \"apps/api/**\"\n  - libs/**\n---")).toEqual({ paths: ["apps/api/**", "libs/**"], status: "unproven" });
    expect(parseAreaFrontmatter("---\npaths: ../outside/**\n---")).toContain("outside");
    expect(parseAreaFrontmatter("---\nstatus: proven\n---")).toContain("names no paths");
  });
});

describe("drafts and activation", () => {
  test("a draft is kept apart until a person activates it, and each activation is a version", async () => {
    const path = repo();
    expect(activeRecipe(path)).toBeNull();
    expect(await recipeVersion(path)).toBeNull();
    saveDraft(path, "trecipe1", recipe(area("web", "apps/web/**")));
    expect(activeRecipe(path)).toBeNull();
    expect(latestDraft(path)?.areas.map((a) => a.name)).toEqual(["web"]);
    const first = await activateDraft(path, "web");
    expect(first.changed).toBe(true);
    expect(latestDraft(path)).toBeNull();
    expect(activeRecipe(path)?.areas).toEqual([{ name: "web", paths: ["apps/web/**"], status: "proven" }]);
    expect(await recipeVersion(path)).toBe(first.version);
    expect(readRecipeFile(path, "areas/web/AREA.md")).toContain("bun run dev");

    // the next draft replaces the whole recipe: an area it drops is gone
    saveDraft(path, "trecipe2", recipe(area("api", "apps/api/**", "unproven")));
    const second = await activateDraft(path, "cli");
    expect(second.version).not.toBe(first.version);
    expect(activeRecipe(path)?.areas.map((a) => a.name)).toEqual(["api"]);
    expect(existsSync(join(recipeDir(path), "areas", "web"))).toBe(false);
  });

  test("the newest save wins, and a draft that matches the active recipe changes nothing", async () => {
    const path = repo();
    saveDraft(path, "told1", recipe(area("web", "apps/web/**")), new Date("2026-10-01T00:00:00Z"));
    saveDraft(path, "tnew1", recipe(area("api", "apps/api/**")), new Date("2026-10-02T00:00:00Z"));
    expect(latestDraft(path)?.taskId).toBe("tnew1");
    await activateDraft(path, "web");
    saveDraft(path, "tsame", recipe(area("api", "apps/api/**")));
    expect((await activateDraft(path, "web")).changed).toBe(false);
  });

  test("an invalid draft is refused when saved", () => {
    expect(() => saveDraft(repo(), "tbad", [{ path: "notes.md", content: "x" }])).toThrow("RECIPE.md");
  });

  test("activating with no draft is refused", async () => {
    await expect(activateDraft(repo(), "web")).rejects.toThrow("no draft");
  });

  test("a checkout reads every file, and a file outside the recipe reads as absent", async () => {
    const path = repo();
    saveDraft(path, "tfiles", recipe(area("web", "apps/web/**"), { path: "areas/web/features/login.md", content: "Log in" }));
    expect(recipeFiles(path, "tfiles").map((f) => f.path)).toEqual(["RECIPE.md", "areas/web/AREA.md", "areas/web/features/login.md"]);
    await activateDraft(path, "web");
    expect(readRecipeFile(path, "../../config.json")).toBeNull();
    expect(readRecipeFile(path, ".git/HEAD")).toBeNull();
    expect(readFileSync(join(recipeDir(path), "areas/web/features/login.md"), "utf8")).toBe("Log in");
  });
});

describe("matching a diff to areas", () => {
  test("a file can be in several areas, and one in none is reported", () => {
    const areas = [
      { name: "web", paths: ["apps/web/**", "packages/ui/**"], status: "proven" as const },
      { name: "ui", paths: ["packages/ui/**"], status: "unproven" as const },
      { name: "api", paths: ["apps/api/**"], status: "proven" as const },
    ];
    const { matched, unmapped } = matchAreas(areas, ["packages/ui/button.tsx", "README.md"]);
    expect(matched.map((a) => a.name)).toEqual(["web", "ui"]);
    expect(unmapped).toEqual(["README.md"]);
  });

  test("changed files are the three-dot diff against the base", async () => {
    const path = repo();
    const git = (...args: string[]) => {
      const run = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: path });
      if (run.exitCode !== 0) throw new Error(run.stderr.toString());
      return run.stdout.toString().trim();
    };
    git("init", "-q", "-b", "main");
    await Bun.write(join(path, "a.txt"), "a");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    await Bun.write(join(path, "apps", "web", "page.tsx"), "x");
    git("add", "-A");
    git("commit", "-q", "-m", "change");
    const head = git("rev-parse", "HEAD");
    expect(await changedFiles(path, "main", head)).toEqual(["apps/web/page.tsx"]);
  });
});
