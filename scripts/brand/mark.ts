/**
 * The Wisp mark: a spirit held in violet glass.
 *
 * THE IDEA. An icosahedron of violet glass, seen down a 3-fold axis so its
 * silhouette is a hard hexagon. Its faces are translucent, so the far side and
 * the edges behind it show through; its edges are traced in LIGHT, never in
 * black. Inside it burns a flame — taller than wide and sitting a little high,
 * because a symmetric glow reads as a lamp and an asymmetric one reads as alive.
 *
 * That flame is the wisp. The solid is only the vessel: a will-o'-the-wisp is a
 * light in the dark, and the mark is that light, contained.
 *
 * THE MATERIAL is violet, full stop. Not graphite with a violet accent — the
 * greys in this project are the dark theme, not the brand. Facets are separated
 * by tone and gradient alone; there is not one black line in the mark, because a
 * dark seam reads as folded cardboard while a bright one reads as light caught
 * on an edge.
 *
 * TWO FORMS. `lanternSvg` is the hero: translucency, luminous edges, the flame,
 * an optional bloom. `markSvg` is its reduction for small sizes — flat fills, no
 * filters, no strokes. Both are the same solid on the same axis, and both put
 * their brightest tone at the centre, so the reduction still reads as lit from
 * inside. See the note on REDUCTION below; getting that mapping wrong is what
 * turns a violet mark into a pale smudge at 16px.
 */

import {
  EDGES,
  VERTICES,
  pathOf,
  project,
  viewTransform,
  type Facet,
  type V2,
  type ViewOpts,
} from "./geometry";
import { ADVANCE, GLYPHS, METRICS, UPEM } from "./wordmark-data";

/**
 * The violet material. `brand` is `--primary` from web/ui/src/index.css; the
 * rest are that hue carried down to near-black and up to near-white, so the
 * whole ramp moves together if the hue ever does.
 */
export const VIOLET = {
  abyss: "#1B0F33",
  deep: "#3A1D6E",
  mid: "#6D3FC0",
  brand: "#AF87F1",
  light: "#D4BBFA",
  white: "#F4ECFF",
} as const;

/** Palette for everything that is not the solid itself. */
export const PALETTE = {
  violet: VIOLET.brand,
  /** `--background`: the void the app is painted on */
  ink: "#0b0b0d",
  /** `--foreground`: the wordmark on a dark ground */
  paper: "#eaeaee",
  /** the wordmark on a light ground */
  inkText: "#18181b",
} as const;

const RAMP = [VIOLET.abyss, VIOLET.deep, VIOLET.mid, VIOLET.brand, VIOLET.light, VIOLET.white];

