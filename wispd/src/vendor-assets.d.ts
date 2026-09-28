declare module "*.js" {
  const source: string;
  export default source;
}

declare module "*.gz" {
  const path: string;
  export default path;
}

// The web build generates this module after typechecking on a clean checkout.
// Its literal file imports are verified by the build and embedded by Bun.
declare module "*web-dist/embedded-assets" {
  export const embeddedWebAssets: Record<string, string>;
  export const embeddedWebCompressedAssets: Record<string, string>;
}

declare module "*.css" {
  const source: string;
  export default source;
}

declare module "*.png" {
  const path: string;
  export default path;
}
declare module "*.svg" {
  const source: string;
  export default source;
}
