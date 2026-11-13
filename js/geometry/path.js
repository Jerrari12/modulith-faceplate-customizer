// Drawn shapes (2026-11-11, after Erie Sign Studio's pen tool): a path of points drawn on the 2D stage, each a
// corner or a smooth point with Bezier handles. Closed, it is a filled shape (every lobe of a path that crosses
// itself fills), or a wall of a set thickness inside its outline; open, a line of a set thickness with round or
// flat ends.
//
// It is relief like a shape (raise, cut or inlay), or, raised with a taper angle, a body whose sides lean in as they
// rise (Fusion's tapered extrude). The body is a height field over the outline: 0 on the drawn edge, climbing at the
// taper angle and level at the height, meshed by the 3D textures' grid mesher (surface.js), which clips it to the
// plate exactly. Where the sides meet before the full height (a thin arm, a narrow line) they meet in a ridge
// instead of failing. An outward lean would be an overhang printed in mid-air (these print face up), so there is
// none.
//
// Points are { x, y, i?: [dx, dy], o?: [dx, dy] } in mm about the element's own centre, before its rotation: i is
// the handle the curve arrives along, o the one it leaves along, both relative to the point. A segment with neither
// handle is straight.

import * as P from './polys.js';
import { offsetPoly } from './offset.js';
import { isoRings, nestRings } from './image.js';
import { splitLoops } from './text.js';
import { surfaceBody, SURFACE_GRIDS } from './surface.js';
import { roofBody, simplifyOutline } from './roof.js';

export const PATH_LIMITS = { maxPoints: 200, maxCoord: 400, minThick: 0.4, maxThick: 20, maxTaper: 60, tol: 0.02 };
export const PATH_FORMS = [['fill', 'Filled'], ['wall', 'Wall'], ['line', 'Line']];

const clampNum = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
const formOf = el => (el.form === 'wall' || el.form === 'line' ? el.form : 'fill');
export const pathThick = el => clampNum(el.thick, PATH_LIMITS.minThick, PATH_LIMITS.maxThick, 2);
export const pathTaper = el => clampNum(el.taper, 0, PATH_LIMITS.maxTaper, 0);

/** Points from a design file, checked: finite, inside the limits, at most maxPoints; a zero handle is no handle. */
export function cleanPoints(raw) {
  if (!Array.isArray(raw)) return [];
  const L = PATH_LIMITS.maxCoord;
  const n = v => { const x = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN; return Number.isFinite(x) ? Math.min(L, Math.max(-L, x)) : null; };
  const handle = v => {
    if (!Array.isArray(v) || v.length !== 2) return undefined;
    const a = n(v[0]), b = n(v[1]);
    return a === null || b === null || (Math.abs(a) < 1e-9 && Math.abs(b) < 1e-9) ? undefined : [a, b];
  };
  const out = [];
  for (const p of raw) {
    if (out.length >= PATH_LIMITS.maxPoints) break;
    if (!p || typeof p !== 'object') continue;
    const x = n(p.x), y = n(p.y);
    if (x === null || y === null) continue;
    const q = { x, y }, i = handle(p.i), o = handle(p.o);
    if (i) q.i = i;
    if (o) q.o = o;
    out.push(q);
  }
  return out;
}

/** Whether a drawing is open (a line) or closed (a filled shape or a wall). */
export const isOpen = el => formOf(el) === 'line';

/**
 * The path flattened to a polyline within `tol` mm of its curves: [[x, y], ...], the first point not repeated at
 * the end even when `closed`. Points that land on the one before are left out.
 */
