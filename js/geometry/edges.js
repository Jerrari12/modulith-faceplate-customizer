// Thin bits where a pattern meets the plate's edge or a screw hole. A pattern is drawn without regard to the plate,
// so wherever its repeat does not divide the plate, a band can be cut down to a sliver along the edge (the old
// vertical stripes left 0.5 mm down the left side of a 175 mm plate). A sliver under two perimeters prints as one
// fragile line or not at all.
//
//   tidy     takes the slivers away, and for a cut or an inlay also closes an equally thin wall of face left between
//            it and the edge (the cut or inlay runs out to the edge instead);
//   thicken  widens each sliver to the printable minimum, inward from the edge (and closes thin walls the same way);
//   keep     leaves the pattern as drawn (the checks still note the slivers).
//
// Found by a morphological opening: shrink the pattern by half the minimum and grow it back, and what is left is
// everything at least the minimum wide; the rest is thin. Only thin pieces that run ALONG the edge (most of their
// area within their own width of it, the checks' rule) and are longer than a corner nib count, so a deliberately thin
// stripe running into the edge is left alone and square corners stay square. The work is done on strips 3 mm wide
// along the plate edges and boxes round the holes, which keeps the rasters small.

import * as P from './polys.js';
import { offsetPoly } from './offset.js';
import { rasterize, distanceTransform } from '../checks/raster.js';
import { isoRings, nestRings } from './image.js';

export const EDGE_MIN = 0.8;          // mm: PRINT_LIMITS.minWall in checks.js (a test keeps the two equal)
export const EDGE_MODES = [['tidy', 'Tidy them away'], ['thicken', 'Thicken them'], ['keep', 'Keep them']];
const ERODE = EDGE_MIN / 2;           // shrink: a piece narrower than the minimum vanishes
const GROW = ERODE + 0.06;            // grow back a little more, so the raster's half-cell error leaves no hairlines
const RES = 0.07;                     // mm per raster cell for finding thin parts
const FINE = 0.04;                    // mm per raster cell for drawing a thickened sliver
// mm: how far in from an edge the work strips reach. A sliver lies within its width (under the minimum) + 0.15 of
// the edge, and the strip's own cut line can only make thin bits within the minimum of that line, so 2.2 keeps the two apart
const DEPTH = 2.2;
const CRUMB = 0.05;                   // mm2: PRINT_LIMITS.crumbMm2, a piece too small to be one
const cache = new Map(), CACHE = 48;

/** Ring length, for a piece's mean width (2 x area / perimeter). */
const perimeter = poly => poly.reduce((s, r) => { let L = 0; for (let i = 1; i < r.length; i++) L += Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]); return s + L; }, 0);

/** The bands w wide along each edge of the plate and round each hole, one per edge, inside `keep`. */
function edgeBands(W, H, holes, keep, w) {
  const sides = [P.rect(-W / 2, -H / 2, -W / 2 + w, H / 2), P.rect(W / 2 - w, -H / 2, W / 2, H / 2), P.rect(-W / 2, H / 2 - w, W / 2, H / 2), P.rect(-W / 2, -H / 2, W / 2, -H / 2 + w)];
  return [...sides, ...holes.map(h => P.circle(h.x, h.y, h.d / 2 + w, 64))].map(b => P.intersection(b, keep)).filter(b => !P.isEmpty(b));
}

/** A bucket grid of `mp`'s outline segments, for exact distances from a point to the outline. */
function segmentIndex(mp, cell = 0.5) {
  const grid = new Map(), key = (i, j) => i * 1e6 + j;
  for (const poly of mp) for (const r of poly) for (let k = 1; k < r.length; k++) {
    const [ax, ay] = r[k - 1], [bx, by] = r[k], seg = [ax, ay, bx, by];
    for (let i = Math.floor(Math.min(ax, bx) / cell); i <= Math.floor(Math.max(ax, bx) / cell); i++)
      for (let j = Math.floor(Math.min(ay, by) / cell); j <= Math.floor(Math.max(ay, by) / cell); j++) {
        const kk = key(i, j); let list = grid.get(kk); if (!list) grid.set(kk, list = []); list.push(seg);
      }
  }
  /** Distance from (x, y) to the nearest outline segment, or `rmax` if none lies within it. */
  return (x, y, rmax) => {
    let best = rmax * rmax;
    for (let i = Math.floor((x - rmax) / cell); i <= Math.floor((x + rmax) / cell); i++)
      for (let j = Math.floor((y - rmax) / cell); j <= Math.floor((y + rmax) / cell); j++) {
        const list = grid.get(key(i, j)); if (!list) continue;
        for (const [ax, ay, bx, by] of list) {
          const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
          const t = L > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0;
          const ex = ax + t * dx - x, ey = ay + t * dy - y, d2 = ex * ex + ey * ey;
          if (d2 < best) best = d2;
        }
      }
    return Math.sqrt(best);
  };
}

