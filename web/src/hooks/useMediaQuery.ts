import { useSyncExternalStore } from "react";

/**
 * S3.6: the ONE breakpoint. Tailwind's `md` is min-width 768px, so the
 * collapsed layout is everything below it, plus short landscape phones with
 * coarse input. The switch is JS-driven rather
 * than `md:` hiding classes on purpose: below the breakpoint the resizable
 * pane groups must UNMOUNT (a CSS-hidden group would still restore and
 * persist geometry — app-panes.tsx), and CSS can't unmount.
 */
export const MOBILE_MEDIA_QUERY = "(max-width: 767px), (pointer: coarse) and (max-width: 1023px) and (max-height: 500px)";

/** Reactive media-query match. jsdom has no matchMedia — tests stub it. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    // no SSR (the app is a client-only SPA) — desktop is the safe default
    () => false,
  );
}

export const COARSE_POINTER_MEDIA_QUERY = "(pointer: coarse)";

/**
 * Whether the primary input is a finger. Read once, not watched: a device does
 * not grow a mouse mid-session, and this is deliberately NOT a width — the
 * mobile shell also covers a 720px Desktop window, which has a real keyboard
 * and must keep the shortcuts that go with one. Guarded, because a headless
 * DOM has no `matchMedia` at all.
 */
export function hasCoarsePointer(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(COARSE_POINTER_MEDIA_QUERY).matches
  );
}

/** The mobile shell replaces the grid on narrow windows and landscape phones. */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_MEDIA_QUERY);
}
