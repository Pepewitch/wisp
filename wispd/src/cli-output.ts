import { basename } from "node:path";
import { writeFileSync } from "node:fs";
import { outputImageUrl, type OutputImage } from "../../shared/api/outputs";
import { api, daemonRequest, downloadOutputImage, exitApi } from "./cli-api";
import type { Flags } from "./cli-args";
import { print } from "./cli-print";
import { wispCommand } from "./command";

export async function outputCommand(positional: string[], flags: Flags): Promise<void> {
  const [command, argument, imageId] = positional;
  const taskId = typeof flags.task === "string" ? flags.task : command === "add" ? process.env.WISP_TASK_ID : argument;
  const turn = typeof flags.turn === "string" ? Number(flags.turn) : NaN;
  if (!taskId || !Number.isSafeInteger(turn) || turn < 1) throw new Error("output requires a task and --turn <n> (add defaults to WISP_TASK_ID)");
  const path = `/api/tasks/${encodeURIComponent(taskId)}/outputs/${turn}`;
  if (command === "add") {
    if (!argument) throw new Error("usage: wisp output add <image-path> --turn <n> [--task <task>]");
    const file = Bun.file(argument);
    if (!(await file.exists())) throw new Error("output image file does not exist");
    if (file.size > 8 * 1024 * 1024) throw new Error("output image exceeds the 8 MiB limit");
    try {
      const data = await daemonRequest(`${path}?name=${encodeURIComponent(basename(argument))}`, "POST", file, "application/octet-stream", 30_000);
      print(flags.json ? JSON.stringify(data) : `${data.image.name} published\n${data.url}\n${saveCommand(taskId, turn, data.image)}`);
    } catch (error) { exitApi(error); }
    return;
  }
  if (command === "list") {
    const data = await api(path) as { outputs: OutputImage[] };
    if (flags.json) print(JSON.stringify(data));
    else if (!data.outputs.length) print("No output images on this turn.");
    else for (const image of data.outputs) print(`${image.name} (${image.size} bytes)\n${outputImageUrl(taskId, turn, image.id)}\n${saveCommand(taskId, turn, image)}`);
    return;
  }
  if (command === "save") {
    if (!imageId || !/^[a-f0-9]{64}$/.test(imageId) || typeof flags.out !== "string") throw new Error("usage: wisp output save <task> <image-id> --turn <n> --out <new-file>");
    let bytes: Uint8Array;
    try { bytes = await downloadOutputImage(outputImageUrl(taskId, turn, imageId)); }
    catch (error) { exitApi(error); }
    writeFileSync(flags.out, bytes, { flag: "wx", mode: 0o600 });
    print(`Saved ${flags.out}`);
    return;
  }
  throw new Error("output expects add, list or save");
}

export function saveCommand(taskId: string, turn: number, image: Pick<OutputImage, "id">): string {
  return `${wispCommand()} output save ${taskId} ${image.id} --turn ${turn} --out <new-file>`;
}
