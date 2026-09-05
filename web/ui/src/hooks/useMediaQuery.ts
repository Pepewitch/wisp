import { useSyncExternalStore } from "react";

/**
 * S3.6: the ONE breakpoint. Tailwind's `md` is min-width 768px, so the
 * collapsed layout is everything below it. The switch is JS-driven rather
 * than `md:` hiding classes on purpose: below the breakpoint the resizable
 * pane groups must UNMOUNT (a CSS-hidden group would still restore and
 * persist geometry — app-panes.tsx), and CSS can't unmount.
 */
export const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

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

/** True below the md breakpoint: the mobile shell replaces the three-pane grid. */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_MEDIA_QUERY);
}
