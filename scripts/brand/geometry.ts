/**
 * A regular icosahedron — 12 vertices, 30 edges, 20 triangular faces — and an
 * orthographic projection of it.
 *
 * Derived rather than typed: vertices from the golden-ratio coordinate set,
 * faces found by plane scan. Every edge comes out the same length (asserted
 * below), which is the property a hand-placed triangle set never quite has.
 *
 * Why an icosahedron and not the dodecahedron this started as: face count is not
 * what made the old mark read as a ball — small facets were. Twenty large
 * triangles seen down the right axis give a hard hexagonal silhouette and a
 * handful of big planes, which is the angular read a pile of little pentagons
 * could not hold.
 */

export type V3 = [number, number, number];
export type V2 = [number, number];

const PHI = (1 + Math.sqrt(5)) / 2;

export const dotProduct = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const subtract = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const crossProduct = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const unitVector = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** The 12 vertices: three mutually perpendicular golden rectangles. */
export const VERTICES: V3[] = (() => {
  const v: V3[] = [];
  for (const a of [-1, 1]) {
    for (const b of [-PHI, PHI]) {
      v.push([0, a, b]);
      v.push([a, b, 0]);
      v.push([b, 0, a]);
    }
  }
  return v;
})();

/**
 * The 20 triangular faces, by plane scan: every vertex triple spans a plane, and
 * a face is a plane with exactly three vertices on it and all twelve on one side
 * of it. Winding is CCW about the outward normal so no path self-crosses.
 */
export const FACES: readonly number[][] = (() => {
  const out: number[][] = [];
  const seen = new Set<string>();
  const n = VERTICES.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        const raw = crossProduct(
          subtract(VERTICES[j], VERTICES[i]),
          subtract(VERTICES[k], VERTICES[i]),
        );
        if (Math.hypot(raw[0], raw[1], raw[2]) < 1e-9) continue; // collinear
        let normal = unitVector(raw);
        let offset = dotProduct(normal, VERTICES[i]);
        if (offset < 0) {
          normal = [-normal[0], -normal[1], -normal[2]];
          offset = -offset;
        }
        if (offset < 1e-9) continue; // plane through the centre
        let on = 0;
        let poking = false;
        for (let m = 0; m < n; m++) {
          const d = dotProduct(normal, VERTICES[m]);
          if (Math.abs(d - offset) < 1e-9) on++;
          else if (d > offset) {
            poking = true;
            break;
          }
        }
        if (poking || on !== 3) continue;
        const key = normal.map((c) => c.toFixed(6)).join(",");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(windCcw([i, j, k], normal));
      }
    }
  }
  if (out.length !== 20) throw new Error(`derived ${out.length} faces, expected 20`);
  return out;
})();

function windCcw(tri: number[], normal: V3): number[] {
  const centre: V3 = [0, 1, 2].map(
    (d) => tri.reduce((a, m) => a + VERTICES[m][d], 0) / tri.length,
  ) as V3;
  const u = unitVector(subtract(VERTICES[tri[0]], centre));
  const w = crossProduct(normal, u);
  const angle = (m: number): number => {
    const d = subtract(VERTICES[m], centre);
    return Math.atan2(dotProduct(d, w), dotProduct(d, u));
  };
  return tri.slice().sort((a, b) => angle(a) - angle(b));
}

export const FACE_NORMALS: readonly V3[] = FACES.map((tri) => {
  const n = unitVector(
    crossProduct(subtract(VERTICES[tri[1]], VERTICES[tri[0]]), subtract(VERTICES[tri[2]], VERTICES[tri[0]])),
  );
  const centre: V3 = [0, 1, 2].map((d) => tri.reduce((a, m) => a + VERTICES[m][d], 0) / 3) as V3;
  return dotProduct(n, centre) > 0 ? n : ([-n[0], -n[1], -n[2]] as V3);
});

/**
 * The 30 edges, as vertex-index pairs. The mark traces these in light, so they
 * are derived once here rather than rediscovered per face (which would draw the
 * shared ones twice and make every edge look randomly double-bright).
 */
