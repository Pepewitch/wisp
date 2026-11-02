/**
 * How PUT /api/repos/order refuses an order built from a list that has since
 * changed (a project added or removed). The daemon writes it and the web
 * recognises it, so the two cannot drift apart; the route adds the detail in
 * parentheses after it.
 */
export const STALE_ORDER = "The project list changed since it was loaded. Reload and try again.";
