// The plate's edge cuts every body (2026-11-11, Joey's rule: nothing modelled stands outside the faceplate's
// perimeter, it is clipped there). Relief and 3D textures were always clipped as polygons; blocks, grips and
// imported meshes are triangle bodies, so they are cut here: by each side of the plate they cross (a vertical
// plane), keeping the plate's side, and each cut is closed with a flat cap in that plane, so the body stays closed
// and its cut side lies flush with the plate's edge.
//
// Every triangle that crosses the plane is clipped to a convex piece and fanned; a point where an edge crosses is
// worked out from the edge's two ends in a fixed order, so the two triangles that share the edge get the same
// point, and the cap is chained from those points. A body whose cut does not close into loops (a mesh that was
// never closed, or one that only touches the plane along an edge) is left as it was, and the checks still report
// it running past the edge.

import * as P from './polys.js';
import { triangulate } from './extrude.js';
import { nestRings } from './image.js';

const EPS = 1e-6;

/**
 * A cap outline with the points that lie exactly in line with their neighbours taken out, each with the zero-area
 * triangle that keeps its two edges paired. The triangulator drops such points itself (a cut along a body's flat
 * bottom is one straight run of them, and near-flat triangles can fold the run back on itself), while the walls
 * beside the cap still end at them: taken out here with their triangle, every edge stays shared and the body closed.
 * The test is the triangulator's own (an exact zero), on the same numbers.
 */
function dropInLine(ring) {
  const pts = ring.slice(), flat = [];
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let k = 0; k < pts.length && pts.length > 3; k++) {
      const n = pts.length, p = pts[(k - 1 + n) % n], q = pts[k], r = pts[(k + 1) % n];
      if (same(p, q) || same(q, r)) { pts.splice(k, 1); k--; changed = true; continue; }
      if ((q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]) === 0) { flat.push([p, q, r]); pts.splice(k, 1); k--; changed = true; }
    }
  }
  return { pts, flat };
}

/**
 * Cut a closed triangle soup by the plane where coordinate `axis` (0 x, 1 y) equals `c`, keeping the side where
 * s * (p[axis] - c) <= 0, and cap the cut. Returns a Float32Array, or null when the cut does not close.
 */
export function clipPlane(tris, axis, c, s) {
  const out = [], segs = [];
  const side = v => s * (v - c);
  const put = p => out.push(p[0], p[1], p[2]);
  // the crossing on an edge, from its two ends taken in a fixed order (so both triangles on the edge agree)
  const crossing = (A, B, da, db) => {
    const swap = A[0] > B[0] || (A[0] === B[0] && (A[1] > B[1] || (A[1] === B[1] && A[2] > B[2])));
    if (swap) { [A, B] = [B, A]; [da, db] = [db, da]; }
    const t = da / (da - db), X = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t];
    X[axis] = c;
    return X;
  };
  for (let i = 0; i + 8 < tris.length; i += 9) {
    const V = [[tris[i], tris[i + 1], tris[i + 2]], [tris[i + 3], tris[i + 4], tris[i + 5]], [tris[i + 6], tris[i + 7], tris[i + 8]]];
    const D = V.map(p => side(p[axis])), keep = D.map(d => d <= EPS);
    if (keep[0] && keep[1] && keep[2]) { put(V[0]); put(V[1]); put(V[2]); continue; }
    if (!keep[0] && !keep[1] && !keep[2]) continue;
    const poly = [], cut = [];
    for (let k = 0; k < 3; k++) {
      const a = k, b = (k + 1) % 3;
      if (keep[a]) poly.push(V[a]);
      if (keep[a] !== keep[b]) { const X = crossing(V[a], V[b], D[a], D[b]); poly.push(X); cut.push(X); }
    }
    for (let m = 1; m + 1 < poly.length; m++) { put(poly[0]); put(poly[m]); put(poly[m + 1]); }
    if (cut.length === 2) segs.push(cut);
  }
  if (!segs.length) return new Float32Array(out);
  // the cap: chain the cut's segments into loops in the plane (u along the plate's edge, v up)
  const u = 1 - axis, keyOf = p => `${Math.round(p[u] * 1e6)},${Math.round(p[2] * 1e6)}`;
  const at = new Map(), nbr = new Map();
  for (const [p, q] of segs) {
    const kp = keyOf(p), kq = keyOf(q);
    if (kp === kq) continue;   // a crossing at a corner of the triangle: no length
    at.set(kp, p); at.set(kq, q);
    if (!nbr.has(kp)) nbr.set(kp, []);
    if (!nbr.has(kq)) nbr.set(kq, []);
    nbr.get(kp).push(kq); nbr.get(kq).push(kp);
  }
  for (const list of nbr.values()) if (list.length !== 2) return null;   // the cut does not close into simple loops
  const rings = [], seen = new Set();
  for (const start of nbr.keys()) {
    if (seen.has(start)) continue;
    const ring = [];
    let prev = null, cur = start;
    while (!seen.has(cur)) {
      seen.add(cur);
      const p = at.get(cur);
      ring.push([p[u], p[2]]);
      const [a, b] = nbr.get(cur), next = a !== prev ? a : b;
      prev = cur; cur = next;
    }
    if (cur !== start || ring.length < 3) return null;
    ring.push([ring[0][0], ring[0][1]]);
    rings.push(ring);
  }
  const to3 = ([a, b]) => { const p = [0, 0, b]; p[axis] = c; p[u] = a; return p; };
  // each outline turned to face out of the cut: seen from outside, an outline runs counter-clockwise and a hole
  // clockwise. In the plane's (u, z), counter-clockwise faces +x on an x cut and -y on a y cut.
  const want = (axis === 0 ? 1 : -1) * s;
  const turn = (r, sign) => (Math.sign(P.ringArea(r)) === sign ? r : r.slice().reverse());
  for (const poly of nestRings(rings, 0)) {
    const clean = [];
    let lost = false;
    poly.forEach((ring, h) => {
      const { pts, flat } = dropInLine(turn(ring, h ? -want : want).slice(0, -1));
      // a point taken out keeps its triangle in the outline's own order: its edges then run against the walls'
      for (const [a, b, cc] of flat) { put(to3(a)); put(to3(b)); put(to3(cc)); }
      if (pts.length >= 3) clean.push([...pts, [pts[0][0], pts[0][1]]]);
      else if (!h) lost = true;
    });
    if (lost || !clean.length) continue;
    const tri = triangulate(clean, true);
    for (let m = 0; m < tri.length; m += 3) {
      let A = to3(tri[m]), B = to3(tri[m + 1]), C = to3(tri[m + 2]);
      // facing out of the kept side: the normal's component along the axis has the sign s
      const n = (B[(axis + 1) % 3] - A[(axis + 1) % 3]) * (C[(axis + 2) % 3] - A[(axis + 2) % 3]) - (B[(axis + 2) % 3] - A[(axis + 2) % 3]) * (C[(axis + 1) % 3] - A[(axis + 1) % 3]);
      if (n * s < 0) [B, C] = [C, B];
      put(A); put(B); put(C);
    }
  }
  return new Float32Array(out);
}

