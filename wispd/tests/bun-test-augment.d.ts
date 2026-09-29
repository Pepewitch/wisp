// Bun's runner accepts the options before the body, `test(name, { timeout }, fn)`,
// and honors that timeout (Bun 1.4), but its declarations only describe the
// options-last form. This adds the options-first call so the suite can be
// typechecked without rewriting every such test.
import type { TestOptions } from "bun:test";

declare module "bun:test" {
  interface Test<T extends ReadonlyArray<unknown>> {
    (label: string, options: number | TestOptions, fn: (...args: T) => void | Promise<unknown>): void;
  }
}
