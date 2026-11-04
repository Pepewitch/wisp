/**
 * The trash directory's name inside the worktree root (worktree-trash.ts).
 * Its own module, free of imports, because `wisp doctor --storage` reads it and
 * must not load config.ts, whose import creates directories in the home.
 * A dot-name is never a task's worktree name, which is `<repo>-<task id>`.
 */
export const TRASH_DIR_NAME = ".trash";
