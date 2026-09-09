/** Separate daemon processes prove recovery does not depend on module memory. */
import { renameSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTERS_PATH, CONFIG_PATH, loadConfig, WISP_HOME } from "../../src/config";
import { serve } from "../../src/daemon";
import { createTask, getTask, setTaskFields } from "../../src/store";
import { startTurn } from "../../src/runner";
import type { AdapterDef } from "../../src/adapters";

const def: AdapterDef = {
  bin: "bash", exec: ["-c", [
    "if [ -f child.pid ]; then echo second-result; exit 0; fi",
    `sh -c 'trap "" TERM; echo $$ > child.pid; while :; do sleep 1; done' </dev/null >/dev/null 2>&1 &`,
    "while [ ! -s child.pid ]; do sleep .01; done",
    "echo first-result",
  ].join("\n")], parse: { format: "text" }, attach: null,
};
writeFileSync(CONFIG_PATH, JSON.stringify({ token: "background-fixture-token", host: "127.0.0.1" }));
writeFileSync(ADAPTERS_PATH, JSON.stringify({ fake: def }));
const server = await serve({ port: 0 });
if (process.argv[2] === "seed") {
  const worktree = join(WISP_HOME, "fixture-workspace");
  mkdirSync(worktree, { recursive: true });
  createTask({ id: "tbgfixture", title: "Background fixture", repo_path: worktree, harness: "fake", model: null, slot: 1 });
  setTaskFields("tbgfixture", { worktree_path: worktree });
  startTurn(getTask("tbgfixture")!, "start watcher", def, loadConfig());
}
writeFileSync(join(WISP_HOME, "ready.tmp"), JSON.stringify({ port: server.port }));
renameSync(join(WISP_HOME, "ready.tmp"), join(WISP_HOME, "ready.json"));