const channels = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** Linear blend of two hex colours; `t` is clamped. */
export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = channels(a);
  const [r2, g2, b2] = channels(b);
  const k = Math.max(0, Math.min(1, t));
  const c = (x: number, y: number): string =>
    Math.round(x + (y - x) * k)
      .toString(16)
      .padStart(2, "0");
  return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`;
}

/** Sample the violet ramp at `t` in 0..1. */
export function ramp(t: number): string {
  const k = Math.max(0, Math.min(0.9999, t)) * (RAMP.length - 1);
  const i = Math.floor(k);
  return mix(RAMP[i], RAMP[i + 1], k - i);
}

const centreOf = (polygon: V2[]): V2 =>
  polygon.reduce<V2>((a, p) => [a[0] + p[0] / polygon.length, a[1] + p[1] / polygon.length], [0, 0]);

// ── the hero: the lantern ────────────────────────────────────────────────────

/** Opacities and strengths of the hero form. */
export const LANTERN = {
  /** front faces — translucent enough to show the far side through them */
  shell: 0.62,
  /** the far side, seen through the front */
  backing: 0.5,
  /** edges facing us */
  edgeFront: 0.62,
  /** edges behind, dimmer, so depth reads */
  edgeBack: 0.3,
  /** the flame */
  core: 1,
  coreSize: 0.32,
  /** ambient added to every lambert term */
  ambient: 0.1,
  /** specular strength */
  specular: 1,
} as const;

export type LanternOpts = ViewOpts & {
  size?: number;
  margin?: number;
  /** outer bloom radius as a fraction of size. 0 on light grounds — see below. */
  bloom?: number;
  /** unique id prefix, so two lanterns can share one document */
  id?: string;
  precision?: number;
};

/**
 * The lantern's markup, without the `<svg>` wrapper, so the lockup can drop it
 * beside the wordmark in one document.
 *
 * On `bloom`: a blurred violet halo behind the solid is what makes it glow on a
 * dark ground, and on a white one the same halo reads as a printing artifact. So
 * it is a parameter, not a constant, and the light-ground assets ship with it at
 * zero rather than hunting for one value that suits both.
 */
export function lanternBody(o: LanternOpts & { size: number }): { defs: string; body: string } {
  const size = o.size;
  const p = o.precision ?? 2;
  const id = o.id ?? "w";
  const view: ViewOpts = { axis: o.axis ?? "face", roll: o.roll, tilt: o.tilt };
  const { facets, silhouette, vertexLight, toScreen } = project({
    ...view,
    size,
    margin: o.margin ?? 0.06,
  });

  const defs: string[] = [];
  const under: string[] = [];
  const mid: string[] = [];
  const over: string[] = [];

  if (o.bloom) {
    defs.push(
      `<filter id="${id}bl" x="-90%" y="-90%" width="280%" height="280%">` +
        `<feGaussianBlur stdDeviation="${(size * o.bloom).toFixed(2)}"/></filter>`,
    );
    under.push(
      `<path d="${pathOf(silhouette, p)}" fill="${VIOLET.brand}" filter="url(#${id}bl)" opacity="0.5"/>`,
    );
  }

  // the far side first — this is what you see THROUGH the front faces
  for (const f of facets.filter((x) => !x.front)) {
    const tone = mix(VIOLET.abyss, VIOLET.mid, 0.25 + f.lambert * 0.4);
    mid.push(`<path d="${pathOf(f.polygon, p)}" fill="${tone}" opacity="${LANTERN.backing}"/>`);
  }

  // Edges, split into the ones facing us and the ones behind. The far ones are
  // laid down before the front faces cover them, which is what sells the glass.
  const xf = viewTransform(view);
  const screenVerts = VERTICES.map((v) => toScreen(xf(v)));
  const edgeIsFront = (a: number, b: number): boolean =>
    facets.some((f) => f.front && f.tri.includes(a) && f.tri.includes(b));

  const backEdges: string[] = [];
  const frontEdges: string[] = [];
  for (const [a, b] of EDGES) {
    const pa = screenVerts[a];
    const pb = screenVerts[b];
    const d = `M${pa[0].toFixed(p)} ${pa[1].toFixed(p)}L${pb[0].toFixed(p)} ${pb[1].toFixed(p)}`;
    (edgeIsFront(a, b) ? frontEdges : backEdges).push(d);
  }
  if (backEdges.length > 0) {
    mid.push(
      `<path d="${backEdges.join("")}" stroke="${VIOLET.mid}" stroke-width="${(size * 0.006).toFixed(2)}" fill="none" opacity="${LANTERN.edgeBack}"/>`,
    );
  }

  // the flame, seen through the shell
  defs.push(
    `<radialGradient id="${id}core">` +
      `<stop offset="0" stop-color="${VIOLET.white}"/>` +
      `<stop offset="0.30" stop-color="${VIOLET.light}"/>` +
      `<stop offset="0.62" stop-color="${VIOLET.brand}" stop-opacity="0.45"/>` +
      `<stop offset="1" stop-color="${VIOLET.brand}" stop-opacity="0"/></radialGradient>`,
  );
  const cr = LANTERN.coreSize * size;
  mid.push(
    `<ellipse cx="${(size / 2).toFixed(1)}" cy="${(size * 0.455).toFixed(1)}"` +
      ` rx="${(cr * 0.74).toFixed(1)}" ry="${(cr * 1.12).toFixed(1)}"` +
      ` fill="url(#${id}core)" opacity="${LANTERN.core}"/>`,
  );

  // the front faces, translucent, each with its own gradient
  for (const f of facets.filter((x) => x.front)) {
    mid.push(
      `<path d="${pathOf(f.polygon, p)}" fill="${facetGradient(f, vertexLight, defs, `${id}f${f.index}`)}" opacity="${LANTERN.shell}"/>`,
    );
  }

  if (frontEdges.length > 0) {
    over.push(
      `<path d="${frontEdges.join("")}" stroke="${VIOLET.light}" stroke-width="${(size * 0.007).toFixed(2)}" stroke-linecap="round" fill="none" opacity="${LANTERN.edgeFront}"/>`,
    );
  }

  return {
    defs: defs.length > 0 ? `<defs>${defs.join("")}</defs>` : "",
    body: under.join("") + mid.join("") + over.join(""),
  };
}

/**
 * A facet's fill: a gradient between its darkest and brightest corner, using the
 * smooth vertex normals. This is what replaced the outlines — adjacent facets
 * differ in tone along their shared edge, so the edge reads without anything
 * being drawn on it.
 */
function facetGradient(f: Facet, vertexLight: number[], defs: string[], gid: string): string {
  const base = Math.min(1, f.lambert + LANTERN.ambient);
  const corners = f.tri.map((k) => base * 0.45 + vertexLight[k] * 0.55);
  let lo = 0;
  let hi = 0;
  corners.forEach((c, k) => {
    if (c < corners[lo]) lo = k;
    if (c > corners[hi]) hi = k;
  });
  const a = f.polygon[lo];
  const b = f.polygon[hi];
  const cold = ramp(Math.max(0, Math.min(1, corners[lo])));
  const hot = mix(
    ramp(Math.max(0, Math.min(1, corners[hi]))),
    "#ffffff",
    Math.min(0.85, f.specular * LANTERN.specular),
  );
  defs.push(
    `<linearGradient id="${gid}" gradientUnits="userSpaceOnUse"` +
      ` x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}">` +
      `<stop offset="0" stop-color="${cold}"/><stop offset="1" stop-color="${hot}"/></linearGradient>`,
  );
  return `url(#${gid})`;
}