/**
 * The thin pieces of `mp` that run along the edge of `keep`, as polygons, worked out on one raster over the work area
 * S (which always reaches its edge):
 *  - thin: the cells that do not come back when `mp` is shrunk by ERODE and grown back by GROW (two distance
 *    transforms; the core decided exactly where the raster cannot tell, see below);
 *  - each thin region (8-connected) is an island when it touches no other cell of the shape (a whole cut-down
 *    diamond, a seam triangle) and attached otherwise (a tip or a strip off something wider);
 *  - it counts when at least 60% of its cells lie within its own width (plus a cell and a half) of keep's edge (the
 *    checks' rule), and, if attached, when it is longer than a corner nib: the opening leaves r(1/sin(a/2) - 1) of a
 *    corner of angle a, under 0.4 mm (plus the cell of growth) for corners of 60 degrees and more, so those stay
 *    crisp while a sharper tip is itself a sliver.
 * The chosen regions are traced grown by one cell, so taking them away leaves no hairline of the original along
 * their outline (the raster is only half a cell exact).
 */
function slivers(mp, keep, S) {
  if (P.isEmpty(mp)) return [];
  const m = 2 * RES, x0 = S[0] - m, y0 = S[1] - m, w = Math.ceil((S[2] - S[0] + 2 * m) / RES), h = Math.ceil((S[3] - S[1] + 2 * m) / RES), n = w * h;
  const inside = rasterize(mp, x0, y0, w, h, RES);
  const dIn = distanceTransform(inside, w, h);
  // the core: cells at least ERODE from the outline, less half a cell, since even the best cell centre can sit half a
  // cell off a rib's centre line. So a piece 0.8 mm wide or more always keeps a core, and one under about 0.73 mm never
  // does. The raster distance only brackets the true one (it lies between dIn - 1 and dIn cells), so the cells it
  // cannot decide are measured exactly against the outline.
  const Te = ERODE - RES / 2;
  let dist = null;
  const core = new Uint8Array(n), notCore = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    let c = 0;
    if (inside[i] && dIn[i] * RES >= Te) {
      if ((dIn[i] - 1) * RES >= Te) c = 1;
      else { dist = dist || segmentIndex(mp); const x = x0 + ((i % w) + 0.5) * RES, y = y0 + (Math.floor(i / w) + 0.5) * RES; c = dist(x, y, Te + RES) >= Te ? 1 : 0; }
    }
    core[i] = c; notCore[i] = 1 - c; any = any || c === 1;
  }
  const thin = new Uint8Array(n);
  let found = false;
  if (!any) { for (let i = 0; i < n; i++) { thin[i] = inside[i]; found = found || inside[i] === 1; } }
  else {
    const dOut = distanceTransform(notCore, w, h, false);
    for (let i = 0; i < n; i++) if (inside[i] && !core[i] && dOut[i] - 0.5 > GROW / RES) { thin[i] = 1; found = true; }
  }
  if (!found) return [];
  // label the thin regions, noting for each whether it touches the rest of the shape, its size and its widest point
  const label = new Int32Array(n), stack = [];
  const R = [null];   // per region: { touches, cells, i0, i1, j0, j1, deep }
  for (let s0 = 0; s0 < n; s0++) {
    if (!thin[s0] || label[s0]) continue;
    const reg = { touches: false, cells: 0, i0: Infinity, i1: -Infinity, j0: Infinity, j1: -Infinity, deep: 0 };
    R.push(reg); const id = R.length - 1;
    label[s0] = id; stack.push(s0);
    while (stack.length) {
      const q = stack.pop(), i = q % w, j = (q - i) / w;
      reg.cells++; reg.deep = Math.max(reg.deep, dIn[q]);
      if (i < reg.i0) reg.i0 = i; if (i > reg.i1) reg.i1 = i; if (j < reg.j0) reg.j0 = j; if (j > reg.j1) reg.j1 = j;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const a = i + di, c = j + dj;
        if (a < 0 || c < 0 || a >= w || c >= h) continue;
        const r = c * w + a;
        if (thin[r]) { if (!label[r]) { label[r] = id; stack.push(r); } } else if (inside[r] && (di === 0 || dj === 0)) reg.touches = true;
      }
    }
  }
  // how far each cell is inside keep (to its edge or a hole), and how many of each region's cells lie near the edge
  const km = rasterize(keep, x0, y0, w, h, RES), dK = distanceTransform(km, w, h, false);
  const near = new Int32Array(R.length);
  for (let i = 0; i < n; i++) { const l = label[i]; if (l && dK[i] <= 2 * R[l].deep + 1.5) near[l]++; }
  const keepIt = R.map((reg, l) => {
    if (!reg || reg.cells * RES * RES < 0.01) return false;
    if (reg.touches && Math.max(reg.i1 - reg.i0 + 1, reg.j1 - reg.j0 + 1) * RES < 0.6) return false;   // a corner nib
    return near[l] >= 0.6 * reg.cells;
  });
  if (!keepIt.some(Boolean)) return [];
  // the chosen regions, grown by one cell (8 neighbours), traced
  const f = new Float32Array(n).fill(-1);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const q = j * w + i;
    if (!keepIt[label[q]]) continue;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const a = i + di, c = j + dj; if (a >= 0 && c >= 0 && a < w && c < h) f[c * w + a] = 1; }
  }
  const toMm = ([x, y]) => [x0 + (x - 0.5) * RES, y0 + (y - 0.5) * RES];
  return nestRings(isoRings(f, w, h, 1e-4), 0.5).map(poly => [poly.map(r => r.map(toMm))]);
}

