/**
 * Sentinel values a RADIO menu uses to carry a verb.
 *
 * base-ui will not register a plain Item beside a RadioGroup — arrow keys skip
 * it and its onClick never fires — so actions ride as VALUES the caller
 * recognises in onValueChange. A sentinel never equals real state, so it never
 * renders a checkmark.
 *
 * Its own module because a component file that also exports constants breaks
 * fast refresh (react-refresh/only-export-components).
 */
export const MENU_ACTION = { custom: "@@custom", reprobe: "@@reprobe" } as const;
