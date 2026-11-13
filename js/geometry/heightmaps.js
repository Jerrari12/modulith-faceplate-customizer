// Height maps for 3D textures: functions of a point that return a height between 0 and 1, in units of the
// texture's feature size (one cell, bump or repeat is about 1 unit across). The grid mesher samples them; the maps
// with edges are built exactly by cells.js, which shares these maps' sites, settings and profiles, so a point
// function and its exact mesh describe the same relief. Everything is deterministic from the seed, so a texture
// looks the same on every size and every reload.

export const HEIGHT_MAPS = [
  ['crystal', 'Crystal'], ['pebbles', 'Pebbles'], ['noise', 'Noise'], ['hammered', 'Hammered'], ['knurl', 'Knurl'],
  ['hexdome', 'Hex domes'], ['weave', 'Weave'], ['bricks', 'Bricks'], ['wood', 'Wood'], ['ripple', 'Ripples'],
  ['fluted', 'Fluted'], ['reeded', 'Reeded'], ['studs', 'Studs'], ['dimples', 'Dimples'], ['scales', 'Scales'],
  ['blocks', 'Blocks'], ['tread', 'Tread plate'], ['picture', 'Picture'],
];
export const SEEDED_MAPS = ['crystal', 'pebbles', 'noise', 'hammered', 'wood', 'bricks', 'hexdome', 'scales'];

