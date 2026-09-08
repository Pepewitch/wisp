export type WispCommand = "wisp" | "wisp-dev";

/**
 * User-facing command name for this process. Only the repository launcher may
 * opt into wisp-dev; arbitrary environment text never reaches command hints.
 */
export function wispCommand(env: NodeJS.ProcessEnv = process.env): WispCommand {
  return env.WISP_COMMAND_NAME === "wisp-dev" ? "wisp-dev" : "wisp";
}