export function flattenPath(pts, closed, tol = PATH_LIMITS.tol) {
  const out = [];
  const add = (x, y) => { const l = out[out.length - 1]; if (!l || Math.abs(l[0] - x) > 1e-9 || Math.abs(l[1] - y) > 1e-9) out.push([x, y]); };
  const n = pts.length;
  if (!n) return out;
  const segs = closed ? n : n - 1;
  for (let k = 0; k < segs; k++) {
    const a = pts[k], b = pts[(k + 1) % n];
    add(a.x, a.y);
    if (!a.o && !b.i) continue;
    const p1 = [a.x + (a.o?.[0] || 0), a.y + (a.o?.[1] || 0)], p2 = [b.x + (b.i?.[0] || 0), b.y + (b.i?.[1] || 0)];
    // uniform steps: the deviation is at most |B''| / (8 n^2), and |B''| <= 6 max(|P0 - 2P1 + P2|, |P1 - 2P2 + P3|)
    const m = Math.max(Math.hypot(a.x - 2 * p1[0] + p2[0], a.y - 2 * p1[1] + p2[1]), Math.hypot(p1[0] - 2 * p2[0] + b.x, p1[1] - 2 * p2[1] + b.y));
    // (the ceiling holds the tolerance for any curve inside the coordinate limits: m stays under about 4000 mm, which
    // needs under 400 steps)
    const steps = Math.min(512, Math.max(2, Math.ceil(Math.sqrt((0.75 * m) / tol))));
    for (let s = 1; s < steps; s++) {
      const t = s / steps, u = 1 - t;
      const c0 = u * u * u, c1 = 3 * u * u * t, c2 = 3 * u * t * t, c3 = t * t * t;
      add(c0 * a.x + c1 * p1[0] + c2 * p2[0] + c3 * b.x, c0 * a.y + c1 * p1[1] + c2 * p2[1] + c3 * b.y);
    }
  }
  if (!closed) add(pts[n - 1].x, pts[n - 1].y);
  else if (out.length > 1) { const f = out[0], l = out[out.length - 1]; if (Math.abs(f[0] - l[0]) < 1e-9 && Math.abs(f[1] - l[1]) < 1e-9) out.pop(); }
  return out;
}

/**
 * A line of width `width` along a polyline, with round or flat ends: traced from the exact distance to the line on
 * a fine raster (as offsetPoly traces its outlines), so joins come out round, as a nozzle draws them, and a line
 * that crosses itself is one piece. The error is about half a cell, 0.02 mm at the finest.
 */