// ---- each map's own settings (stored on the element as texParams, like a pattern's params)
const pct = (key, label, def, help, extra = {}) => ({ key, label, type: 'number', min: 0, max: 100, step: 1, unit: '%', default: def, help, ...extra });
const PROFILES = [['round', 'Round'], ['v', 'V'], ['flat', 'Flat']];
export const TEXTURE_PARAMS = {
  crystal: [
    pct('irregular', 'Irregularity', 80, 'At 0 the facets make an even honeycomb; at 100 every cell wanders.'),
    pct('tilt', 'Facet tilt', 65, 'At 0 each facet lies level, a field of stepped cells; at 100 they tilt steeply.'),
    pct('vary', 'Height variation', 55, 'How much the cells differ in height.'),
  ],
  pebbles: [
    pct('irregular', 'Irregularity', 80, 'At 0 the stones make an even honeycomb; at 100 every stone wanders.'),
    pct('gap', 'Gap', 0, 'Flat ground between the stones, as a share of a stone.', { max: 40 }),
    pct('round', 'Roundness', 55, 'How far in from its edge a stone keeps rising: low makes flat-topped slabs, high makes domes.', { min: 10 }),
    pct('vary', 'Height variation', 20, 'How much the stones differ in height.'),
  ],
  hexdome: [
    { key: 'profile', label: 'Profile', type: 'select', options: [['dome', 'Dome'], ['cone', 'Cone'], ['mesa', 'Mesa'], ['dimple', 'Dimple']], default: 'dome', help: 'Round domes, pointed cones, flat-topped mesas, or dimples sunk into the surface.' },
    pct('gap', 'Gap', 0, 'Flat ground between the cells, as a share of a cell.', { max: 40 }),
    pct('vary', 'Height variation', 0, 'How much the cells differ in height.'),
  ],
  bricks: [
    { key: 'bond', label: 'Bond', type: 'select', options: [['running', 'Running'], ['third', 'Third'], ['stack', 'Stacked'], ['herringbone', 'Herringbone'], ['basket', 'Basket weave']], default: 'running', help: 'How the bricks are laid: rows offset by half or a third, stacked straight, zigzag herringbone, or pairs turned alternately.' },
    { key: 'length', label: 'Brick length', type: 'select', options: [['2', '2 to 1'], ['3', '3 to 1'], ['4', '4 to 1']], default: '2', help: 'A brick\'s length against its height (the feature size).' },
    pct('gap', 'Mortar', 12, 'The joint between bricks, as a share of a brick\'s height.', { min: 2, max: 40 }),
    pct('chamfer', 'Chamfer', 16, 'The sloped edge round each brick, as a share of its height.', { max: 40 }),
    pct('vary', 'Height variation', 15, 'How much the bricks differ in height.'),
  ],
  knurl: [
    { key: 'angle', label: 'Groove angle', type: 'number', min: 15, max: 75, step: 1, unit: 'deg', default: 30, help: 'Each set of grooves leans this far from vertical; 45 makes square diamonds.' },
    pct('flat', 'Flat tops', 0, 'Cut the pyramids off flat, leaving this share of each diamond as a plateau.', { max: 80 }),
  ],
  weave: [{ key: 'strands', label: 'Strands', type: 'select', options: [['2', '2'], ['3', '3'], ['4', '4']], default: '3', help: 'Strands in each block of the weave.' }],
  noise: [pct('rough', 'Roughness', 50, 'Low is smooth rolling hills; high adds fine grain.')],
  fluted: [
    { key: 'profile', label: 'Profile', type: 'select', options: PROFILES, default: 'round', help: 'The groove\'s cross-section: a round channel, a V, or a flat-bottomed slot.' },
    pct('gap', 'Land', 15, 'Flat face left between the grooves, as a share of the repeat.', { max: 60 }),
  ],
  reeded: [
    { key: 'profile', label: 'Profile', type: 'select', options: PROFILES, default: 'round', help: 'The bead\'s cross-section: round, a V ridge, or a flat-topped bar.' },
    pct('gap', 'Land', 0, 'Flat face left between the beads, as a share of the repeat.', { max: 60 }),
  ],
  studs: [
    pct('size', 'Stud size', 60, 'A stud\'s width as a share of the spacing.', { min: 20, max: 95 }),
    { key: 'profile', label: 'Profile', type: 'select', options: [['dome', 'Dome'], ['button', 'Button'], ['cone', 'Cone']], default: 'dome', help: 'Round domes, flat-topped buttons, or pointed cones.' },
    { key: 'staggered', label: 'Staggered rows', type: 'bool', default: false },
  ],
  dimples: [
    pct('size', 'Dimple size', 70, 'A dimple\'s width as a share of the spacing.', { min: 20, max: 95 }),
    { key: 'profile', label: 'Profile', type: 'select', options: [['dome', 'Bowl'], ['cone', 'Cone']], default: 'dome', help: 'Round bowls or pointed cone dents.' },
    { key: 'staggered', label: 'Staggered rows', type: 'bool', default: true },
  ],
  scales: [pct('vary', 'Height variation', 15, 'How much the scales differ in height.')],
  blocks: [pct('side', 'Side depth', 70, 'How far each block\'s two side faces fall from its top: deeper reads more like cubes.', { min: 10 })],
  tread: [
    pct('length', 'Bar length', 80, 'A raised bar\'s length as a share of the spacing.', { min: 40, max: 95 }),
    pct('width', 'Bar width', 24, 'A raised bar\'s width as a share of the spacing.', { min: 10, max: 45 }),
  ],
};
export function textureDefaults(map) {
  const out = {};
  for (const p of TEXTURE_PARAMS[map] || []) out[p.key] = p.default;
  return out;
}
/** A map's settings from anything (a design file, an old element): known keys only, numbers clamped, choices checked. */
export function cleanTextureParams(map, raw) {
  const out = textureDefaults(map);
  if (!raw || typeof raw !== 'object') return out;
  for (const p of TEXTURE_PARAMS[map] || []) {
    const v = raw[p.key];
    if (v === undefined) continue;
    if (p.type === 'number') { const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN; if (Number.isFinite(n)) out[p.key] = Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, n)); }
    else if (p.type === 'select') { if (p.options.some(([o]) => o === v)) out[p.key] = v; }
    else if (p.type === 'bool') out[p.key] = !!v;
  }
  return out;
}

