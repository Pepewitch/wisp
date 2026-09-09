import type { ProjectSearch } from "@/hooks/useProjectSearch"

/** A closed search, for the many Sidebar tests that are not about searching. */
export function inertProjectSearch(overrides: Partial<ProjectSearch> = {}): ProjectSearch {
  return {
    open: false,
    query: "",
    daemonQuery: "",
    focusToken: 0,
    activeId: null,
    request: () => {},
    close: () => {},
    setQuery: () => {},
    setHits: () => {},
    move: () => {},
    commit: () => {},
    ...overrides,
  }
}