export function strokeLine(line, width, ends = 'round', { res = 0.04, maxCells = 3e6 } = {}) {
  if (line.length < 2 || !(width > 0)) return [];
  const r = width / 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of line) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const pad = r + 6 * res;
  const size = () => [Math.ceil((x1 - x0 + 2 * pad) / res), Math.ceil((y1 - y0 + 2 * pad) / res)];
  while (size()[0] * size()[1] > maxCells) res *= 1.25;
  const [w, h] = size(), ox = x0 - (r + 6 * res), oy = y0 - (r + 6 * res);
  // f = how far inside the line's edge each cell centre is, in cells: the union (the most inside) of
  //  - every segment's band, cut square at both its ends,
  //  - at every point between two segments, the round join: on the outside of the turn (past the end of the segment
  //    coming in and before the start of the one going out) a disk; and, with flat ends, the whole disk wherever it
  //    lies between the two square ends (so the seam where two bands meet in a straight run is covered, and nothing
  //    pokes past a square end on a curve whose first segment is short); with round ends the whole disk,
  //  - and, for round ends, a disk at each free end.
  // A flat end is then the first band's square end itself, and no part of the line is ever cut away because it
  // passes near an end.
  const f = new Float32Array(w * h).fill(-(r / res) - 4), reach = r + 2 * res, flat = ends === 'flat';
  const put = (q, v) => { if (v / res > f[q]) f[q] = v / res; };
  const window = (xa, ya, xb, yb, fn) => {
    const i0 = Math.max(0, Math.floor((Math.min(xa, xb) - reach - ox) / res)), i1 = Math.min(w - 1, Math.ceil((Math.max(xa, xb) + reach - ox) / res));
    const j0 = Math.max(0, Math.floor((Math.min(ya, yb) - reach - oy) / res)), j1 = Math.min(h - 1, Math.ceil((Math.max(ya, yb) + reach - oy) / res));
    for (let j = j0; j <= j1; j++) { const cy = oy + (j + 0.5) * res; for (let i = i0; i <= i1; i++) fn(j * w + i, ox + (i + 0.5) * res, cy); }
  };
  const dirs = [];
  for (let k = 0; k + 1 < line.length; k++) {
    const [ax, ay] = line[k], [bx, by] = line[k + 1], L = Math.hypot(bx - ax, by - ay);
    dirs.push(L > 0 ? [(bx - ax) / L, (by - ay) / L] : null);
    if (!(L > 0)) continue;
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    // a long segment is visited in short pieces, so only the cells near it are measured
    const pieces = Math.max(1, Math.ceil(L / 2));
    for (let s = 0; s < pieces; s++) {
      window(ax + (bx - ax) * s / pieces, ay + (by - ay) * s / pieces, ax + (bx - ax) * (s + 1) / pieces, ay + (by - ay) * (s + 1) / pieces, (q, cx, cy) => {
        const a = (cx - ax) * ux + (cy - ay) * uy, across = Math.abs((cx - ax) * uy - (cy - ay) * ux);
        put(q, Math.min(r - across, a, L - a));
      });
    }
  }
  const S = line[0], E = line[line.length - 1], u0 = dirs.find(Boolean), u1 = dirs.slice().reverse().find(Boolean);
  for (let k = 1; k + 1 < line.length; k++) {
    const [vx, vy] = line[k], din = dirs[k - 1], dout = dirs[k];
    if (!din || !dout) continue;
    window(vx, vy, vx, vy, (q, cx, cy) => {
      const px = cx - vx, py = cy - vy, disk = r - Math.hypot(px, py);
      if (px * din[0] + py * din[1] >= 0 && px * dout[0] + py * dout[1] <= 0) { put(q, disk); return; }
      put(q, flat ? Math.min(disk, (cx - S[0]) * u0[0] + (cy - S[1]) * u0[1], -((cx - E[0]) * u1[0] + (cy - E[1]) * u1[1])) : disk);
    });
  }
  if (ends !== 'flat') for (const [vx, vy] of [line[0], line[line.length - 1]]) window(vx, vy, vx, vy, (q, cx, cy) => put(q, r - Math.hypot(cx - vx, cy - vy)));
  const rings = isoRings(f, w, h, 1e-4);
  const toMm = ([x, y]) => [ox + (x - 0.5) * res, oy + (y - 0.5) * res];
  return nestRings(rings, 1e-3 / (res * res)).map(poly => poly.map(ring => ring.map(toMm)));
}

const outlineCache = new Map(), OUTLINE_CACHE = 48;

/**
 * The drawing's outline in its own frame (about its centre, unrotated), as a MultiPolygon: the filled shape (every
 * lobe of a path that crosses itself fills), the wall inside it, or the line along it.
 * Empty when there are too few points to make one.
 */
export function pathOutline(el) {
  const pts = Array.isArray(el.pts) ? el.pts : [];
  const form = formOf(el), thick = pathThick(el), ends = el.ends === 'flat' ? 'flat' : 'round';
  const key = JSON.stringify([form, form === 'fill' ? 0 : thick, form === 'line' ? ends : '', pts]);
  const hit = outlineCache.get(key);
  if (hit) { outlineCache.delete(key); outlineCache.set(key, hit); return hit; }
  let mp = [];
  if (form === 'line') {
    if (pts.length >= 2) mp = strokeLine(flattenPath(pts, false), thick, ends);
  } else if (pts.length >= 3) {
    const ring = flattenPath(pts, true);
    if (ring.length >= 3) {
      // a path that crosses itself is cut into its simple loops, and every loop fills, whichever way it turns: one
      // drawn line has no holes, so a figure of eight is two filled lobes (a font's nonzero rule would empty one)
      const closed = [...ring, [ring[0][0], ring[0][1]]];
      const fill = r => { const loops = splitLoops(r).filter(l => Math.abs(P.ringArea(l)) > 1e-9).map(l => (P.ringArea(l) < 0 ? l.slice().reverse() : l)); return loops.length ? P.unionPieces(loops.map(l => [[l]])) : []; };
      try { mp = fill(closed); } catch { mp = fill(closed.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4])); }
      if (form === 'wall' && mp.length) {
        const inner = offsetPoly(mp, -thick);
        mp = inner.length ? P.difference(mp, inner) : mp;
      }
    }
  }
  outlineCache.set(key, mp);
  if (outlineCache.size > OUTLINE_CACHE) outlineCache.delete(outlineCache.keys().next().value);
  return mp;
}

