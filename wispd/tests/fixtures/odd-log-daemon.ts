/**
 * A real daemon process holding one settled turn whose log carries lines the
 * display formatters used to throw on. It installs no crash guards, like
 * serve() in every test: surviving must be the stream's own doing.
 */
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH, WISP_HOME } from "../../src/config";
import { serve } from "../../src/daemon";
import { createTask, createTurn, finishTurn } from "../../src/store";

writeFileSync(CONFIG_PATH, JSON.stringify({ token: "odd-log-fixture-token", host: "127.0.0.1" }));
const server = await serve({
  port: 0,
  proseBackfill: false,
  modelProbeSpawn: () => {
    throw new Error("no model probes in the odd-log fixture");
  },
});
const log = join(WISP_HOME, "odd-turn.out.log");
writeFileSync(log, [
  `{"type":"system","subtype":"init","session_id":"fixture-session"}`,
  // the Messages API allows string content; the formatters assumed an array
  `{"type":"user","message":{"content":"a plain string"}}`,
  `{"type":"assistant","message":{"content":{"type":"text","text":"an object, not an array"}}}`,
  `{"type":"assistant","message":{"content":[null,{"type":"text","text":7}]}}`,
  `{"type":"assistant","message":{"content":[{"type":"text","text":"still here"}]}}`,
  "",
].join("\n"));
createTask({ id: "toddlog", title: "Odd log fixture", repo_path: WISP_HOME, harness: "claude", model: null, slot: 1 });
finishTurn(createTurn("toddlog", 1, "go", null, log), "done", 0, "still here");
writeFileSync(join(WISP_HOME, "ready.tmp"), JSON.stringify({ port: server.port }));
renameSync(join(WISP_HOME, "ready.tmp"), join(WISP_HOME, "ready.json"));
