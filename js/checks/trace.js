// Mask to polygons: traces the boundary of a binary raster into closed rings (outer rings counter-clockwise,
// holes clockwise, in mm), then simplifies the staircase. Used to give an imported mesh a footprint polygon
// the polygon-based checks can use. Also rasterises projected triangles (union fill, unlike the even-odd
// polygon rasteriser).

import { contains, ringArea } from '../geometry/polys.js';

/** OR-fill the xy projection of a flat triangle array into a mask. `keep(t)` can skip triangles by index. */
export function rasterizeTriangles(tris, frame, keep = null) {
  const { x0, y0, w, h, res } = frame;
  const mask = new Uint8Array(w * h);
  const nT = Math.floor(tris.length / 9);
  for (let t = 0; t < nT; t++) {
    if (keep && !keep(t)) continue;
    const o = t * 9;
    const xs = [(tris[o] - x0) / res, (tris[o + 3] - x0) / res, (tris[o + 6] - x0) / res];
    const ys = [(tris[o + 1] - y0) / res, (tris[o + 4] - y0) / res, (tris[o + 7] - y0) / res];
    const jMin = Math.max(0, Math.floor(Math.min(...ys) - 0.5)), jMax = Math.min(h - 1, Math.ceil(Math.max(...ys) - 0.5));
    for (let j = jMin; j <= jMax; j++) {
      const yc = j + 0.5;
      let lo = Infinity, hi = -Infinity;
      for (let e = 0; e < 3; e++) {
        const ax = xs[e], ay = ys[e], bx = xs[(e + 1) % 3], by = ys[(e + 1) % 3];
        if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) { const x = ax + (yc - ay) * (bx - ax) / (by - ay); if (x < lo) lo = x; if (x > hi) hi = x; }
      }
      if (lo === Infinity) continue;
      const i0 = Math.max(0, Math.round(lo)), i1 = Math.min(w - 1, Math.round(hi) - 1);
      if (i1 >= i0) mask.fill(1, j * w + i0, j * w + i1 + 1);
      else if (hi - lo > 0.01) { const i = Math.min(w - 1, Math.max(0, Math.floor((lo + hi) / 2))); mask[j * w + i] = 1; }   // a sliver still marks its cell
    }
  }
  return mask;
}

/** Perpendicular-distance polyline simplification (Douglas-Peucker) for a closed ring. */
function simplifyRing(ring, tol) {
  if (ring.length <= 4) return ring;
  const pts = ring.slice(0, -1);
  const keep = new Uint8Array(pts.length);
  const stack = [[0, pts.length - 1]];
  keep[0] = 1; keep[pts.length - 1] = 1;
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1, wi = -1;
    const ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1];
    const L = Math.hypot(bx - ax, by - ay) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L;
      if (d > worst) { worst = d; wi = i; }
    }
    if (worst > tol) { keep[wi] = 1; stack.push([a, wi], [wi, b]); }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  if (out.length < 3) return ring;
  out.push([out[0][0], out[0][1]]);
  return out;
}

/**
 * Trace a mask into a MultiPolygon in mm. Boundary edges are collected with the inside on their left and
 * linked into loops; at a vertex with two ways on, the walk turns right first so regions touching at a
 * corner stay separate rings.
 */
export function traceMask(mask, frame, simplifyTol = null) {
  const { w, h, x0, y0, res } = frame;
  const at = (i, j) => (i >= 0 && j >= 0 && i < w && j < h) ? mask[j * w + i] : 0;
  // directed edges keyed by start vertex (vertex id = j * (w + 1) + i), direction 0:+x 1:+y 2:-x 3:-y
  const W1 = w + 1;
  const starts = new Map();
  const addEdge = (i, j, dir) => { const k = j * W1 + i; let l = starts.get(k); if (!l) starts.set(k, l = []); l.push(dir); };
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (!mask[j * w + i]) continue;
    if (!at(i, j - 1)) addEdge(i, j, 0);           // bottom edge, going +x
    if (!at(i + 1, j)) addEdge(i + 1, j, 1);       // right edge, going +y
    if (!at(i, j + 1)) addEdge(i + 1, j + 1, 2);   // top edge, going -x
    if (!at(i - 1, j)) addEdge(i, j + 1, 3);       // left edge, going -y
  }
  const step = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const rings = [];
  for (const [k0, dirs0] of starts) {
    while (dirs0.length) {
      let dir = dirs0.pop();
      let i = k0 % W1, j = (k0 - i) / W1;
      const ring = [[i, j]];
      let guard = 0;
      for (;;) {
        i += step[dir][0]; j += step[dir][1];
        const k = j * W1 + i;
        if (k === k0) break;
        ring.push([i, j]);
        const dirs = starts.get(k);
        if (!dirs || !dirs.length) break;   // should not happen on a closed boundary
        // prefer turning right, then straight, then left (relative to the current direction)
        const pref = [(dir + 3) % 4, dir, (dir + 1) % 4];
        let chosen = -1;
        for (const d of pref) { const ix = dirs.indexOf(d); if (ix >= 0) { chosen = d; dirs.splice(ix, 1); break; } }
        if (chosen < 0) { chosen = dirs.pop(); }
        dir = chosen;
        if (++guard > 4 * w * h) break;
      }
      ring.push([ring[0][0], ring[0][1]]);
      if (ring.length >= 4) rings.push(ring);
    }
  }
  // to mm, drop collinear points, simplify
  const toMm = r => r.map(([i, j]) => [x0 + i * res, y0 + j * res]);
  const decollinear = r => {
    const out = [];
    for (let k = 0; k < r.length - 1; k++) {
      const p = r[(k - 1 + r.length - 1) % (r.length - 1)], c = r[k], n = r[(k + 1) % (r.length - 1)];
      if ((c[0] - p[0]) * (n[1] - c[1]) - (c[1] - p[1]) * (n[0] - c[0]) !== 0) out.push(c);
    }
    if (out.length < 3) return null;
    out.push([out[0][0], out[0][1]]);
    return out;
  };
  const tol = simplifyTol ?? res * 0.75;
  const outers = [], holes = [];
  for (const r0 of rings) {
    let r = decollinear(toMm(r0));
    if (!r) continue;
    if (tol > 0) r = simplifyRing(r, tol);
    const a = ringArea(r);
    if (Math.abs(a) < res * res) continue;
    if (a > 0) outers.push(r); else holes.push(r);
  }
  const polys = outers.map(o => [o]);
  for (const hole of holes) {
    // the smallest outer that contains the hole's first vertex owns it
    let best = -1, bestArea = Infinity;
    for (let k = 0; k < outers.length; k++) {
      const a = ringArea(outers[k]);
      if (a < bestArea && contains([[outers[k]]], hole[0][0] + 1e-9, hole[0][1] + 1e-9)) { best = k; bestArea = a; }
    }
    if (best >= 0) polys[best].push(hole);
  }
  return polys;
}
