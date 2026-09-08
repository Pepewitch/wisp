import { describe, expect, it } from "vitest";

import { hunkGaps, hunkSection, parseDiff } from "./diff";

/** Two files; the first has two hunks with a 26-line unmodified gap between them. */
const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,6 @@ import { VERSION } from "./version";
 const LOG_TAIL_BYTES = 16_384;
+// an added line
+// another added line
 const VENDOR_ASSETS = {};
-// a removed line
 const after = 1;
@@ -40,2 +42,3 @@ tail
 ctx
+add2
 ctx2
diff --git a/src/b.ts b/src/b.ts
index 3333333..4444444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,2 @@
 line
+new
`;

describe("parseDiff", () => {
  it("splits one payload into per-file entries with add/del counts", () => {
    const parsed = parseDiff(SAMPLE);
    expect(parsed.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(parsed.files[0]!.adds).toBe(3);
    expect(parsed.files[0]!.dels).toBe(1);
    expect(parsed.files[1]!.adds).toBe(1);
    expect(parsed.files[1]!.dels).toBe(0);
    expect(parsed.adds).toBe(4);
    expect(parsed.dels).toBe(1);
  });

  it("parses hunk headers and numbers every line old-side and new-side", () => {
    const file = parseDiff(SAMPLE).files[0]!;
    expect(file.hunks).toHaveLength(2);
    const [h1, h2] = file.hunks;
    expect(h1!.oldStart).toBe(10);
    expect(h1!.oldCount).toBe(4);
    expect(h1!.newStart).toBe(10);
    expect(h1!.newCount).toBe(6);
    expect(h2!.oldStart).toBe(40);

    const [c1, a1, a2, c2, d1, c3] = h1!.lines;
    expect(c1).toMatchObject({ kind: "context", text: "const LOG_TAIL_BYTES = 16_384;", oldNo: 10, newNo: 10 });
    expect(a1).toMatchObject({ kind: "add", text: "// an added line", oldNo: null, newNo: 11 });
    expect(a2).toMatchObject({ kind: "add", oldNo: null, newNo: 12 });
    expect(c2).toMatchObject({ kind: "context", oldNo: 11, newNo: 13 });
    expect(d1).toMatchObject({ kind: "del", text: "// a removed line", oldNo: 12, newNo: null });
    expect(c3).toMatchObject({ kind: "context", oldNo: 13, newNo: 14 });
  });

  it("handles new and deleted files via /dev/null", () => {
    const parsed = parseDiff(`diff --git a/fresh.ts b/fresh.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/fresh.ts
@@ -0,0 +1,2 @@
+one
+two
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 1111111..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
`);
    const [added, removed] = parsed.files;
    expect(added).toMatchObject({ path: "fresh.ts", isNew: true, isDeleted: false, adds: 2, dels: 0 });
    expect(removed).toMatchObject({ path: "gone.ts", isNew: false, isDeleted: true, adds: 0, dels: 1 });
    // a pure-addition hunk starts numbering at newNo 1 with no leading gap
    expect(hunkGaps(added!)).toEqual([0]);
  });

  it("keeps both paths of a rename", () => {
    const parsed = parseDiff(`diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
index 1111111..2222222 100644
--- a/old.ts
+++ b/new.ts
@@ -1,1 +1,1 @@
-old
+new
`);
    expect(parsed.files[0]).toMatchObject({ path: "new.ts", oldPath: "old.ts", adds: 1, dels: 1 });
  });

  it("flags binary files and gives them no hunks", () => {
    const parsed = parseDiff(`diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
`);
    expect(parsed.files[0]).toMatchObject({ path: "logo.png", isBinary: true, adds: 0, dels: 0, hunks: [] });
  });

  it("tolerates a diff truncated mid-hunk (the 512KB cap)", () => {
    const parsed = parseDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,6 @@
 const ctx
+add
-`);
    expect(parsed.files[0]!.hunks[0]!.lines).toHaveLength(3);
    expect(parsed.files[0]!.adds).toBe(1);
    expect(parsed.files[0]!.dels).toBe(1);
  });

  it("returns no files for an empty diff", () => {
    expect(parseDiff("")).toEqual({ files: [], adds: 0, dels: 0 });
  });

  it("parses an untracked new-file patch the daemon appends", () => {
    const parsed = parseDiff(`diff --git a/scratch.txt b/scratch.txt
new file mode 100644
--- /dev/null
+++ b/scratch.txt
@@ -0,0 +1 @@
+UNTRACKED_CONTENT
`);
    expect(parsed.files[0]).toMatchObject({ path: "scratch.txt", isNew: true, adds: 1, dels: 0 });
    expect(parsed.files[0]!.hunks[0]!.lines[0]).toMatchObject({
      kind: "add",
      text: "UNTRACKED_CONTENT",
      oldNo: null,
      newNo: 1,
    });
  });
});

describe("hunkGaps — the collapsed unmodified regions", () => {
  it("computes the leading region and the between-hunk gap", () => {
    const file = parseDiff(SAMPLE).files[0]!;
    expect(hunkGaps(file)).toEqual([9, 26]);
  });

  it("is zero when a hunk starts at the top of the file", () => {
    const file = parseDiff(SAMPLE).files[1]!;
    expect(hunkGaps(file)).toEqual([0]);
  });
});

describe("hunkSection", () => {
  it("returns the label after the closing @@, or null", () => {
    const file = parseDiff(SAMPLE).files[0]!;
    expect(hunkSection(file.hunks[0]!)).toBe('import { VERSION } from "./version";');
    expect(hunkSection(file.hunks[1]!)).toBe("tail");
  });
});
