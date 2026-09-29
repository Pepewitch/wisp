/** A process with the daemon's crash guards that then fails the way argv[2] names. */
import { installDaemonCrashGuards } from "../../src/crash-guard";

installDaemonCrashGuards();
if (process.argv[2] === "rejection") {
  void (async () => {
    throw new Error("a stray rejection");
  })();
} else {
  setTimeout(() => {
    throw new Error("a stray throw");
  }, 0);
}
setTimeout(() => console.log("still serving"), 200);
