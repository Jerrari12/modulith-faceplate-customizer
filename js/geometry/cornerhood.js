// The EdgeLabel faceplate's grip, rebuilt from the shipped models (measured 2026-11-07 off the viewer's GLB Library,
// Faceplate_EdgeLabel_*, the grip-colour primitive above its 2 mm band): a hood in the plate's top-right corner,
// 17.6 mm proud, the same on every size. Two 2 mm blades at 45 degrees make its roof - one along the top edge leaning
// down the face, one running diagonally across the corner (45 degrees in plan) leaning toward the lower right - and
// both stand on 1 mm upright feet. A vertical cut on the corner's diagonal is its open front and a cut 27 mm down
// the face its bottom; the finger pocket under the roof opens through both, and through the face. On 3W and 4W the
// series puts a second hood 176 mm to the left (one per 2W from the right).
//
// Corner coordinates: x <= 0 left from the corner, y <= 0 down from the top edge, h >= 0 out of the face. The body is
// the convex outer region less the convex pocket: each outer face is cut where the pocket opens through it, and the
// pocket's own walls close the cavity.

import * as P from './polys.js';
import { triangulate } from './extrude.js';

const R2 = Math.SQRT2;
// half-spaces n . (x, y, h) <= d
const OUTER = [
  { n: [1, -1, 0], d: 0 },            // the front cut on the corner's diagonal (y >= x)
  { n: [0, -1, 0], d: 27 },           // the bottom cut, 27 mm down the face
  { n: [0, 1, 1], d: 0 },             // the top blade's outer face, meeting the top edge at the face
  { n: [-1, 1, R2], d: 25.81 },       // the diagonal blade's outer face
  { n: [0, 0, -1], d: 0 },            // the face
  { n: [0, 0, 1], d: 17.6 },          // the flat at the apex
];
const POCKET = [
  { n: [-1, 1, R2], d: 21.81 },       // the diagonal blade's underside (2 mm blade)
  { n: [-1, 1, 0], d: 20.44 },        // ... its foot, upright for the first 1 mm
  { n: [0, 1, 1], d: -2.82 },         // the top blade's underside (2 mm)
  { n: [0, 1, 0], d: -3.85 },         // ... its foot
];
export const CORNER_HOOD = { height: 17.6, depth: 27, pitch: 176 };

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => { const l = Math.hypot(...a); return a.map(v => v / l); };

/** The polygon a plane cuts from a set of half-spaces (3D points, counter-clockwise about the plane's normal). */
function faceOf(plane, halves) {
  const n = unit(plane.n), o = n.map(v => v * plane.d / Math.hypot(...plane.n));
  const e1 = unit(Math.abs(n[2]) < 0.9 ? cross([0, 0, 1], n) : cross([1, 0, 0], n)), e2 = cross(n, e1), S = 400;
  let poly = [[-S, -S], [S, -S], [S, S], [-S, S]].map(([a, b]) => [o[0] + a * e1[0] + b * e2[0], o[1] + a * e1[1] + b * e2[1], o[2] + a * e1[2] + b * e2[2]]);
  for (const hs of halves) {
    if (hs === plane) continue;
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length], fp = dot(hs.n, p) - hs.d, fq = dot(hs.n, q) - hs.d;
      if (fp <= 1e-9) out.push(p);
      if ((fp < -1e-9 && fq > 1e-9) || (fp > 1e-9 && fq < -1e-9)) { const s = fp / (fp - fq); out.push(p.map((v, k) => v + (q[k] - v) * s)); }
    }
    poly = out;
    if (poly.length < 3) return { poly: [], o, e1, e2, n };
  }
  return { poly, o, e1, e2, n };
}
const to2 = (f, p) => { const r = sub(p, f.o); return [dot(r, f.e1), dot(r, f.e2)]; };
const to3 = (f, [a, b]) => [f.o[0] + a * f.e1[0] + b * f.e2[0], f.o[1] + a * f.e1[1] + b * f.e2[1], f.o[2] + a * f.e1[2] + b * f.e2[2]];

