import { readFileSync } from "node:fs";

/** Linux process start ticks repeat after reboot; bind identities to this boot. */
function bootIdentity(): string | null {
  try {
    if (process.platform === "linux") {
      return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
    }
    if (process.platform === "darwin") {
      const result = Bun.spawnSync({ cmd: ["sysctl", "-n", "kern.boottime"], stdout: "pipe", stderr: "ignore" });
      if (result.exitCode !== 0) return null;
      const match = result.stdout.toString().match(/sec = (\d+), usec = (\d+)/);
      return match ? `${match[1]}:${match[2]}` : null;
    }
  } catch { /* An unavailable boot identity cannot grant signalling authority. */ }
  return null;
}

// One startup read, never a synchronous subprocess in a request or poll loop.
export const PROCESS_BOOT_ID = bootIdentity();