export function hash(seed, i, j, k = 0) {
  let h = Math.imul(seed | 0, 0x9E3779B1) ^ Math.imul(i + 7919, 0x85EBCA77) ^ Math.imul(j + 104729, 0xC2B2AE3D) ^ Math.imul(k + 31, 0x27D4EB2F);
  h = Math.imul(h ^ (h >>> 16), 0x7FEB352D); h = Math.imul(h ^ (h >>> 15), 0x846CA68B); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
const SQ3 = Math.sqrt(3);

/** The site of cell (q, r) of a hexagonal lattice one unit apart, moved up to 0.4 units by `irr` (0..1): at 0 the
 *  cells are an even honeycomb; at any setting two sites stay at least 0.2 apart, so the Voronoi cells keep three
 *  to a corner. */
export function hexSite(seed, q, r, irr) {
  const d = 0.4 * irr * Math.sqrt(hash(seed, q, r, 1)), a = 2 * Math.PI * hash(seed, q, r, 2);
  return [q + 0.5 * r + d * Math.cos(a), r * SQ3 / 2 + d * Math.sin(a)];
}
/** Profiles across one repeat, t in 0..1 (0 and 1 at the edges): a round, V or flat-topped bead of height 1. */
export function beadProfile(kind, t) {
  t = clamp01(t);
  if (kind === 'v') return 1 - Math.abs(2 * t - 1);
  if (kind === 'flat') return Math.min(1, (1 - Math.abs(2 * t - 1)) / 0.4);
  return Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2));
}

