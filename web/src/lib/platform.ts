type PlatformNavigator = Pick<Navigator, "platform" | "userAgent" | "maxTouchPoints">

/**
 * An iPhone, iPod or iPad. iPadOS Safari reports itself as a Mac, so a "Mac"
 * with a multi-touch screen is an iPad.
 */
export function isIOS(nav: PlatformNavigator | undefined = globalThis.navigator): boolean {
  if (!nav) return false
  return /iPad|iPhone|iPod/.test(nav.userAgent || "") ||
    (nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1)
}