export const EDGES: readonly [number, number][] = (() => {
  const seen = new Map<string, [number, number]>();
  for (const tri of FACES) {
    for (let i = 0; i < 3; i++) {
      const a = tri[i];
      const b = tri[(i + 1) % 3];
      const key = [a, b].sort((x, y) => x - y).join("-");
      if (!seen.has(key)) seen.set(key, [Math.min(a, b), Math.max(a, b)]);
    }
  }
  const out = [...seen.values()];
  if (out.length !== 30) throw new Error(`derived ${out.length} edges, expected 30`);
  return out;
})();

/** Every edge is the same length in a regular solid — the cheap proof we built one. */
{
  const lengths = new Set<string>();
  for (const [a, b] of EDGES) {
    lengths.add(
      Math.hypot(
        VERTICES[a][0] - VERTICES[b][0],
        VERTICES[a][1] - VERTICES[b][1],
        VERTICES[a][2] - VERTICES[b][2],
      ).toFixed(9),
    );
  }
  if (lengths.size !== 1) throw new Error(`irregular solid: ${lengths.size} distinct edge lengths`);
}

/**
 * The symmetry axes worth aiming at the camera.
 *
 * `face` is the one the mark uses. Down a 3-fold axis the silhouette is a
 * hexagon and the visible edges form a triangular star around a central
 * triangle — a structure that still reads as an icosahedron when it is small.
 * `edge` also gives a hexagon but its edges cross the middle as a horizontal
 * seam, which reads as two halves stuck together. `vertex` gives a decagon: the
 * roundest of the three, and the one to avoid.
 */
export const AXES = {
  /** 3-fold, through a face centre — hexagonal silhouette, 10 faces visible */
  face: FACE_NORMALS[0],
  /** 2-fold, through an edge midpoint — hexagonal silhouette, 8 faces visible */
  edge: unitVector([
    (VERTICES[EDGES[0][0]][0] + VERTICES[EDGES[0][1]][0]) / 2,
    (VERTICES[EDGES[0][0]][1] + VERTICES[EDGES[0][1]][1]) / 2,
    (VERTICES[EDGES[0][0]][2] + VERTICES[EDGES[0][1]][2]) / 2,
  ]),
  /** 5-fold, through a vertex — decagonal silhouette, 10 faces visible */
  vertex: VERTICES[0],
} as const;

/** Rotation carrying `from` onto `to`, for aiming a symmetry axis at the camera. */
function alignment(from: V3, to: V3): (v: V3) => V3 {
  const f = unitVector(from);
  const t = unitVector(to);
  const d = dotProduct(f, t);
  if (d > 1 - 1e-12) return (v) => v;
  if (d < -1 + 1e-12) return (v) => [-v[0], -v[1], -v[2]];
  const axis = unitVector(crossProduct(f, t));
  const angle = Math.acos(Math.max(-1, Math.min(1, d)));
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // Rodrigues' rotation
  return (v) => {
    const cv = crossProduct(axis, v);
    const dv = dotProduct(axis, v);
    return [
      v[0] * c + cv[0] * s + axis[0] * dv * (1 - c),
      v[1] * c + cv[1] * s + axis[1] * dv * (1 - c),
      v[2] * c + cv[2] * s + axis[2] * dv * (1 - c),
    ];
  };
}

export type ViewOpts = {
  axis?: keyof typeof AXES;
  /** spin about the view axis, in radians */
  roll?: number;
  /** tilt about screen x, in radians, applied after the roll */
  tilt?: number;
};

/** The single rotation every renderer here shares, so none of them drift apart. */
export function viewTransform(o: ViewOpts): (v: V3) => V3 {
  const align = alignment(AXES[o.axis ?? "face"], [0, 0, 1]);
  const ct = Math.cos(o.tilt ?? 0);
  const st = Math.sin(o.tilt ?? 0);
  const cr = Math.cos(o.roll ?? 0);
  const sr = Math.sin(o.roll ?? 0);
  return (v) => {
    const [ax, ay, az] = align(v);
    const x = ax * cr - ay * sr;
    const y = ax * sr + ay * cr;
    return [x, y * ct - az * st, y * st + az * ct];
  };
}

