/**
 * The Wisp mark: the spirit itself.
 *
 * THE IDEA. Wisp is a companion that follows the work through, drawn as the
 * thing its name is: a will-o'-the-wisp, a small flame spirit lit from inside.
 * The old mark held that flame in a violet glass icosahedron; this one lets it
 * out. It has a face because it is a companion, and only two eyes because a
 * calm face is the whole personality: no mouth, no brows.
 *
 * ONE SILHOUETTE, S1. A round, calm base and a tongue of flame swept back as if
 * it were moving, with a small second flick on the right shoulder. The sweep and
 * the flick are what keep it from reading as a drop of water: a drop is
 * symmetric and has one point.
 *
 * TWO RENDERINGS of one character. From 64px up the spirit is 3D: a raymarched
 * model, lit from inside, its top a real flame that licks and sheds sparks. Those
 * renders are source art in brand/source/, made outside this repository, and
 * build.ts only composes them. Below 64px the 3D turns to a glowing blob, so
 * everything small is THIS file: S1 as flat shapes, a body and two eyes. (A
 * lighter heart low in the flat body was tried and read as a muzzle; the light
 * from inside belongs to the 3D and to the vector spirit below.)
 *
 * Everything is in S1's own 256-unit drawing space and fitted into any square,
 * as absolute M/L/C/Z path data only, so the same shapes feed SVG, the React
 * component and the Finder icon's PDF without an arc or a transform anywhere.
 */

import { ADVANCE, GLYPHS, METRICS, UPEM } from "./wordmark-data";

/**
 * The violet material. `brand` is `--primary` from web/src/index.css; the
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

/** Palette for everything that is not the spirit itself. */
export const PALETTE = {
  violet: VIOLET.brand,
  /** `--background`: the void the app is painted on */
  ink: "#0b0b0d",
  /** the ground of the 3D renders in brand/source/, and the plate the app icons sit on */
  plate: "#0e0d13",
  /** `--foreground`: the wordmark on a dark ground */
  paper: "#eaeaee",
  /** the wordmark on a light ground */
  inkText: "#18181b",
  /** the eyes: near-black, a breath of violet so they belong to the body */
  eye: "#120d1c",
} as const;

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

/**
 * The flat body colour. Not `brand` itself: one favicon serves a dark tab bar
 * and a white one, and #AF87F1 is a pale smudge on white. A third of the way
 * down toward `mid` holds on both.
 */
export const BODY = mix(VIOLET.brand, VIOLET.mid, 0.36);

// ── S1, in its own drawing space ─────────────────────────────────────────────

/** The silhouette, in 256 units. Absolute M/C/Z only. */
const S1 =
  "M 124 222 C 88 222 60 196 60 158 C 60 120 84 100 90 72 C 94 54 88 40 74 26 " +
  "C 116 34 136 62 136 96 C 146 90 158 84 170 74 C 184 100 192 126 192 158 C 192 194 162 222 124 222 Z";
/** S1's ink box: what gets fitted into a square. */
const BOX = { x0: 60, y0: 26, x1: 192, y1: 222 } as const;
/** The eyes: two upright pills, set where the round base is widest. */
const EYES = [108, 146] as const;
const EYE = { cy: 152, w: 16, h: 28 } as const;
/** Bézier approximation of a quarter circle. */
const KAPPA = 0.5523;

type Pt = [number, number];
type Seg = { op: "M" | "L" | "C" | "Z"; pts: Pt[] };

