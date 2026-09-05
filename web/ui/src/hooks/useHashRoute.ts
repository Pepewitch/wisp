import { useEffect, useState } from "react";

/**
 * The daemon serves the bundle at exactly one route (GET /app), so routing is
 * hash-based: /app#/ is the app, /app#/gallery is the living conventions
 * surface. Both survive reload without extra daemon routes.
 */
export function useHashRoute(): string {
  const [route, setRoute] = useState(current);
  useEffect(() => {
    const onChange = () => setRoute(current());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

function current(): string {
  return window.location.hash.replace(/^#/, "") || "/";
}