/**
 * The pattern part `poly` (already inside `keep`, the plate less its holes) with its edge slivers dealt with by
 * `mode`. `op` is the part's raise, cut or inlay; `holes` are the plate's holes ({ x, y, d }); `key` caches the
 * answer (the pattern is the same on every build of a size until its settings change).
 *
 * Two passes: the pattern's own slivers first, then, for a cut or an inlay, the thin walls of face the result leaves
 * against the edge (closed by running the cut or inlay out to the edge). In that order a tip taken away and the wall
 * beside it close up together onto the piece next to them, instead of leaving the wall stranded on its own.
 */
export function tidyEdges(poly, { W, H, holes = [], keep, op = 'raise', mode = 'tidy', key = null }) {
  if (mode !== 'tidy' && mode !== 'thicken') return poly;
  if (P.isEmpty(poly)) return poly;
  const ck = key ? JSON.stringify([key, mode, op, W, H, holes]) : null;
  if (ck && cache.has(ck)) { const hit = cache.get(ck); cache.delete(ck); cache.set(ck, hit); return hit; }
  const ctx = { W, H, holes, keep, regions: workRegions(W, H, holes) };
  let out = ownSlivers(poly, ctx, mode);
  if (op === 'cut' || op === 'inlay') out = closeWalls(out, ctx);
  if (ck) { cache.set(ck, out); if (cache.size > CACHE) cache.delete(cache.keys().next().value); }
  return out;
}

const REACH = EDGE_MIN + 0.4;   // a piece must come this close to an edge to leave a sliver or a thin wall there

/** The work areas: a strip along each plate edge and a box round each hole, each with its band within REACH. */
function workRegions(W, H, holes) {
  const d = Math.min(DEPTH, W / 2, H / 2);
  return [
    { S: [-W / 2, H / 2 - d, W / 2, H / 2], near: [-W / 2, H / 2 - REACH, W / 2, H / 2] },
    { S: [-W / 2, -H / 2, W / 2, -H / 2 + d], near: [-W / 2, -H / 2, W / 2, -H / 2 + REACH] },
    { S: [-W / 2, -H / 2, -W / 2 + d, H / 2], near: [-W / 2, -H / 2, -W / 2 + REACH, H / 2] },
    { S: [W / 2 - d, -H / 2, W / 2, H / 2], near: [W / 2 - REACH, -H / 2, W / 2, H / 2] },
    ...holes.map(h => ({
      S: [Math.max(-W / 2, h.x - h.d / 2 - DEPTH), Math.max(-H / 2, h.y - h.d / 2 - DEPTH), Math.min(W / 2, h.x + h.d / 2 + DEPTH), Math.min(H / 2, h.y + h.d / 2 + DEPTH)],
      near: [h.x - h.d / 2 - REACH, h.y - h.d / 2 - REACH, h.x + h.d / 2 + REACH, h.y + h.d / 2 + REACH],
    })),
  ].filter(r => r.S[2] > r.S[0] && r.S[3] > r.S[1]);
}