/** Direction the light arrives FROM. One light, shared by every form. */
export const LIGHT: V3 = [-0.4, 0.66, 0.64];

export type Facet = {
  /** index into FACES */
  index: number;
  /** the face's three vertex indices */
  tri: readonly number[];
  /** screen-space polygon, SVG coordinates (y down) */
  polygon: V2[];
  /** lambert term against the light, 0..1 */
  lambert: number;
  /** Blinn-Phong specular term, 0..1 */
  specular: number;
  /** mean z — larger is nearer the camera */
  depth: number;
  /** true when the facet points at the camera */
  front: boolean;
};

export type ProjectOpts = ViewOpts & {
  /** viewBox extent; the solid is fitted inside it */
  size: number;
  /** fraction of `size` kept clear around the silhouette */
  margin?: number;
  /** specular exponent */
  shine?: number;
};

/**
 * Project the solid. Returns EVERY facet, front and back, painted back to front
 * — the back ones matter because the mark is translucent and you see them
 * through the front. Filter on `.front` for an opaque render.
 */
export function project(o: ProjectOpts): {
  facets: Facet[];
  silhouette: V2[];
  /** per-vertex lambert using smooth (sphere) normals — for gradient corners */
  vertexLight: number[];
  toScreen: (v: V3) => V2;
} {
  const xf = viewTransform(o);
  const verts = VERTICES.map(xf);
  const normals = FACE_NORMALS.map((n) => unitVector(xf(n)));
  const extent = Math.max(...verts.flatMap(([x, y]) => [Math.abs(x), Math.abs(y)]));
  const scale = ((o.size / 2) * (1 - (o.margin ?? 0.05))) / extent;
  const toScreen = (v: V3): V2 => [o.size / 2 + v[0] * scale, o.size / 2 - v[1] * scale];

  const L = unitVector(LIGHT);
  const half = unitVector([L[0], L[1], L[2] + 1]); // the view direction is (0,0,1)
  const shine = o.shine ?? 14;

  const facets: Facet[] = FACES.map((tri, index) => ({
    index,
    tri,
    polygon: tri.map((k) => toScreen(verts[k])),
    lambert: Math.max(0, dotProduct(normals[index], L)),
    specular: Math.pow(Math.max(0, dotProduct(normals[index], half)), shine),
    depth: tri.reduce((a, k) => a + verts[k][2], 0) / 3,
    front: normals[index][2] > 1e-9,
  })).sort((a, b) => a.depth - b.depth);

  // Smooth normals: for a solid this round, the vertex direction is a good
  // enough normal, and lighting a flat triangle at its corners is what makes it
  // read as a curved plane instead of a paper cut-out.
  const vertexLight = VERTICES.map((v) => Math.max(0, dotProduct(unitVector(xf(unitVector(v))), L)));

  return { facets, silhouette: hull(verts.map(toScreen)), vertexLight, toScreen };
}

/** Convex hull (monotone chain) — the projected silhouette. */
function hull(points: V2[]): V2[] {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const turn = (o: V2, a: V2, b: V2): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const chain = (src: V2[]): V2[] => {
    const st: V2[] = [];
    for (const q of src) {
      while (st.length >= 2 && turn(st[st.length - 2], st[st.length - 1], q) <= 1e-9) st.pop();
      st.push(q);
    }
    return st;
  };
  return chain(p).slice(0, -1).concat(chain(p.slice().reverse()).slice(0, -1));
}

/** A polygon as an SVG path, rounded to `precision` decimals. */
export function pathOf(polygon: V2[], precision = 2): string {
  return (
    polygon
      .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(precision)} ${y.toFixed(precision)}`)
      .join("") + "Z"
  );
}