/**
 * A body built over the part of the plate it keeps (a tapered drawing, from the grid mesher), whose outline can
 * still sit up to half a raster cell past the edge: every point past it is pulled onto it. The same point always
 * lands in the same place, so the body stays exactly as closed as it was, and its side there is flush with the
 * plate's. The same array when nothing is past the edge.
 */
export function clampTrisToPlate(tris, W, H) {
  let past = false;
  for (let i = 0; i < tris.length; i += 3) if (Math.abs(tris[i]) > W / 2 || Math.abs(tris[i + 1]) > H / 2) { past = true; break; }
  if (!past) return tris;
  const out = new Float32Array(tris.length), hw = Math.fround(W / 2), hh = Math.fround(H / 2);
  for (let i = 0; i < tris.length; i += 3) {
    out[i] = Math.min(hw, Math.max(-hw, tris[i])); out[i + 1] = Math.min(hh, Math.max(-hh, tris[i + 1])); out[i + 2] = tris[i + 2];
  }
  return out;
}

/**
 * A body cut to the plate (|x| <= W / 2, |y| <= H / 2): only the sides it crosses are cut. Returns the new
 * triangles, the same array when it lies inside, or null when a cut does not close.
 */
export function clipTrisToPlate(tris, W, H) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < tris.length; i += 3) { const x = tris[i], y = tris[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  let t = tris;
  const sides = [[0, W / 2, 1, x1 > W / 2 + EPS], [0, -W / 2, -1, x0 < -W / 2 - EPS], [1, H / 2, 1, y1 > H / 2 + EPS], [1, -H / 2, -1, y0 < -H / 2 - EPS]];
  for (const [axis, c, s, crosses] of sides) {
    if (!crosses) continue;
    t = clipPlane(t, axis, c, s);
    if (!t) return null;
  }
  return t;
}

/**
 * A placed body (a block, a grip, a mesh) cut to the plate, with its outlines cut to match. The same object when
 * it lies inside the plate or the cut fails (the checks then report it past the edge); { removed: true, unclipped }
 * when nothing of it is left on the plate. The cut one keeps the whole footprint as `unclipped`, so the checks can
 * tell how much of it the plate took.
 */
export function clipSolidToPlate(g, W, H) {
  const b = P.bbox(g.footprint);
  if (!b || !Number.isFinite(b.x0) || (b.x0 >= -W / 2 - EPS && b.x1 <= W / 2 + EPS && b.y0 >= -H / 2 - EPS && b.y1 <= H / 2 + EPS)) return g;
  const tris = clipTrisToPlate(g.tris, W, H);
  if (!tris) return g;
  if (!tris.length) return { removed: true, unclipped: g.footprint, name: g.name };
  const plate = P.rect(-W / 2, -H / 2, W / 2, H / 2), cut = mp => (mp && mp.length ? P.intersection(mp, plate) : mp);
  let z1 = g.z0;
  for (let i = 2; i < tris.length; i += 3) if (tris[i] > z1) z1 = tris[i];
  const occupies = g.occupies ? (z0, zz) => cut(g.occupies(z0, zz)) : undefined;
  return { ...g, tris, footprint: cut(g.footprint), base: cut(g.base), top: g.top ? cut(g.top) : null, clear: g.clear ? cut(g.clear) : g.clear, occupies, z1, unclipped: g.unclipped || g.footprint };
}