const overlaps = (a, b) => a && b && a.x1 >= b[0] && a.x0 <= b[2] && a.y1 >= b[1] && a.y0 <= b[3];

/** Whether a box lies on the plate edge or a hole's (within 0.2 mm). */
function onEdge(b, { W, H, holes }) {
  return b.x0 < -W / 2 + 0.2 || b.x1 > W / 2 - 0.2 || b.y0 < -H / 2 + 0.2 || b.y1 > H / 2 - 0.2
    || holes.some(hl => Math.hypot(Math.max(b.x0 - hl.x, 0, hl.x - b.x1), Math.max(b.y0 - hl.y, 0, hl.y - b.y1)) <= hl.d / 2 + 0.2);
}

/**
 * Pieces of `mp` on the edge that are too narrow for the raster to see at all (under two cells across on average,
 * 2 x area / perimeter): slivers whatever the raster says. Crumbs under crumbMm2 go into `crumbs` when asked.
 */
function hairlines(mp, ctx, crumbs = null) {
  const out = [];
  for (const pc of mp) {
    const b = P.bbox([pc]);
    if (!b || !onEdge(b, ctx)) continue;
    const a = P.area([pc]);
    if (a < CRUMB) (crumbs || out).push([pc]);
    else if ((2 * a) / perimeter(pc) < 2 * RES) out.push([pc]);
  }
  return out;
}

/**
 * `mp` less `cuts` and plus `adds`, clipping only the pieces whose box touches a change (the rest are carried over:
 * a pattern can have thousands of pieces and the edges concern a few). After a cut, hairline crumbs it leaves on the
 * edge go too: the very tip of a crescent along the edge can be narrower than half a raster cell, so no cell saw it.
 */
function applyLocal(mp, ctx, cuts, adds) {
  if (!cuts.length && !adds.length) return mp;
  const changed = [...cuts, ...adds].map(c => P.bbox(c)).filter(Boolean).map(c => [c.x0 - 1e-6, c.y0 - 1e-6, c.x1 + 1e-6, c.y1 + 1e-6]);
  const boxes = mp.map(pc => P.bbox([pc]));
  const near = b => changed.some(c => overlaps(b, c));
  let mid = mp.filter((_, i) => near(boxes[i]));
  const rest = mp.filter((_, i) => !near(boxes[i]));
  if (cuts.length) {
    mid = P.difference(mid, ...cuts);
    const gone = new Set(hairlines(mid, ctx).map(x => x[0]));   // crumbs and hairlines both
    mid = mid.filter(pc => !gone.has(pc));
  }
  if (adds.length) mid = P.union(mid, ...adds);
  return rest.concat(mid);
}

/** The slivers, hairlines and crumbs of `poly` along the edge: { thin, crumbs }. */
function findSlivers(poly, ctx) {
  const { keep } = ctx, boxes = poly.map(pc => P.bbox([pc]));
  const crumbs = [], thin = hairlines(poly, ctx, crumbs);
  for (const { S, near } of ctx.regions) {
    if (!boxes.some(b => overlaps(b, near))) continue;               // nothing comes near this edge
    const C = P.intersection(poly.filter((_, i) => overlaps(boxes[i], S)), P.rect(...S));
    thin.push(...slivers(C, keep, S));
  }
  return { thin, crumbs };
}

/**
 * Pass one: the pattern's own slivers along the edge, taken away (tidy) or widened to the minimum (thicken). Tidy
 * looks once more at what it leaves: a piece barely over the minimum can lose a thin cusp at one end and keep a
 * shorter one (a corner nib) at the other, and what remains is then a sliver of its own, which goes too.
 */
