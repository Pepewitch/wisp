/** One row of a project directory listing: a name inside `dir`, never a path. */
export interface ProjectEntry {
  name: string;
  kind: "dir" | "file";
}

/** GET /api/projects/entries?project=<path>&dir=<relative> */
export interface ProjectEntriesResponse {
  /** the registered project root, resolved: what a client joins `dir` and a name onto */
  project: string;
  /** the listed directory relative to `project`; "" is the root */
  dir: string;
  /** folders first, then files, each by name; `.git` and git-ignored entries are absent */
  entries: ProjectEntry[];
  /** more entries exist than the cap allowed */
  truncated: boolean;
}