/** The middle of the points' box, to keep a drawing's points about its own centre after an edit. */
export function pointsCentre(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  return Number.isFinite(x0) ? [(x0 + x1) / 2, (y0 + y1) / 2] : [0, 0];
}

/**
 * The distance from (x, y) to the nearest edge of `mp`, up to `cap` (anything farther comes back as cap). Each edge
 * is filed under the square buckets (`cap` wide) that points along it every half bucket fall in; a point within cap
 * of an edge is then within two buckets of one of those points, so only the 5 x 5 buckets round it are measured.
 */
export function edgeDistance(mp, cap) {
  const size = Math.max(cap, 0.5), buckets = new Map();
  const keyOf = (i, j) => `${i},${j}`;
  for (const poly of mp) for (const ring of poly) for (let k = 0; k + 1 < ring.length; k++) {
    const [ax, ay] = ring[k], [bx, by] = ring[k + 1];
    const seg = [ax, ay, bx - ax, by - ay, (bx - ax) ** 2 + (by - ay) ** 2];
    const steps = Math.max(1, Math.ceil(Math.sqrt(seg[4]) / (size / 2))), mine = new Set();
    for (let s = 0; s <= steps; s++) {
      const kk = keyOf(Math.floor((ax + seg[2] * s / steps) / size), Math.floor((ay + seg[3] * s / steps) / size));
      if (mine.has(kk)) continue;
      mine.add(kk);
      if (!buckets.has(kk)) buckets.set(kk, []);
      buckets.get(kk).push(seg);
    }
  }
  return (x, y) => {
    const bi = Math.floor(x / size), bj = Math.floor(y / size);
    let best = cap * cap;
    for (let i = bi - 2; i <= bi + 2; i++) for (let j = bj - 2; j <= bj + 2; j++) {
      const list = buckets.get(keyOf(i, j));
      if (!list) continue;
      for (const [ax, ay, dx, dy, L2] of list) {
        const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
        const ex = x - ax - dx * t, ey = y - ay - dy * t, d2 = ex * ex + ey * ey;
        if (d2 < best) best = d2;
      }
    }
    return Math.sqrt(best);
  };
}

/**
 * A raised drawing's side, seen in section (2026-11-11): how high (mm) it stands at distance d (mm) in from the drawn
 * edge. The wall leans in by `angle` degrees (0: straight up, from the edge), and the top edge is square, a 45°
 * chamfer `size` mm high, or rounded with radius `size`, tangent to both the wall and the top. Returns
 * { at: d -> mm, reach } where reach is the distance in from the edge past which it is flat at the full height.
 * Every piece only climbs, so where two sides come close (a thin arm, a line) the lower one wins and they meet in a
 * ridge.
 */