function ownSlivers(poly, ctx, mode) {
  const { W, H, holes, keep } = ctx;
  const { thin, crumbs } = findSlivers(poly, ctx);
  if (mode === 'tidy' || !thin.length) {
    const once = applyLocal(poly, ctx, crumbs.concat(mode === 'tidy' ? thin : []), []);
    if (mode !== 'tidy' || !thin.length) return once;
    const again = findSlivers(once, ctx);
    return applyLocal(once, ctx, again.crumbs.concat(again.thin), []);
  }
  // thicken: each sliver widened inward to the minimum, within the band of the edge it runs along only (so it does
  // not turn a corner onto the next edge); crumbs still go
  const bands = edgeBands(W, H, holes, keep, EDGE_MIN);
  const adds = thin.map(T => {
    let best = null, most = 0;
    for (const b of bands) { const a = P.area(P.intersection(T, b)); if (a > most) { most = a; best = b; } }
    return best ? P.intersection(offsetPoly(T, EDGE_MIN, { res: FINE }), best) : [];
  }).filter(a => !P.isEmpty(a));
  return applyLocal(poly, ctx, crumbs, adds);
}

/**
 * The face in work area S that is a thin wall between the pattern `C` and the edge: a cell whose distance to the
 * edge plus its distance to the pattern is under the minimum lies in a gap narrower than that, so filling every such
 * cell runs the pattern right out to the edge there (a strip of face along the edge fills across its whole width; a
 * neck where a corner comes near the edge only makes a short lens, which the caller leaves). Traced grown by a cell.
 */
function wallParts(C, keep, S) {
  const m = 2 * RES, x0 = S[0] - m, y0 = S[1] - m, w = Math.ceil((S[2] - S[0] + 2 * m) / RES), h = Math.ceil((S[3] - S[1] + 2 * m) / RES), n = w * h;
  const km = rasterize(keep, x0, y0, w, h, RES), cm = rasterize(C, x0, y0, w, h, RES);
  const notC = new Uint8Array(n);
  let anyC = false;
  for (let i = 0; i < n; i++) { notC[i] = cm[i] ? 0 : 1; anyC = anyC || cm[i] === 1; }
  if (!anyC) return [];
  const dE = distanceTransform(km, w, h, false), dM = distanceTransform(notC, w, h, false);
  const wall = new Uint8Array(n);
  let found = false;
  // (the two raster distances overstate the gap by up to a cell together; a cell's margin means a wall 0.8 mm or
  // more is never filled, while every gap under about 0.7 mm is)
  for (let i = 0; i < n; i++) if (km[i] && !cm[i] && (dE[i] + dM[i] - 1) * RES < EDGE_MIN - RES) { wall[i] = 1; found = true; }
  if (!found) return [];
  const f = new Float32Array(n).fill(-1);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (!wall[j * w + i]) continue;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const a = i + di, c = j + dj; if (a >= 0 && c >= 0 && a < w && c < h) f[c * w + a] = 1; }
  }
  const toMm = ([x, y]) => [x0 + (x - 0.5) * RES, y0 + (y - 0.5) * RES];
  return nestRings(isoRings(f, w, h, 1e-4), 0.5).map(poly => [poly.map(r => r.map(toMm))]);
}

/** Pass two, for a cut or an inlay: thin walls of face between it and the edge, closed by running it out to the edge. */
function closeWalls(mp, ctx) {
  const { keep } = ctx, boxes = mp.map(pc => P.bbox([pc]));
  const walls = [];
  for (const { S, near } of ctx.regions) {
    if (!boxes.some(b => overlaps(b, near))) continue;
    const rect = P.rect(...S), C = P.intersection(mp.filter((_, i) => overlaps(boxes[i], S)), rect);
    if (P.isEmpty(C)) continue;
    // a wall long enough to be one (a short lens at a corner's tip is a point, not a wall)
    for (const T of wallParts(C, keep, S)) { const b = P.bbox(T); if (Math.max(b.w, b.h) >= 1.5 * EDGE_MIN || P.area(T) >= EDGE_MIN * EDGE_MIN) walls.push(T); }
    // and face too narrow for the raster to see at all
    const face = P.difference(P.intersection(keep, rect), C);
    walls.push(...hairlines(face, ctx));
  }
  // the walls come off a raster grown by a cell, so they are clipped back to the plate (they are small)
  return applyLocal(mp, ctx, [], walls.map(wl => P.intersection(wl, keep)).filter(wl => !P.isEmpty(wl)));
}