function parseS1(d: string): Seg[] {
  const segs: Seg[] = [];
  for (const m of d.matchAll(/([MLCZ])([^MLCZ]*)/g)) {
    const nums = (m[2].match(/-?[\d.]+/g) ?? []).map(Number);
    const pts: Pt[] = [];
    for (let i = 0; i < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
    segs.push({ op: m[1] as Seg["op"], pts });
  }
  return segs;
}

/** An upright pill (a stadium) as four quarter-circle Béziers and two lines. */
function pill(cx: number, cy: number, w: number, h: number): Seg[] {
  const r = w / 2;
  const k = Math.max(0, h / 2 - r);
  const q = r * KAPPA;
  return [
    { op: "M", pts: [[cx - r, cy - k]] },
    { op: "C", pts: [[cx - r, cy - k - q], [cx - q, cy - k - r], [cx, cy - k - r]] },
    { op: "C", pts: [[cx + q, cy - k - r], [cx + r, cy - k - q], [cx + r, cy - k]] },
    { op: "L", pts: [[cx + r, cy + k]] },
    { op: "C", pts: [[cx + r, cy + k + q], [cx + q, cy + k + r], [cx, cy + k + r]] },
    { op: "C", pts: [[cx - q, cy + k + r], [cx - r, cy + k + q], [cx - r, cy + k]] },
    { op: "Z", pts: [] },
  ];
}

export type Fit = {
  /** the square's side, in output units */
  size: number;
  /** empty space around S1's ink box, as a fraction of the side */
  margin?: number;
  /** decimals in the emitted path data */
  precision?: number;
};

/** Map S1's drawing space into a square: height-limited, centred. */
function fitter(fit: Fit): (p: Pt) => Pt {
  const margin = fit.margin ?? 0.04;
  const height = BOX.y1 - BOX.y0;
  const width = BOX.x1 - BOX.x0;
  const scale = (fit.size * (1 - margin * 2)) / height;
  const ox = (fit.size - width * scale) / 2 - BOX.x0 * scale;
  const oy = (fit.size - height * scale) / 2 - BOX.y0 * scale;
  return ([x, y]) => [ox + x * scale, oy + y * scale];
}

function emitPath(segs: Seg[], map: (p: Pt) => Pt, precision: number): string {
  const n = (v: number): string => {
    const s = v.toFixed(precision);
    return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
  };
  return segs
    .map(({ op, pts }) => (op === "Z" ? "Z" : op + pts.map((p) => map(p).map(n).join(" ")).join(" ")))
    .join("");
}

export type Shape = { d: string; fill: string };

export type MarkOpts = Fit & {
  /** body colour; BODY unless a monochrome use asks otherwise */
  body?: string;
  /** eye colour; on a monochrome mark, the ground the eyes are cut to */
  eyes?: string;
  /** eye size relative to S1's; small renders need them a little larger to stay open */
  eyeScale?: number;
};

/** The flat mark's shapes, painted in order: body, then eyes. */
export function markShapes(opts: MarkOpts): Shape[] {
  const map = fitter(opts);
  const p = opts.precision ?? 2;
  const k = opts.eyeScale ?? 1;
  const shapes: Shape[] = [{ d: emitPath(parseS1(S1), map, p), fill: opts.body ?? BODY }];
  const eyes = EYES.map((cx) => pill(cx, EYE.cy, EYE.w * k, EYE.h * k)).flat();
  shapes.push({ d: emitPath(eyes, map, p), fill: opts.eyes ?? PALETTE.eye });
  return shapes;
}

const shapePath = (s: Shape, indent = ""): string => `${indent}<path d="${s.d}" fill="${s.fill}"/>`;

/** The flat mark alone, on a transparent ground. */
export function markSvg(opts: Partial<MarkOpts> & { label?: string } = {}): string {
  const size = opts.size ?? 64;
  const body = markShapes({ ...opts, size })
    .map((s) => shapePath(s, "  "))
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${opts.label ?? "Wisp"}">
${body}
</svg>
`;
}

/**
 * The favicon: the flat mark, emitted as tightly as an SVG can be, because this
 * one is inlined into web/index.html as a data URI and every byte ships in the
 * bundle. At 16px the eyes would close, so they are a little larger, and the
 * margin is almost nothing: every pixel of a tab icon is spent on the spirit.
 */
export function faviconSvg(): string {
  const size = 32;
  const body = markShapes({ size, margin: 0.02, precision: 1, eyeScale: 1.3 })
    .map((s) => shapePath(s))
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${body}</svg>`;
}

/**
 * The favicon as a data URI, for inlining into the app's <head>.
 *
 * Both web and Desktop builds inline this favicon in the HTML head, so it
 * needs no extra asset request. Kept unencoded apart
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

// ── the vector spirit: lit from inside ───────────────────────────────────────

export type SpiritOpts = Fit & {
  /** a soft halo behind the body: glows on the void, prints as a smudge on white */
  bloom?: number;
  /** "dark" keeps the 3D's light violet; "light" carries it down so it holds on paper */
  ground?: "dark" | "light";
  /** prefix for gradient ids; distinct per emitted file (see the lockups) */
  id?: string;
};

