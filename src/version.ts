/** The Wisp release identity. Keep this equal to package.json. */
export const VERSION = "0.4.0-alpha.6";

/*
 * The binary build injects these constants with Bun's --define. Source runs
 * deliberately report an unknown, dirty build instead of borrowing the
 * checkout's current Git state at runtime and pretending that it was compiled
 * from it.
 */
declare const __WISP_BUILD_COMMIT__: string | undefined;
declare const __WISP_BUILD_DIRTY__: boolean | undefined;

export const BUILD_COMMIT =
  typeof __WISP_BUILD_COMMIT__ === "string" && __WISP_BUILD_COMMIT__.length > 0
    ? __WISP_BUILD_COMMIT__
    : "unknown";
export const BUILD_DIRTY = typeof __WISP_BUILD_DIRTY__ === "boolean" ? __WISP_BUILD_DIRTY__ : true;

export interface BuildInfo {
  version: string;
  commit: string;
  dirty: boolean;
}

export const BUILD_INFO: Readonly<BuildInfo> = Object.freeze({
  version: VERSION,
  commit: BUILD_COMMIT,
  dirty: BUILD_DIRTY,
});

/** Compact human-readable identity; use BUILD_INFO for machine comparisons. */
export function versionLine(): string {
  return `${VERSION} (commit ${BUILD_COMMIT}${BUILD_DIRTY ? ", dirty" : ""})`;
}
