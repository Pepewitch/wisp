/**
 * The Finder icon for a `wisp` binary, as a PDF.
 *
 * macOS identifies an unbundled executable in Privacy & Security ▸ App
 * Management by its file icon, and a bare Mach-O has none, so every release
 * and every local build lands in that list as an identical unlabelled row.
 * `scripts/macos/stamp-icon.sh` attaches one of these; the accumulation itself
 * is explained in docs/MACOS-APP-MANAGEMENT.md.
 *
 * PDF rather than PNG, and written by hand rather than rendered, for one
 * reason: the slot that decides whether this works is a ~16px Settings row,
 * where a downscaled raster is mush and a vector is not. It also keeps these
 * two assets off the headless-Chrome path the rest of brand/ depends on, so
 * they regenerate anywhere `bun` runs.
 *
 * The drawing is the flat reduction on the same rounded plate the macOS app
 * icon uses — below roughly 24px the lantern's translucency falls under a
 * pixel, which is the whole point of the reduction. See mark.ts.
 */

import { markFacets, PALETTE, VIOLET } from "./mark";

/** Apple's 1024pt icon grid, as proportions: an 824pt plate, 185pt radius. */
const PLATE = { inset: 0.0977, radius: 0.2237, mark: 0.58 } as const;
/** Bézier approximation of a quarter circle. */
const KAPPA = 0.5523;
const SIZE = 512;

const n = (value: number): string => {
  const fixed = value.toFixed(3);
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
};

/** `#rrggbb` as a PDF non-stroking colour operator. */
function fill(hex: string): string {
  const channel = (at: number) => n(parseInt(hex.slice(at, at + 2), 16) / 255);
  return `${channel(1)} ${channel(3)} ${channel(5)} rg`;
}

/** The plate: a rounded rectangle, inset inside a transparent square. */
function plate(ground: string): string {
  const inset = SIZE * PLATE.inset;
  const side = SIZE - inset * 2;
  const r = side * PLATE.radius;
  const k = r * KAPPA;
  const [x0, y0] = [inset, inset];
  const [x1, y1] = [inset + side, inset + side];
  return [
    fill(ground),
    `${n(x0 + r)} ${n(y0)} m`,
    `${n(x1 - r)} ${n(y0)} l`,
    `${n(x1 - r + k)} ${n(y0)} ${n(x1)} ${n(y0 + r - k)} ${n(x1)} ${n(y0 + r)} c`,
    `${n(x1)} ${n(y1 - r)} l`,
    `${n(x1)} ${n(y1 - r + k)} ${n(x1 - r + k)} ${n(y1)} ${n(x1 - r)} ${n(y1)} c`,
    `${n(x0 + r)} ${n(y1)} l`,
    `${n(x0 + r - k)} ${n(y1)} ${n(x0)} ${n(y1 - r + k)} ${n(x0)} ${n(y1 - r)} c`,
    `${n(x0)} ${n(y0 + r)} l`,
    `${n(x0)} ${n(y0 + r - k)} ${n(x0 + r - k)} ${n(y0)} ${n(x0 + r)} ${n(y0)} c`,
    "f",
  ].join("\n");
}

/** `M…L…Z` polygons out of geometry.ts, as PDF path operators. */
function facetPath(d: string): string {
  const points = d
    .replace(/Z$/, "")
    .split(/(?=[ML])/)
    .map((step) => step.slice(1).split(" ").map(Number));
  return points.map(([x, y], i) => `${n(x)} ${n(y)} ${i ? "l" : "m"}`).join("\n");
}

function body(ground: string, flat?: string): { content: string; alphas: number[] } {
  const markSize = (SIZE - SIZE * PLATE.inset * 2) * PLATE.mark;
  const offset = (SIZE - markSize) / 2;
  const facets = markFacets({ size: markSize, flat, precision: 2 });
  const alphas = [...new Set(facets.map((f) => f.opacity ?? 1))];
  const lines = [plate(ground), "q", `1 0 0 1 ${n(offset)} ${n(offset)} cm`];
  for (const facet of facets) {
    lines.push(`/GS${alphas.indexOf(facet.opacity ?? 1)} gs`, fill(facet.fill), facetPath(facet.d), "f");
  }
  lines.push("Q");
  return { content: lines.join("\n"), alphas };
}

/** Assemble the objects into a cross-referenced, byte-stable PDF document. */
function document(content: string, alphas: number[]): string {
  const states = alphas.map((a, i) => `/GS${i} << /ca ${n(a)} /Type /ExtGState >>`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${SIZE} ${SIZE}] ` +
      `/Group << /S /Transparency /CS /DeviceRGB >> ` +
      `/Resources << /ExtGState << ${states} >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return pdf;
}

/**
 * One icon per install. Production wears the mark on the void, the same plate
 * Wisp Desktop's icon uses, so a stamped binary sits on the app's own grid.
 * Development inverts the ground — the separation the two lockups already
 * make — because at a Settings row's size the ground is the only thing that
 * carries at a glance.
 */
export function cliIconPdf(variant: "prod" | "dev"): string {
  // PDF's origin is bottom-left and the mark's is top-left; flip once, around
  // the page, and every coordinate below is the geometry module's own.
  const { content, alphas } =
    variant === "dev" ? body(VIOLET.white, VIOLET.deep) : body(PALETTE.ink);
  const flipped = `q\n1 0 0 -1 0 ${SIZE} cm\n${content}\nQ`;
  return document(flipped, alphas);
}