/**
 * S1 in vector with the 3D's light: a heart low and forward, glow around it,
 * the body colour at the edge. For wherever a flat mark is too little and a
 * raster is not wanted (an SVG on GitHub, a doc). The 3D renders stay the hero.
 */
export function spiritBody(o: SpiritOpts): { defs: string; body: string } {
  const map = fitter(o);
  const p = o.precision ?? 2;
  const id = o.id ?? "s";
  const light = o.ground === "light";
  const edge = light ? VIOLET.mid : mix(VIOLET.brand, VIOLET.mid, 0.3);
  const glow = light ? VIOLET.brand : VIOLET.light;
  const core = light ? VIOLET.light : VIOLET.white;
  const [hx, hy] = map([124, 190]);
  const [, top] = map([0, BOX.y0]);
  const [, bottom] = map([0, BOX.y1]);
  const r = ((bottom - top) * 0.62).toFixed(2);
  let defs =
    `<radialGradient id="${id}-heart" gradientUnits="userSpaceOnUse" cx="${hx.toFixed(2)}" cy="${hy.toFixed(2)}" r="${r}">` +
    `<stop offset="0" stop-color="${core}"/><stop offset="0.3" stop-color="${glow}"/><stop offset="1" stop-color="${edge}"/></radialGradient>`;
  let halo = "";
  if (o.bloom) {
    // centred in the square and inside it: a halo that runs past the viewBox is
    // cut off in a visible square on the ground behind it
    const cx = o.size / 2;
    const cy = o.size / 2;
    const hr = (o.size / 2 - 0.5).toFixed(2);
    defs +=
      `<radialGradient id="${id}-halo" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${hr}">` +
      `<stop offset="0" stop-color="${VIOLET.brand}" stop-opacity="${(o.bloom * 5).toFixed(3)}"/><stop offset="1" stop-color="${VIOLET.brand}" stop-opacity="0"/></radialGradient>`;
    halo = `<circle cx="${cx}" cy="${cy}" r="${hr}" fill="url(#${id}-halo)"/>`;
  }
  const eyes = EYES.map((cx) => pill(cx, EYE.cy, EYE.w, EYE.h)).flat();
  const body =
    halo +
    `<path d="${emitPath(parseS1(S1), map, p)}" fill="url(#${id}-heart)"/>` +
    `<path d="${emitPath(eyes, map, p)}" fill="${PALETTE.eye}"/>`;
  return { defs: `<defs>${defs}</defs>`, body };
}

export function spiritSvg(o: Partial<SpiritOpts> = {}): string {
  const size = o.size ?? 96;
  const { defs, body } = spiritBody({ ...o, size });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Wisp">${defs}${body}</svg>
`;
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
  /** bloom behind the spirit — leave unset for light grounds */
  bloom?: number;
  /** which ground the spirit's light is tuned for */
  ground?: "dark" | "light";
  /**
   * Prefix for the spirit's gradient ids. Distinct per emitted file: the two
   * lockups are separate documents on GitHub, but anyone inlining both into one
   * page would otherwise have the second one's gradients resolve to the first
   * one's definitions.
   */
  id?: string;
};

/**
 * Mark + wordmark, horizontally.
 *
 * S1 is taller than it is wide and its flame leans left, so the mark's square
 * carries air on the right; the gap is tighter than the old hexagon's to keep
 * the word from drifting away from it. See the alignment note inside.
 */
export function lockupSvg(opts: LockupOpts = {}): string {
  const markSize = 100;
  const em = markSize * (opts.fontRatio ?? 0.56);
  const gap = markSize * (opts.gap ?? 0.04);
  const tracking = (opts.tracking ?? -0.02) * UPEM;
  const scale = em / UPEM;

  // Optical, not metric. "Wisp" starts with a capital, so the mass reaches the
  // cap line; centring on x-height would leave the mark visibly low. The band is
  // the cap band, nudged 4% for the descender hanging below the baseline.
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

  const spirit = spiritBody({ size: markSize, margin: 0.02, bloom: opts.bloom, ground: opts.ground, id: opts.id ?? "m" });
  const width = inkRight;
  const height = opts.height ?? markSize;
  const wordmark = `<path d="${glyphs.join("")}" fill="${opts.fg ?? PALETTE.paper}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(2)} ${markSize}" width="${Math.round((width * height) / markSize)}" height="${height}" role="img" aria-label="Wisp">${spirit.defs}${spirit.body}${wordmark}</svg>
`;
}
