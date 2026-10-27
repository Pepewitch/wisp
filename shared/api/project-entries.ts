/** One row of a project directory listing: a name inside `dir`, never a path. */
export interface ProjectEntry {
  name: string;
  kind: "dir" | "file";
}

/** GET /api/projects/entries?project=<path>&dir=<relative>[&q=<text>]: `q` keeps names containing it, case-insensitively */
export interface ProjectEntriesResponse {
  /** the registered project root, resolved: what a client joins `dir` and a name onto */
  project: string;
  /** the listed directory relative to `project`; "" is the root */
  dir: string;
  /** folders first, then files, each by name; `.git` and git-ignored entries are absent */
  entries: ProjectEntry[];
  /** more entries match than the row cap serves: a narrower `q` reaches the rest */
  truncated: boolean;
  /** the folder has more entries than one scan reads (this many): the rest is not searchable at all */
  incompleteAfter: number | null;
}
