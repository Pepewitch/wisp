#!/usr/bin/env bun
import { wispCommand } from "./command";
import { controlFree } from "./control-free";

export {};

const args = process.argv.slice(2);

try {
  if (args[0] === "__pty-exec") {
    // The child half of src/pty.ts, and deliberately the FIRST branch: this
    // process exists only to take a pty as its controlling terminal and
    // execve() the user's shell over itself. Loading config or the CLI here
    // would run daemon code inside what is about to become the shell.
    const { runPtyExec } = await import("./pty");
    runPtyExec(args.slice(1));
  }
  // Help, usage and unknown commands are answered before config: importing
  // config.ts creates a home, and `<command> --help` must never run the
  // command — `update --help` would install, `serve --help` would serve.
  const help = await import("./cli-help");
  const answer = help.offlineAnswer(args);
  if (answer) help.respond(answer);
  if (args[0] === "doctor" && args.includes("--storage")) {
    // Bypass CLI/config imports: this diagnostic must not initialize a home.
    const { parseArgs } = await import("./cli-args");
    const { doctorCommand } = await import("./cli-doctor");
    const { positional, flags } = parseArgs(args.slice(1));
    if (positional.length) throw new Error("doctor --storage does not take positional arguments");
    await doctorCommand(flags);
  } else if (args[0] === "serve") {
    const [{ installDaemonCrashGuards }, { serve }] = await Promise.all([import("./crash-guard"), import("./daemon")]);
    // Before serve(): recovery starts detached work too.
    installDaemonCrashGuards();
    await serve();
  } else if (args[0] === "version" || args[0] === "--version") {
    // Keep identity inspection pure. Importing the full CLI initializes
    // WISP_HOME through config.ts, which made `wisp version` fail in a
    // read-only home before it could identify the binary.
    const { BUILD_INFO, versionLine } = await import("./version");
    console.log(args.slice(1).includes("--json") ? JSON.stringify(BUILD_INFO) : versionLine());
  } else {
    const { cli } = await import("./cli");
    await cli(args);
  }
} catch (e) {
  // config/adapters validation throws here at boot (a prior audit): the message
  // already names the file and field — print it, don't bury it in a stack trace.
  // It can also carry the daemon's words, so it is made terminal-safe.
  console.error(controlFree(`${wispCommand()}: ${e instanceof Error ? e.message : e}`));
  process.exit(1);
}
