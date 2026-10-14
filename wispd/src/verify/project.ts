/** A project's display name: its configured name, else its directory's. */
import { basename, resolve } from "node:path"
import { repoConfigFor, type WispConfig } from "../config"

export function projectName(cfg: WispConfig, repoPath: string): string {
  return repoConfigFor(cfg, repoPath)?.name?.trim() || basename(resolve(repoPath))
}