/** The horizontal slice of a set of half-spaces at height h, as a plan polygon (MultiPolygon), or []. */
function sliceAt(halves, h) {
  const f = faceOf({ n: [0, 0, 1], d: h }, halves.filter(s => !(s.n[0] === 0 && s.n[1] === 0)));
  if (f.poly.length < 3) return [];
  const ring = f.poly.map(p => [p[0], p[1]]);
  return [[[...ring, ring[0]]]];
}

/**
 * One corner hood in corner coordinates: { tris, footprint, base, top, height, overhang, occupies(z0, z1), pull }.
 * `pull` is where fingers pull it (the middle of the flat at the apex, in plan).
 */
export function cornerHood() {
  const tris = [];
  const push = (a, b, c) => tris.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  const emit = (f, mp, flip) => {
    for (const poly of mp) {
      const t = triangulate(poly, true);   // counter-clockwise about the face's normal
      for (let k = 0; k < t.length; k += 3) { const [a, b, c] = t.slice(k, k + 3).map(q => to3(f, q)); if (flip) push(a, c, b); else push(a, b, c); }
    }
  };
  const cavity = [...POCKET, ...OUTER];
  // the outer faces, less the pocket's openings through them
  for (const plane of OUTER) {
    const f = faceOf(plane, OUTER);
    if (f.poly.length < 3) continue;
    const ring = f.poly.map(p => to2(f, p));
    let mp = [[[...ring, ring[0]]]];
    // the opening, run a hair past this face's edges where the pocket leaves through a neighbouring face too, so the
    // cut crosses the edge cleanly instead of running along it (which leaves hairline slivers)
    const hole = faceOf(plane, [...POCKET, ...OUTER.map(s => (s === plane ? s : { n: s.n, d: s.d + 0.01 * Math.hypot(...s.n) }))]);
    if (hole.poly.length >= 3) { const hr = hole.poly.map(p => to2(f, p)); mp = P.difference(mp, [[[...hr, hr[0]]]]); }
    emit(f, mp, false);
  }
  // the pocket's walls, facing into it
  for (const plane of POCKET) {
    const f = faceOf(plane, cavity);
    if (f.poly.length < 3) continue;
    const ring = f.poly.map(p => to2(f, p));
    emit(f, [[[...ring, ring[0]]]], true);
  }
  for (let i = 0; i < tris.length; i++) if (Math.abs(tris[i]) < 1e-9) tris[i] = 0;   // no -0 or 1e-15 on the face
  // the pocket's plan slices are taken a hair past the outer cuts it opens through, so subtracting them cuts cleanly
  // (an exact one shares the front and bottom edges and leaves zero-width spikes along them)
  const loose = [...POCKET, ...OUTER.map(s => ({ n: s.n, d: s.d + 0.01 * Math.hypot(...s.n) }))];
  const footprint = sliceAt(OUTER, 0);
  const base = P.difference(footprint, sliceAt(loose, 0));
  const top = sliceAt(OUTER, CORNER_HOOD.height - 1e-6);
  const tb = P.bbox(top);
  // material between two heights: the outer slice at the lower height (the hood narrows as it rises) less the pocket
  // slice at the upper one (the pocket narrows too, so what is pocket there is pocket all the way down)
  const occupies = (z0, z1) => {
    z0 = Math.max(0, z0); z1 = Math.min(CORNER_HOOD.height, z1);
    if (z1 <= 1e-9 || z1 < z0) return [];
    const o = sliceAt(OUTER, z0), c = sliceAt(loose, z1);
    return c.length ? P.difference(o, c) : o;
  };
  return { tris, footprint, base, top, height: CORNER_HOOD.height, overhang: 45, bridge: 0, occupies, pull: [(tb.x0 + tb.x1) / 2, (tb.y0 + tb.y1) / 2] };
}
