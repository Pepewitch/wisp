// Root lint for repository scripts/tests and the wispd package. Mirrors the
// web package's strictness minus the react
// plugins, plus the globals a Bun daemon actually has. The rule deltas below
// are deliberate and documented — tune by editing HERE, not by sprinkling
// eslint-disable comments.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import { productionMaintainabilityRules, testMaintainabilityRules } from "./eslint-maintainability.js";

// A route parses a request, calls a domain operation, and maps its result to
// HTTP. Writing task state belongs to wispd/src/domain/ (or the runner and
// store modules it calls), so the store's mutators, and raw SQL through `db`,
// stay out of wispd/src/routes/.
const STORE_WRITES = [
  "db",
  "createTask",
  "setTaskFields",
  "setTaskContextFields",
  "switchTaskAgent",
  "switchTaskAgentBody",
  "transition",
  "reconcileTaskState",
  "createTurn",
  "finishTurn",
  "settleTurn",
  "setTurnInterrupt",
  "setTurnModel",
  "setTurnUsage",
  "setTurnCaptureCheckpoint",
  "setTurnKillDetail",
  "setTurnDiagnosticCheckpoint",
  "markDelivered",
  "markDead",
  "markAttempt",
  "createTaskMessage",
  "createTaskMessageWithAgent",
  "updateQueuedTaskMessage",
  "releaseTaskMessageHold",
  "cancelQueuedTaskMessage",
  "claimTaskMessageForSteering",
  "claimTaskMessageForStart",
  "releaseTaskMessageClaim",
  "releaseOrphanedTaskMessageClaims",
  "markTaskMessageDelivered",
];
// Routes that still write directly, and the names they still use. This is
// the debt left to move into domain/, not a precedent: shrink it as each
// operation moves, never grow it.
const ROUTE_STORE_WRITE_DEBT = {
  "wispd/src/routes/tasks.ts": ["setTaskFields", "setTaskContextFields", "switchTaskAgent"],
  "wispd/src/routes/task-messages.ts": ["cancelQueuedTaskMessage", "updateQueuedTaskMessage"],
  "wispd/src/routes/cleanup.ts": ["db"],
};
function routeStoreWrites(allowed = []) {
  return [
    "error",
    {
      paths: ["../store", "../store-messages", "../store-database"].map((name) => ({
        name,
        importNames: STORE_WRITES.filter((write) => !allowed.includes(write)),
        message: "routes change task state through a wispd/src/domain/ operation, not the store directly",
      })),
    },
  ];
}

export default defineConfig([
  globalIgnores(["dist", "web", "node_modules", "coverage", ".worktrees"]),
  {
    files: ["{bench,scripts,tests,wispd/src,wispd/tests,wispd/scripts}/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node, Bun: "readonly" },
    },
    rules: {
      // Wire data is deliberately untyped: adapters parse a harness's JSON
      // stream, and Record<string, any> at that boundary is the honest type.
      // New code should still prefer unknown + narrowing away from the wire.
      "@typescript-eslint/no-explicit-any": "off",
      // Tests assert on thrown MESSAGE STRINGS (thrownMessage helper); the
      // wrapper keeps the throw inside the expect callback.
      "@typescript-eslint/no-floating-promises": "off",
      // The codebase's style is `const enum`-free but switch-exhaustive; keep
      // the two bans that catch real bugs in this codebase's idiom.
      "no-console": "off", // the CLI's whole job is printing
      "eqeqeq": ["error", "smart"],
      "no-implicit-coercion": "error",
      "no-unused-vars": "off", // the ts variant below is the one that runs
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      ...productionMaintainabilityRules,
    },
  },
  {
    // What the CLI prints is mostly text Wisp did not write — an agent's
    // answer, a harness's stderr, a branch name — so it goes out through
    // cli-print.ts, which strips the terminal control sequences such text can
    // carry. cli-help.ts prints only Wisp's own words.
    files: ["wispd/src/cli*.ts"],
    ignores: ["wispd/src/cli-print.ts", "wispd/src/cli-help.ts"],
    rules: { "no-console": "error" },
  },
  { files: ["wispd/src/routes/**/*.ts"], rules: { "no-restricted-imports": routeStoreWrites() } },
  ...Object.entries(ROUTE_STORE_WRITE_DEBT).map(([file, allowed]) => ({
    files: [file],
    rules: { "no-restricted-imports": routeStoreWrites(allowed) },
  })),
  {
    // The dependency points one way: a domain operation never knows it was a request.
    files: ["wispd/src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["**/routes", "**/routes/*"], message: "domain operations are HTTP-free; routes call domain/, never the reverse" }] },
      ],
    },
  },
  {
    files: ["{tests,wispd/tests}/**/*.ts"],
    rules: {
      // A suite is an executable specification. Keep a generous ceiling that
      // stops indefinite growth without forcing unrelated cases apart.
      ...testMaintainabilityRules,
    },
  },
]);