/** The lantern as a standalone SVG. */
export function lanternSvg(o: LanternOpts = {}): string {
  const size = o.size ?? 96;
  const { defs, body } = lanternBody({ ...o, size });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Wisp">${defs}${body}</svg>
`;
}

// ── the reduction ───────────────────────────────────────────────────────────

/**
 * Tone mapping for the small form, and the numbers that matter most in this file.
 *
 * The obvious mapping — lambert straight onto the ramp — climbs most facets to
 * near-white, and at 16px the mark becomes a pale smudge that disappears on
 * paper. So lambert is squeezed into a NARROW BAND low in the ramp: the mark
 * stays unmistakably violet, with deep violet shadows and highlights that stop
 * short of white.
 *
 * `centre` then boosts facets near the middle of the silhouette, which puts the
 * brightest tone where the hero's flame is. That is how the reduction keeps the
 * lit-from-inside read using flat fills only — no overlay, no filter, nothing
 * that turns to mush when it is four pixels wide.
 */
const REDUCTION = { lo: 0.1, hi: 0.55, centre: 0.26 } as const;

export type MarkOpts = ViewOpts & {
  size?: number;
  margin?: number;
  precision?: number;
  /**
   * Monochrome mode: every facet takes THIS colour, separated by opacity
   * instead of tone. One opaque fill for all ten would erase the facet
   * boundaries and leave a plain hexagon, so the tone ramp becomes an alpha
   * ramp — which survives on a background this generator cannot know about.
   */
  flat?: string;
};

const FLAT_ALPHA = { floor: 0.3, ceiling: 1 } as const;

/** The reduction's facets, painted back to front. */
export function markFacets(opts: MarkOpts = {}): { d: string; fill: string; opacity?: number }[] {
  const size = opts.size ?? 64;
  const { facets } = project({
    size,
    axis: opts.axis ?? "face",
    roll: opts.roll,
    tilt: opts.tilt,
    margin: opts.margin ?? 0.05,
  });
  const front = facets.filter((f) => f.front);

  const middle: V2 = [size / 2, size / 2];
  const distances = front.map((f) => {
    const c = centreOf(f.polygon);
    return Math.hypot(c[0] - middle[0], c[1] - middle[1]);
  });
  const furthest = Math.max(...distances) || 1;

  return front.map((f, i) => {
    const nearness = 1 - distances[i] / furthest;
    const t = REDUCTION.lo + (REDUCTION.hi - REDUCTION.lo) * f.lambert + REDUCTION.centre * nearness;
    const d = pathOf(f.polygon, opts.precision ?? 2);
    if (opts.flat) {
      const alpha =
        FLAT_ALPHA.floor +
        (FLAT_ALPHA.ceiling - FLAT_ALPHA.floor) * Math.max(0, Math.min(1, t / 0.8));
      return { d, fill: opts.flat, opacity: Number(alpha.toFixed(3)) };
    }
    return { d, fill: ramp(t) };
  });
}

const facetPath = (f: { d: string; fill: string; opacity?: number }, indent = ""): string =>
  `${indent}<path d="${f.d}" fill="${f.fill}"${f.opacity === undefined ? "" : ` opacity="${f.opacity}"`}/>`;

/** The reduction alone, on a transparent ground. */
export function markSvg(opts: MarkOpts & { label?: string } = {}): string {
  const size = opts.size ?? 64;
  const body = markFacets(opts)
    .map((f) => facetPath(f, "  "))
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${opts.label ?? "Wisp"}">
${body}
</svg>
`;
}

/**
 * The favicon: the reduction, emitted as tightly as an SVG can be, because this
 * one is inlined into web/ui/index.html as a data URI and every byte ships in
 * the bundle. One decimal is already sub-pixel at 32px.
 */
