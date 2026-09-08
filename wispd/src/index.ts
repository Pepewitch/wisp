#!/usr/bin/env bun
import { wispCommand } from "./command";

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
  } else if (args[0] === "serve") {
    const { serve } = await import("./daemon");
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
  // already names the file and field — print it, don't bury it in a stack trace
  console.error(`${wispCommand()}: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
