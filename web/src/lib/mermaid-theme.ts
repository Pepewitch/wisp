import type { Theme } from "@/lib/theme"

/**
 * Wisp's palette, in the one form mermaid accepts.
 *
 * Mermaid computes its colours at render time and bakes them into the SVG, so
 * a diagram cannot take a CSS token the way every other surface in the app
 * does. Its stock themes are the only alternative, and stock `dark` paints
 * near-black nodes with grey borders and grey labels on a near-black canvas:
 * one lightness, no hue, nothing separating a node from the surface it sits
 * on. A page whose whole job is showing structure rendered as a flat sheet.
 *
 * These values mirror the `--diagram-*` tokens in `index.css`, which is the
 * source `theme-palette.test.ts` checks them against. They are duplicated
 * here rather than read from the document because mermaid needs them as
 * strings, before layout, in a call that must also work under a test renderer
 * with no CSS engine at all.
 *
 * What the palette is doing, in both themes:
 *
 * - A node is defined by its BORDER, not its fill. That is what makes the
 *   stock light theme legible and the stock dark theme flat, and it is the
 *   one structural idea copied from mermaid rather than replaced: a violet
 *   outline at hue 300 with a barely-tinted fill behind it.
 * - Hue 300 is the app's own, and the node border is the only thing that
 *   spends it. It sits at chroma 0.085 (dark) — below syntax's 0.09 and far
 *   below the accent's 0.155 — so a diagram never out-colours the send button
 *   or the running dot, which is the rule every other hue in the app follows.
 * - The node fill stops below `--card`. A prompt bubble is the brightest
 *   surface a turn may contain, and a diagram is inside a turn.
 * - Everything else stays neutral, and mostly stays an EXISTING token. A
 *   subgraph is `--surface` outlined in `--border-strong` — a panel, drawn by
 *   its edge, exactly like every other grouping in the app; a first attempt
 *   gave it a fill of its own below the canvas and it read as a hole punched
 *   in the diagram. Edges, notes and loop frames are the app's greys too,
 *   because a chart where every part is coloured says the same thing as a
 *   chart where none of it is.
 */
const DIAGRAM = {
  dark: {
    canvas: "#1b1b20", // --code, the surface the viewer already paints
    node: "#251d32", // --diagram-node
    nodeBorder: "#7c699f", // --diagram-node-border
    group: "#19191d", // --surface, a panel behind the nodes
    groupBorder: "#3f3f48", // --border-strong, which is what draws the group
    line: "#837f8b", // --diagram-line
    text: "#eaeaee", // --foreground
    secondaryText: "#b5b5bf", // --fg-secondary
    note: "#222228", // --card
    noteBorder: "#3f3f48", // --border-strong
  },
  light: {
    canvas: "#f1f1f5",
    node: "#f0e9ff",
    nodeBorder: "#8766bb",
    group: "#f6f6f9",
    groupBorder: "#cdcdd8",
    line: "#827e8b",
    text: "#1a1a1f",
    secondaryText: "#4f4f5a",
    note: "#ededf2",
    noteBorder: "#cdcdd8",
  },
} as const satisfies Record<Theme, Record<string, string>>

/** The `--diagram-*` tokens this file mirrors, for the palette test. */
export const DIAGRAM_TOKENS = ["--diagram-node", "--diagram-node-border", "--diagram-line"] as const

export const diagramColour = (theme: Theme, name: keyof (typeof DIAGRAM)["dark"]): string => DIAGRAM[theme][name]

/**
 * `themeVariables` for `theme: "base"`, which is mermaid's own instruction for
 * "derive everything from what I give you" rather than a palette to fight.
 *
 * Flowcharts, sequence diagrams and state diagrams each read a different
 * subset of these names, and the three overlap only partly — so every family
 * a fence can produce is named explicitly instead of trusting `primaryColor`
 * to reach all of them. Anything not listed is derived by mermaid from the
 * primaries, which is why those come first.
 */
export function mermaidThemeVariables(theme: Theme): Record<string, string | boolean> {
  const colour = DIAGRAM[theme]
  return {
    darkMode: theme === "dark",
    background: colour.canvas,

    // the primaries, which mermaid derives the rest of a diagram from
    primaryColor: colour.node,
    primaryTextColor: colour.text,
    primaryBorderColor: colour.nodeBorder,
    secondaryColor: colour.group,
    secondaryTextColor: colour.text,
    secondaryBorderColor: colour.groupBorder,
    tertiaryColor: colour.note,
    tertiaryTextColor: colour.secondaryText,
    tertiaryBorderColor: colour.noteBorder,
    lineColor: colour.line,
    textColor: colour.text,

    // flowchart
    mainBkg: colour.node,
    nodeBorder: colour.nodeBorder,
    nodeTextColor: colour.text,
    clusterBkg: colour.group,
    clusterBorder: colour.groupBorder,
    titleColor: colour.text,
    edgeLabelBackground: colour.canvas,
    defaultLinkColor: colour.line,

    // sequence
    actorBkg: colour.node,
    actorBorder: colour.nodeBorder,
    actorTextColor: colour.text,
    actorLineColor: colour.line,
    signalColor: colour.line,
    signalTextColor: colour.text,
    labelBoxBkgColor: colour.node,
    labelBoxBorderColor: colour.nodeBorder,
    labelTextColor: colour.text,
    loopTextColor: colour.secondaryText,
    noteBkgColor: colour.note,
    noteBorderColor: colour.noteBorder,
    noteTextColor: colour.text,
    activationBkgColor: colour.node,
    activationBorderColor: colour.nodeBorder,
    sequenceNumberColor: colour.canvas,

    // state, and the striped rows a composite state draws
    altBackground: colour.group,
    compositeBackground: colour.group,
    compositeTitleBackground: colour.group,
    compositeBorder: colour.groupBorder,
    labelColor: colour.text,
    transitionColor: colour.line,
    transitionLabelColor: colour.secondaryText,
    stateLabelColor: colour.text,
    stateBkg: colour.node,
  }
}