export function faviconSvg(): string {
  const size = 32;
  const body = markFacets({ size, precision: 1 })
    .map((f) => facetPath(f))
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${body}</svg>`;
}

/**
 * The favicon as a data URI, for inlining into the app's <head>.
 *
 * The daemon serves ONE file and no asset routes (tests/web.test.ts), so the
 * favicon cannot be a sibling file — it rides in the head. Kept unencoded apart
 * from the characters that would break the attribute: an un-escaped `#`
 * truncates the URI and `<`/`>`/`"` end the tag. Percent-encoding the whole
 * thing would cost ~35% more bytes for nothing.
 */
export function faviconDataUri(svgText: string): string {
  const escaped = svgText
    .replace(/%/g, "%25")
    .replace(/#/g, "%23")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E")
    .replace(/"/g, "'");
  return `data:image/svg+xml,${escaped}`;
}

// ── the lockup ──────────────────────────────────────────────────────────────

type Cmd = { op: string; args: number[] };

/** Parse the outline data from wordmark-data.ts (absolute M/L/Q/C/Z only). */
function parse(d: string): Cmd[] {
  const out: Cmd[] = [];
  const re = /([MLQCZ])([^MLQCZ]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) {
    out.push({ op: m[1], args: (m[2].match(/-?[\d.]+/g) ?? []).map(Number) });
  }
  return out;
}

/**
 * Bake an affine transform into the coordinates instead of emitting a
 * `transform` attribute: the logo ships to GitHub, whose SVG sanitiser is a
 * moving target, and plain absolute paths are the one thing nothing rewrites.
 */
function place(cmds: Cmd[], originX: number, baseline: number, scale: number, precision = 2): string {
  const point = (x: number, y: number): string =>
    `${(originX + x * scale).toFixed(precision)} ${(baseline - y * scale).toFixed(precision)}`;
  return cmds
    .map(({ op, args }) => {
      if (op === "Z") return "Z";
      const pairs: string[] = [];
      for (let i = 0; i < args.length; i += 2) pairs.push(point(args[i], args[i + 1]));
      return op + pairs.join(" ");
    })
    .join("");
}

export type LockupOpts = {
  /** rendered height in px; the viewBox is always 100 tall */
  height?: number;
  /** wordmark colour — PALETTE.paper on dark grounds, PALETTE.inkText on light */
  fg?: string;
  /** em size as a fraction of the mark's height (0.56 pairs with the capital) */
  fontRatio?: number;
  /** gap between mark and wordmark, as a fraction of the mark's height */
  gap?: number;
  /** tracking as a fraction of the em; Geist at display size wants it tight */
  tracking?: number;
  /** bloom behind the solid — leave unset for light grounds */
  bloom?: number;
  /** carry the flat reduction instead of the lantern */
  reduced?: boolean;
  /**
   * Prefix for the lantern's gradient and filter ids. Distinct per emitted file:
   * the two lockups are separate documents on GitHub, but anyone inlining both
   * into one page would otherwise have the second one's gradients resolve to the
   * first one's definitions.
   */
  id?: string;
};

/**
 * Mark + wordmark, horizontally.
 *
 * "Wisp" is a wider word than "wisp" was — the capital adds ~140 units of
 * advance and a lot of ink at the top left — so the em comes down slightly and
 * the gap stays tight, keeping the mark from looking like a bullet point beside
 * it. See the alignment note inside.
 */
export function lockupSvg(opts: LockupOpts = {}): string {
  const markSize = 100;
  const em = markSize * (opts.fontRatio ?? 0.56);
  const gap = markSize * (opts.gap ?? 0.2);
  const tracking = (opts.tracking ?? -0.02) * UPEM;
  const scale = em / UPEM;

  // Optical, not metric. With a lowercase word the x-height band was the right
  // thing to centre on; "Wisp" starts with a capital, so the mass now reaches
  // the cap line and centring on x-height leaves the mark visibly low. The band
  // is the cap band, nudged 4% for the descender hanging below the baseline.
  const band = METRICS.capHeight * scale * 1.04;
  const baseline = markSize / 2 + band / 2;
  const originX = markSize + gap;

  let inkRight = originX;
  const glyphs = GLYPHS.map((g, i) => {
    const x = originX + (g.x + tracking * i) * scale;
    inkRight = Math.max(inkRight, x + g.maxX * scale);
    return place(parse(g.d), x, baseline, scale);
  });
  void ADVANCE; // the ink box, not the advance, sets the viewBox — trailing space would be uneven

  let defs = "";
  let markBody: string;
  if (opts.reduced) {
    markBody = markFacets({ size: markSize })
      .map((f) => facetPath(f))
      .join("");
  } else {
    const lantern = lanternBody({ size: markSize, bloom: opts.bloom, id: opts.id ?? "m" });
    defs = lantern.defs;
    markBody = lantern.body;
  }

  const width = inkRight;
  const height = opts.height ?? markSize;
  const wordmark = `<path d="${glyphs.join("")}" fill="${opts.fg ?? PALETTE.paper}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(2)} ${markSize}" width="${Math.round((width * height) / markSize)}" height="${height}" role="img" aria-label="Wisp">${defs}${markBody}${wordmark}</svg>
`;
}
