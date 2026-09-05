// Root lint for src/, tests/ and scripts/ (the owner-named housekeeping item:
// only web/ui had a linter). Mirrors web/ui's strictness minus the react
// plugins, plus the globals a Bun daemon actually has. The rule deltas below
// are deliberate and documented — tune by editing HERE, not by sprinkling
// eslint-disable comments.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import { productionMaintainabilityRules, testMaintainabilityRules } from "./eslint-maintainability.js";

export default defineConfig([
  globalIgnores(["dist", "web", "node_modules", "coverage", ".worktrees"]),
  {
    files: ["{src,tests,scripts}/**/*.ts"],
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
    files: ["tests/**/*.ts"],
    rules: {
      // A suite is an executable specification. Keep a generous ceiling that
      // stops indefinite growth without forcing unrelated cases apart.
      ...testMaintainabilityRules,
    },
  },
]);