/** Smooth value noise in [0, 1] on the integer lattice. */
function valueNoise(seed, x, y) {
  const i = Math.floor(x), j = Math.floor(y), fx = fade(x - i), fy = fade(y - j);
  const a = hash(seed, i, j), b = hash(seed, i + 1, j), c = hash(seed, i, j + 1), d = hash(seed, i + 1, j + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm(seed, x, y, octaves = 4, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) { sum += amp * valueNoise(seed + o * 101, x * f, y * f); norm += amp; amp *= gain; f *= 2; }
  return sum / norm;
}

/** The nearest two sites of the jittered hex lattice: distances F1, F2 and the nearest's cell and site. */
function voronoi(seed, x, y, irr) {
  const r0 = Math.round(y / (SQ3 / 2)), q0 = Math.round(x - 0.5 * r0);
  let f1 = Infinity, f2 = Infinity, bq = 0, br = 0, bx = 0, by = 0;
  for (let dr = -2; dr <= 2; dr++) for (let dq = -2; dq <= 2; dq++) {
    const q = q0 + dq, r = r0 + dr, [px, py] = hexSite(seed, q, r, irr);
    const d = Math.hypot(x - px, y - py);
    if (d < f1) { f2 = f1; f1 = d; bq = q; br = r; bx = px; by = py; } else if (d < f2) f2 = d;
  }
  return { f1, f2, i: bq, j: br, px: bx, py: by };
}
/** The hexagon (centre q, r of the unit lattice) a point falls in. */
function hexCell(x, y) {
  const r = y / (SQ3 / 2), q = x - 0.5 * r, s = -q - r;
  let rq = Math.round(q), rr = Math.round(r);
  const rs = Math.round(s), dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs; else if (dr > ds) rr = -rq - rs;
  return [rq, rr, rq + 0.5 * rr, rr * SQ3 / 2];
}

// a point-wise copy of each exact map in cells.js (the grid fallback and the tests use these); P is the map's
// cleaned settings
const MAPS = {
  // faceted: every cell a tilted plane at its own height, so cliffs form where cells meet
  crystal(x, y, seed, P) {
    const v = voronoi(seed, x, y, P.irregular / 100), vary = P.vary / 100;
    const top = 1 - vary + vary * hash(seed, v.i, v.j, 3), th = 2 * Math.PI * hash(seed, v.i, v.j, 4);
    const k = (P.tilt / 65) * (0.35 + 0.65 * hash(seed, v.i, v.j, 5));
    return clamp01(top - k * ((x - v.px) * Math.cos(th) + (y - v.py) * Math.sin(th)));
  },
  // rounded stones with grooves between them
  pebbles(x, y, seed, P) {
    const v = voronoi(seed, x, y, P.irregular / 100), gap = P.gap / 100, round = P.round / 100, vary = P.vary / 100;
    const e = clamp01(((v.f2 - v.f1) / 2 / 0.45 - gap) / Math.max(0.05, round));
    return (1 - (1 - e) * (1 - e)) * (1 - vary + vary * hash(seed, v.i, v.j, 6));
  },
  noise(x, y, seed, P) { return clamp01((fbm(seed, x, y, 5, 0.3 + 0.4 * P.rough / 100) - 0.2) / 0.6); },
  // overlapping spherical dents, like beaten metal
  hammered(x, y, seed) {
    const ci = Math.floor(x), cj = Math.floor(y);
    let dent = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const i = ci + di, j = cj + dj, px = i + hash(seed, i, j, 7), py = j + hash(seed, i, j, 8), R = 0.55 + 0.35 * hash(seed, i, j, 9);
      const d = Math.hypot(x - px, y - py);
      if (d < R) dent = Math.max(dent, 1 - (d / R) ** 2);
    }
    return 1 - dent;
  },
  // diamond pyramids between two crossing sets of grooves
  knurl(x, y, seed, P) {
    const a = P.angle * Math.PI / 180, u = x * Math.cos(a) + y * Math.sin(a), v = x * Math.cos(a) - y * Math.sin(a);
    const tri = t => 1 - 2 * Math.abs(t - Math.floor(t) - 0.5);
    return Math.min(1, Math.min(tri(u), tri(v)) / Math.max(0.2, 1 - P.flat / 100));
  },
  // a dome on every cell of a hexagonal lattice one unit apart
  hexdome(x, y, seed, P) {
    const [q, r, cx, cy] = hexCell(x, y);
    // the ring the point is on: its distance from the centre as a share of the hexagon's own (hexagonal) radius
    const dx = x - cx, dy = y - cy;
    let f = 0;
    for (let m = 0; m < 6; m++) { const a = Math.PI / 6 + m * Math.PI / 3; f = Math.max(f, (dx * Math.cos(a - Math.PI / 6) + dy * Math.sin(a - Math.PI / 6)) / 0.5); }
    const F0 = 1 - P.gap / 100, lift = 1 - P.vary / 100 + (P.vary / 100) * hash(seed, q, r, 11);
    const t = clamp01(f / F0);
    if (P.profile === 'dimple') return f >= F0 ? 1 : 1 - Math.cos(Math.asin(t)) * lift;
    if (f >= F0) return 0;
    if (P.profile === 'cone') return (1 - t) * lift;
    if (P.profile === 'mesa') return Math.min(1, (1 - t) / 0.4) * lift;
    return Math.sqrt(1 - t * t) * lift;
  },
  // basket weave: blocks of strands, alternating across and along, each strand rising over its middle
  weave(x, y, seed, P) {
    const n = Number(P.strands) || 3, bx = Math.floor(x), by = Math.floor(y), fx = x - bx, fy = y - by;
    const across = ((bx + by) & 1) === 0;
    const s = across ? fy : fx, t = across ? fx : fy;
    const v = s * n - Math.floor(s * n);
    return Math.pow(Math.sin(Math.PI * v), 0.6) * (0.55 + 0.45 * Math.sin(Math.PI * t));
  },
  // running-bond bricks (the exact mesh also lays the other bonds)
  bricks(x, y, seed, P) {
    const L = Number(P.length) || 2, row = Math.floor(y), off = (row & 1) ? Math.floor(L / 2) : 0, col = Math.floor((x + off) / L);
    const fx = (x + off) - col * L, fy = y - row, e = Math.min(fx, L - fx, fy, 1 - fy), M = P.gap / 200, C = P.chamfer / 100;
    return clamp01((e - M) / Math.max(0.01, C)) * (1 - P.vary / 100 + (P.vary / 100) * hash(seed, col, row, 10));
  },
  // wood grain: lines running along x, swayed by slow noise
  wood(x, y, seed) {
    const w = y + 0.9 * (fbm(seed, x * 0.12, y * 0.35, 3) - 0.5) * 2.2;
    return 0.5 + 0.5 * Math.sin(2 * Math.PI * w);
  },
  ripple(x, y) { return 0.5 + 0.5 * Math.cos(2 * Math.PI * Math.hypot(x, y)); },
  // grooves (fluted) or beads (reeded) running up the texture, one a unit
  fluted(x, y, seed, P) { const g = P.gap / 100, u = x - Math.floor(x), t = (u - g / 2) / (1 - g); return t <= 0 || t >= 1 ? 1 : 1 - beadProfile(P.profile, t); },
  reeded(x, y, seed, P) { const g = P.gap / 100, u = x - Math.floor(x), t = (u - g / 2) / (1 - g); return t <= 0 || t >= 1 ? 0 : beadProfile(P.profile, t); },
  studs(x, y, seed, P) { return studHeight(x, y, P, false); },
  dimples(x, y, seed, P) { return studHeight(x, y, P, true); },
  // fish scales: each scale a disc of radius SCALE_R, rows of them one unit apart, the row above in front; a
  // scale's surface rises toward its lower edge, where it stands over the scale below
  scales(x, y, seed, P) {
    const j0 = Math.floor(y);
    for (let j = j0 + 2; j >= j0 - 2; j--) {
      const off = (j & 1) ? 1 : 0;
      // along a row the next scale lies in front of the one before it, as in the exact mesh
      for (let i = Math.floor((x - off) / 2) + 1; i >= Math.floor((x - off) / 2) - 1; i--) {
        const cx = 2 * i + off, cy = j;
        if (Math.hypot(x - cx, y - cy) <= SCALE_R) return scaleHeight(seed, i, j, y, P);
      }
    }
    return 0;
  },
  // tumbling blocks: every hexagon three rhombi, a level top and two falling sides
  blocks(x, y, seed, P) {
    const [, , cx, cy] = hexCell(x, y), a = Math.atan2(y - cy, x - cx) * 180 / Math.PI;
    const face = a >= 30 && a < 150 ? 0 : (a >= 150 || a < -90) ? 1 : 2;
    return blockHeight(face, x - cx, y - cy, P);
  },
  // diamond tread plate: raised bars, alternately turned, on a flat plate
  tread(x, y, seed, P) {
    const i = Math.floor(x), j = Math.floor(y), s = ((i + j) & 1) ? 1 : -1;
    const dx = x - i - 0.5, dy = y - j - 0.5, c = Math.SQRT1_2;
    // a diamond bar, half-diagonals L along and W across, chamfered up to a flat top over its outer 35%
    const u = (dx + s * dy) * c, v = (-s * dx + dy) * c, L = P.length / 200, W = P.width / 200;
    const e = Math.abs(u) / L + Math.abs(v) / W;
    return e >= 1 ? 0 : Math.min(1, (1 - e) / 0.35);
  },
};
export const SCALE_R = 1.137;
export function scaleHeight(seed, i, j, y, P) {
  const vary = P.vary / 100;
  return clamp01(((j + 1 - y) / (1 + SCALE_R)) * (1 - vary + vary * hash(seed, i, j, 12)));
}
/** A tumbling block's three faces (0 top, 1 left, 2 right) as planes through the hexagon's centre at height 1. */
export function blockHeight(face, dx, dy, P) {
  if (face === 0) return 1;
  // a side face is level (at 1) along its edge with the top face, from the centre to the corner at 150 (left) or 30
  // (right) degrees, and falls by `side` to its outer edge, whose corners lie 0.5 from that line (circumradius 1/sqrt3)
  const d = face === 1 ? -0.5 * dx - (SQ3 / 2) * dy : 0.5 * dx - (SQ3 / 2) * dy;
  return clamp01(1 - (P.side / 100) * d / 0.5);
}
function studHeight(x, y, P, dimple) {
  const j = Math.floor(y), off = P.staggered && (j & 1) ? 0.5 : 0, i = Math.floor(x - off);
  const d = Math.hypot(x - off - i - 0.5, y - j - 0.5), R = P.size / 200, t = clamp01(d / R);
  const prof = P.profile === 'cone' ? 1 - t : P.profile === 'button' ? Math.min(1, (1 - t) / 0.3) : Math.sqrt(1 - t * t);
  if (d >= R) return dimple ? 1 : 0;
  return dimple ? 1 - prof : prof;
}

