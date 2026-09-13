import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("every evaluator Python package is versioned and hash locked", () => {
  const compilerPath = join(root, "wispd/scripts/evaluator/compile-requirements.sh");
  const compiler = readFileSync(compilerPath, "utf8");
  expect(statSync(compilerPath).mode & 0o111).not.toBe(0);
  expect(compiler).toMatch(/^required_uv=\d+\.\d+\.\d+$/m);
  expect(compiler).toContain('if [ "$actual_uv" != "$required_uv" ]');

  const direct = readFileSync(join(root, "wispd/scripts/evaluator/requirements.in"), "utf8")
    .trim()
    .split("\n");
  expect(direct.length).toBeGreaterThan(0);
  for (const requirement of direct) expect(requirement).toMatch(/^[A-Za-z0-9_.-]+==\S+$/);

  const lock = readFileSync(join(root, "wispd/scripts/evaluator/requirements.lock"), "utf8");
  const blocks = lock.trim().split(/\n(?=\S)/);
  expect(blocks.length).toBeGreaterThanOrEqual(direct.length);
  const locked = new Set<string>();
  for (const block of blocks) {
    const lines = block.split("\n");
    expect(lines[0]).toMatch(/^[A-Za-z0-9_.-]+==\S+ \\$/);
    locked.add(lines[0]!.slice(0, -2).toLowerCase().replaceAll("_", "-"));
    expect(lines.length).toBeGreaterThan(1);
    for (const [index, line] of lines.slice(1).entries()) {
      const final = index === lines.length - 2;
      expect(line).toMatch(
        final ? /^ {4}--hash=sha256:[0-9a-f]{64}$/ : /^ {4}--hash=sha256:[0-9a-f]{64} \\$/,
      );
    }
  }
  for (const requirement of direct) {
    expect(locked.has(requirement.toLowerCase().replaceAll("_", "-"))).toBe(true);
  }

  const dockerfile = readFileSync(join(root, "wispd/scripts/evaluator/Dockerfile"), "utf8");
  expect(dockerfile).toContain(
    "pip install --no-cache-dir --only-binary=:all: --require-hashes --requirement /opt/evaluator/requirements.lock",
  );
});
