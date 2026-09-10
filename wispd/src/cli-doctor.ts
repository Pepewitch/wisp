import { homedir } from "node:os";
import { join } from "node:path";

export async function doctorCommand(flags: Record<string, unknown>): Promise<void> {
  if (flags.storage !== undefined) {
    if (flags.storage !== true || Object.keys(flags).some(key => !["storage", "archived-before"].includes(key))) {
      throw new Error("Use 'doctor --storage [--archived-before <30d|YYYY-MM-DD>]' without other options.");
    }
    const { storageReport, formatStorageReport } = await import("./storage-report");
    const before = flags["archived-before"];
    if (before !== undefined && typeof before !== "string") throw new Error("--archived-before requires a value");
    console.log(formatStorageReport(await storageReport(process.env.WISP_HOME ?? join(homedir(), ".wisp"), before)));
    return;
  }
  const { checkDatabase, runDoctor } = await import("./doctor");
  if (flags.database !== undefined) {
    if (flags.database !== true || flags.harness !== undefined) {
      throw new Error("Use 'doctor --database' without --harness or a value.");
    }
    const check = checkDatabase();
    console.log(`${check.status.padEnd(4)} ${check.name}: ${check.message}`);
    if (check.status === "fail") process.exit(1);
    return;
  }
  if (flags.harness !== undefined && typeof flags.harness !== "string") {
    throw new Error("--harness requires a name (e.g. --harness droid)");
  }
  let failed = false;
  for (const check of await runDoctor({
    selectedHarness: typeof flags.harness === "string" ? flags.harness : undefined,
  })) {
    console.log(`${check.status.padEnd(4)} ${check.name}: ${check.message}`);
    if (check.status === "fail") failed = true;
  }
  if (failed) process.exit(1);
}