/** A greyscale picture ({ w, h, bytes }) sampled with bilinear filtering at (u, v) in [0, 1] (v = 0 at the bottom). */
function samplePicture(pic, u, v) {
  const x = u * pic.w - 0.5, y = (1 - v) * pic.h - 0.5;
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const at = (a, b) => pic.bytes[Math.min(pic.h - 1, Math.max(0, b)) * pic.w + Math.min(pic.w - 1, Math.max(0, a))] / 255;
  const p = at(i, j), q = at(i + 1, j), r = at(i, j + 1), s = at(i + 1, j + 1);
  return p + (q - p) * fx + (r - p) * fy + (p - q - r + s) * fx * fy;
}

/**
 * A height function in plate millimetres: (X, Y) -> [0, 1]. `centre` is where the texture is anchored and `angle`
 * turns it (degrees); `scale` is the feature size in mm; `params` the map's own settings. A picture tiles at
 * `scale` mm wide, or stretches over `box` (the area's bounding box) when `fit` is 'stretch'; white is high.
 * `invert` flips high and low.
 */
export function heightFunction({ map, scale = 4, angle = 0, seed = 1, invert = false, centre = [0, 0], picture = null, fit = 'stretch', box = null, params = null }) {
  const s = Math.max(0.2, Number(scale) || 4), a = -(Number(angle) || 0) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
  const sd = Math.round(Number(seed) || 0);
  let f;
  if (map === 'picture') {
    if (!picture) f = () => 0.5;
    else if (fit === 'tile') {
      const tw = s, th = s * picture.h / picture.w;
      f = (u, v) => samplePicture(picture, (u * s / tw) - Math.floor(u * s / tw), (v * s / th) - Math.floor(v * s / th));
    } else if (box && box.w > 0 && box.h > 0) {
      // stretched over the area as seen in the texture's own (turned) frame: a quarter turn turns the picture with it
      const rot = (X, Y) => { const dx = X - centre[0], dy = Y - centre[1]; return [dx * c - dy * sn, dx * sn + dy * c]; };
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [X, Y] of [[box.x0, box.y0], [box.x0 + box.w, box.y0], [box.x0 + box.w, box.y0 + box.h], [box.x0, box.y0 + box.h]]) {
        const [lx, ly] = rot(X, Y);
        x0 = Math.min(x0, lx); x1 = Math.max(x1, lx); y0 = Math.min(y0, ly); y1 = Math.max(y1, ly);
      }
      return (X, Y) => { const [lx, ly] = rot(X, Y); const h = samplePicture(picture, (lx - x0) / (x1 - x0), (ly - y0) / (y1 - y0)); return invert ? 1 - h : h; };
    } else f = () => 0.5;
  } else {
    const key = MAPS[map] ? map : 'crystal', fn = MAPS[key], P = cleanTextureParams(key, params);
    f = (u, v) => fn(u, v, sd, P);
  }
  return (X, Y) => {
    const dx = X - centre[0], dy = Y - centre[1];
    const h = clamp01(f((dx * c - dy * sn) / s, (dx * sn + dy * c) / s));
    return invert ? 1 - h : h;
  };
}
