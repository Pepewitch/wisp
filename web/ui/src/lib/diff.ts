/**
 * Unified-diff parsing for the file-list-first diff pane (S2.5).
 *
 * GET /api/tasks/:id/diff returns ONE payload (DiffResponse.diff): `git diff
 * <base>` plus synthetic new-file patches for untracked paths. The pane splits
 * it per file client-side — the diff text is already fetched, so no extra
 * fetch is needed on click. The parser is tolerant by design: a diff truncated
 * at the 512KB cap can end mid-hunk, and whatever lines exist still render.
 */

export type DiffLineKind = "add" | "del" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  /** the line without its +/-/space prefix */
  text: string;
  /** old-file line number (del + context lines; null on adds) */
  oldNo: number | null;
  /** new-file line number (add + context lines; null on dels) */
  newNo: number | null;
}

export interface DiffHunk {
  /** the whole @@ line, kept for its section label */
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffFile {
  /** display path — the b-side (postimage), or the a-side for deletions */
  path: string;
  /** the pre-image path, when it differs (rename/copy) */
  oldPath: string | null;
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
  adds: number;
  dels: number;
  hunks: DiffHunk[];
}

export interface ParsedDiff {
  files: DiffFile[];
  adds: number;
  dels: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/** unquoted form; quoted paths fall back to the ---/+++ lines */
const GIT_LINE_RE = /^diff --git a\/(.+) b\/(.+)$/;

const stripSide = (p: string) => p.replace(/^[ab]\//, "");

export function parseDiff(diff: string): ParsedDiff {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      file = {
        path: "",
        oldPath: null,
        isNew: false,
        isDeleted: false,
        isBinary: false,
        adds: 0,
        dels: 0,
        hunks: [],
      };
      files.push(file);
      const m = GIT_LINE_RE.exec(raw);
      if (m) file.path = m[2]!; // the b-side; ---/+++ lines refine it below
      hunk = null;
      continue;
    }
    if (!file) continue; // noise before the first file header — shouldn't happen

    if (raw.startsWith("@@")) {
      const m = HUNK_RE.exec(raw);
      if (!m) continue;
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      hunk = {
        header: raw,
        oldStart: oldNo,
        oldCount: Number(m[2] ?? "1"),
        newStart: newNo,
        newCount: Number(m[4] ?? "1"),
        lines: [],
      };
      file.hunks.push(hunk);
      continue;
    }

    if (hunk) {
      if (raw.startsWith("+")) {
        hunk.lines.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ });
        file.adds++;
        continue;
      }
      if (raw.startsWith("-")) {
        hunk.lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null });
        file.dels++;
        continue;
      }
      if (raw.startsWith(" ")) {
        hunk.lines.push({ kind: "context", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
        continue;
      }
      if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
      hunk = null; // anything else ends the hunk (incl. a truncated cut)
      // fall through — the line may still be a file-header line
    }

    if (raw.startsWith("--- ")) {
      const p = raw.slice(4);
      if (p === "/dev/null") file.isNew = true;
      else file.oldPath = stripSide(p);
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4);
      if (p === "/dev/null") file.isDeleted = true;
      else file.path = stripSide(p);
      continue;
    }
    if (raw.startsWith("Binary files") || raw.startsWith("GIT binary patch")) {
      file.isBinary = true;
      continue;
    }
    // index / old mode / new mode / similarity / rename from-to: parsed
    // enough via ---/+++ above; nothing else to display
  }

  // a deletion has no +++ path — the display path is the a-side
  for (const f of files) {
    if (f.path === "" && f.oldPath) f.path = f.oldPath;
  }

  return {
    files,
    adds: files.reduce((n, f) => n + f.adds, 0),
    dels: files.reduce((n, f) => n + f.dels, 0),
  };
}

/**
 * Unmodified-line counts before each hunk (the collapsed regions in the
 * detail view): the leading region for the first hunk, then the gap between
 * consecutive hunks. The region AFTER the last hunk is unknowable from the
 * diff alone — the pane simply ends. Zero means "no collapsed region here".
 */
export function hunkGaps(file: DiffFile): number[] {
  const gaps: number[] = [];
  let coveredUntil = 1; // old-file line numbering starts at 1
  file.hunks.forEach((h, i) => {
    gaps.push(Math.max(0, i === 0 ? h.oldStart - 1 : h.oldStart - coveredUntil));
    coveredUntil = h.oldStart + h.oldCount;
  });
  return gaps;
}

/** The section label after a hunk's closing @@ (usually the enclosing symbol), when present. */
export function hunkSection(hunk: DiffHunk): string | null {
  const m = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@\s*(.*)$/.exec(hunk.header);
  return m && m[1] !== "" ? m[1]! : null;
}
