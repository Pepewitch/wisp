import { expect, test } from "bun:test";
import { inlineBuildAsset } from "../web/scripts/inline-build-assets";

test("inline JS preserves module attributes and string values without closing the HTML script", () => {
  const value = "</SCRIPT><script>hostile</script><!--";
  const result = inlineBuildAsset('<script type="module" crossorigin src="./entry-a.js"></script>', "entry-a.js", `return ${JSON.stringify(value)};`, "script");
  expect(result).toStartWith('<script type="module" crossorigin>');
  expect(result.match(/<\/script/gi)).toHaveLength(1);
  const code = result.slice(result.indexOf(">") + 1, result.lastIndexOf("</script>"));
  expect(new Function(code)()).toBe(value);
});

test("CSS is inlined without a charset or an embedded closing style tag", () => {
  const html = '<link rel="stylesheet" crossorigin href="./chunks/main.css">';
  const result = inlineBuildAsset(html, "chunks/main.css", '@charset "UTF-8"; .x { content: "</style>" }', "style");
  expect(result).toStartWith('<style rel="stylesheet" crossorigin>');
  expect(result).not.toContain("@charset");
  expect(result.match(/<\/style/gi)).toHaveLength(1);
});

test("only the exact generated asset URL is inlined, never a remote or similar filename", () => {
  for (const html of ['<script src="./entry-aXjs"></script>', '<script src="https://other.example/entry-a.js"></script>']) {
    expect(inlineBuildAsset(html, "entry-a.js", "alert(1)", "script")).toBe(html);
  }
});
