import { checkDatabase, runDoctor } from "./doctor";

export async function doctorCommand(flags: Record<string, unknown>): Promise<void> {
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
