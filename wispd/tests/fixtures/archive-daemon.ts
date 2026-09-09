import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH, loadConfig, WISP_HOME } from "../../src/config";
import { acquireHomeOwnership } from "../../src/home-lock";
import { archiveTaskWithCleanup } from "../../src/archive-jobs";
import { createTask, initializeStore, setTaskFields } from "../../src/store";
import { createWorktree } from "../../src/worktree";
import { serve } from "../../src/daemon";

if (process.argv[2] === "seed") {
  const owner = acquireHomeOwnership(); initializeStore();
  writeFileSync(CONFIG_PATH, JSON.stringify({ host: "127.0.0.1", token: "archive-fixture-token" }));
  const repo = join(WISP_HOME, "repo");
  for (const args of [["init", "-b", "main", repo], ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Fixture"]]) {
    const result = Bun.spawnSync(["git", ...args]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }
  for (let i = 1; i <= Number(process.argv[3] ?? 1); i++) {
    const id = `tfixture${i}`, cfg = loadConfig();
    const wt = await createWorktree(repo, id, cfg);
    createTask({ id, title: `Slow cleanup ${i}`, repo_path: repo, harness: "fake", model: null, slot: i });
    setTaskFields(id, { state: "done", worktree_path: wt.path, branch: wt.branch, base_commit: wt.base_commit });
    archiveTaskWithCleanup(id, null, { task_id: id, stage: "stop-turn", force: true, stop_turn: false,
      removable: true, repo_path: repo, worktree_path: wt.path, branch: wt.branch,
      archive_script: `echo effect >> "$WISP_HOME/${id}-effects"; while [ ! -f "$WISP_HOME/${id}-release" ]; do sleep .05; done`, timeout_minutes: 1 });
  }
  owner.release();
} else {
  const server = await serve({ port: 0 });
  writeFileSync(join(WISP_HOME, "ready.json"), JSON.stringify({ port: server.port }));
}