export function sideProfile({ height = 6, angle = 0, edge = 'square', size = 1 } = {}) {
  const h = Math.max(0.05, height), a = Math.min(PATH_LIMITS.maxTaper, Math.max(0, angle)) * Math.PI / 180;
  const t = Math.tan(a), straight = a < 1e-9;
  const wall = d => (straight ? Infinity : d / t);   // straight up: the full height right from the edge
  const c = edge === 'chamfer' || edge === 'round' ? Math.min(Math.max(0, Number(size) || 0), 0.95 * h) : 0;
  // `levels`: the distances where the side changes from one straight piece to the next (the crisp mesher cuts there,
  // so every piece of the top is flat); a round is followed by chords even in angle, within about 0.01 mm of it
  const sorted = list => [...new Set(list.filter(v => v > 1e-9).map(v => +v.toFixed(9)))].sort((p, q) => p - q);
  if (!c) return { at: d => Math.min(h, wall(d)), reach: h * t, levels: sorted([h * t]) };
  if (edge === 'chamfer') {
    // 45° from (h - c) on the wall up to the top, above that point only (below it the chamfer's line would cut under
    // a wall leaning past 45°); on such a wall the wall stays the lower above it too, so a chamfer changes nothing
    const d1 = (h - c) * t, reach = Math.max(d1 + c, h * t);
    return { at: d => (d < d1 ? Math.min(h, wall(d)) : Math.min(h, wall(d), h - c + (d - d1))), reach, levels: sorted([d1, reach]) };
  }
  // round: the circle of radius c touching the top at d = dc and the wall at its foot
  const dc = (h - c) * t + c / Math.cos(a), foot = dc - c * Math.cos(a);
  // (chords even in angle: 8 on a round up to 1 mm, up to 24 on a 20 mm one, each within 0.011 mm of the arc)
  const m = Math.min(24, Math.max(8, Math.ceil(c * 8))), arc = [];
  for (let k = 0; k <= m; k++) arc.push(dc + c * Math.cos(Math.PI - a - (Math.PI / 2 - a) * k / m));
  return { at: d => (d >= dc ? h : d >= foot ? (h - c) + Math.sqrt(Math.max(0, c * c - (dc - d) ** 2)) : Math.min(h, wall(d))), reach: dc, levels: sorted([foot, ...arc, dc]) };
}

/**
 * A raised drawing's body: `outline` (placed on the plate) raised `height` mm from z0 with the side `sideProfile`
 * gives, over `region` (the part of the outline the plate keeps: where the plate cuts it, the cut side is straight
 * up). Returns surfaceBody's { tris, footprint, z0, z1, grid } or null when nothing is left.
 */
export function taperBody(region, outline, { z0 = 0, height = 6, angle = 10, edge = 'square', size = 1, grid = SURFACE_GRIDS.fine, keep = null } = {}) {
  const side = sideProfile({ height, angle, edge, size }), h = Math.max(0.05, height);
  // crisp: flat faces and sharp creases (roof.js), from the outline thinned to 0.01 mm (its distance measured to
  // that, so every face is flat on the same sides it is cut along); the grid mesher when that cannot be built
  // (the region is the thinned outline cut by the plate's keep area when that is known, so its edge is made of the
  // very sides the creases are worked out from; thinned on its own, it would start its runs elsewhere and miss them)
  const thin = simplifyOutline(outline, 0.01), thinRegion = keep ? P.intersection(thin, keep) : simplifyOutline(region, 0.01);
  const exact = thin.length && thinRegion.length ? roofBody(thinRegion, thin, { z0, side, dist: edgeDistance(thin, Math.max(1e-3, side.reach) + 6) }) : null;
  if (exact) return exact;
  const dist = edgeDistance(outline, Math.max(1e-3, side.reach) + 6);
  return surfaceBody(region, (x, y) => side.at(dist(x, y)) / h, { z0, base: 0, depth: h, grid });
}

/** A drawing's top edge as it is built: 'square', 'chamfer' or 'round', and its size in mm (0 when square). */
export const pathEdge = el => {
  const edge = el.edge === 'chamfer' || el.edge === 'round' ? el.edge : 'square';
  return { edge, size: edge === 'square' ? 0 : clampNum(el.edgeSize, 0, 20, 1) };
};
