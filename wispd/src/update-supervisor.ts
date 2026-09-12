import type { SpawnResult } from "./doctor";

const HOMEBREW_SERVICE_LABELS = ["sh.brew.wisp", "homebrew.mxcl.wisp"] as const;
const SUPERVISORD_UPDATE_OPT_IN = "supervisord";
const SUPERVISORD_PROGRAM = "wisp";

type Run = (cmd: string[]) => SpawnResult;

function output(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8").trim();
}

function runSync(cmd: string[]): SpawnResult {
  const result = Bun.spawnSync({ cmd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: output(result.stdout),
    stderr: output(result.stderr),
  };
}

function pidFromLaunchctlOutput(value: string): number | null {
  const match = value.match(/(?:^|\n)\s*pid\s*=\s*(\d+)\s*(?:\n|$)/);
  return match ? Number(match[1]) : null;
}

export function isHomebrewServiceProcess(
  uid: number,
  pid: number,
  run: Run = runSync,
): boolean {
  return HOMEBREW_SERVICE_LABELS.some((label) => {
    const service = run(["launchctl", "print", `gui/${uid}/${label}`]);
    return service.exitCode === 0 && pidFromLaunchctlOutput(service.stdout) === pid;
  });
}

export function isSupervisordServiceProcess(
  pid: number,
  env: NodeJS.ProcessEnv = process.env,
  run: Run = runSync,
): boolean {
  if (
    env.WISP_UPDATE_SUPERVISOR !== SUPERVISORD_UPDATE_OPT_IN ||
    env.SUPERVISOR_ENABLED !== "1" ||
    env.SUPERVISOR_PROCESS_NAME !== SUPERVISORD_PROGRAM ||
    env.SUPERVISOR_GROUP_NAME !== SUPERVISORD_PROGRAM
  ) {
    return false;
  }
  try {
    const service = run(["supervisorctl", "pid", SUPERVISORD_PROGRAM]);
    return service.exitCode === 0 && Number(service.stdout) === pid;
  } catch {
    return false;
  }
}
