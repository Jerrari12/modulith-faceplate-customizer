// Solid building blocks: boxes, cylinders, tapers, domes, pyramids and wedges that stand on the face or stack on
// each other, so a handle can be built up from simple pieces. Each is a closed triangle mesh lofted from convex
// cross-sections (a rounded rectangle or an ellipse), with square, chamfered or rounded top edges. Top edges only:
// a bottom chamfer would be an overhang when printed face up.
//
// Frame as everywhere: x across the plate, y up the plate, z out of the face. A body is built at the origin with
// its bottom at z = 0; the face builder moves it to its anchor and to the height it sits at.

import * as P from './polys.js';
import { sweepProfileX, transformTriangles } from './extrude.js';

export const SOLID_SHAPES = [['box', 'Box'], ['cylinder', 'Cylinder'], ['taper', 'Taper'], ['dome', 'Dome'], ['pyramid', 'Pyramid'], ['wedge', 'Wedge']];
export const SOLID_EDGES = [['square', 'Square'], ['chamfer', 'Chamfer'], ['round', 'Round']];

const N_RING = 48;   // points per cross-section; a multiple of 4 so a rounded rectangle gets equal corners

/** A convex cross-section: half sizes a x b, corner radius r (rounded rectangle) or an ellipse; CCW, N_RING points. */
function section(round, a, b, r) {
  const pts = [];
  if (round) {
    for (let i = 0; i < N_RING; i++) { const t = (i / N_RING) * 2 * Math.PI; pts.push([a * Math.cos(t), b * Math.sin(t)]); }
    return pts;
  }
  r = Math.max(0, Math.min(r, a, b));
  const q = N_RING / 4;
  const corners = [[a - r, b - r, 0], [-a + r, b - r, Math.PI / 2], [-a + r, -b + r, Math.PI], [a - r, -b + r, 1.5 * Math.PI]];
  for (const [cx, cy, a0] of corners) for (let i = 0; i < q; i++) { const t = a0 + (i / (q - 1)) * Math.PI / 2; pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
  return pts;
}

/** Stack of cross-sections: [{ z, s (scale of the base), d (inset) }], bottom first. */
function levels(el, h, a, b) {
  const shape = el.shape;
  if (shape === 'dome') {
    const out = [];
    for (let k = 0; k <= 12; k++) { const th = (k / 12) * Math.PI / 2; out.push({ z: h * Math.sin(th), s: Math.cos(th), d: 0 }); }
    return out;
  }
  const sTop = shape === 'pyramid' ? 0 : shape === 'taper' ? Math.max(0.05, Math.min(1.5, el.taper ?? 0.6)) : 1;
  const scaleAt = z => 1 + (sTop - 1) * z / h;
  const edge = shape === 'pyramid' ? 'square' : (el.edge || 'square');
  const e = Math.max(0, Math.min(el.edgeSize ?? 1, h * 0.9, Math.min(a, b) * sTop * 0.9));
  if (edge === 'square' || e < 0.05) return [{ z: 0, s: 1, d: 0 }, { z: h, s: sTop, d: 0 }];
  if (edge === 'chamfer') return [{ z: 0, s: 1, d: 0 }, { z: h - e, s: scaleAt(h - e), d: 0 }, { z: h, s: sTop, d: e }];
  const out = [{ z: 0, s: 1, d: 0 }];
  for (let k = 0; k <= 8; k++) { const th = (k / 8) * Math.PI / 2, z = h - e + e * Math.sin(th); out.push({ z, s: scaleAt(z), d: e * (1 - Math.cos(th)) }); }
  return out;
}

/** Convex hull of 2D points (monotone chain), counter-clockwise. A loft between convex, concentric cross-sections
 *  projects onto exactly this outline, which no single cross-section is when a wider-than-base top is chamfered. */
function hull(points) {
  const pts = points.map(([x, y]) => [x, y]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-12) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-12) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** A ring's points without repeats (a rounded rectangle with no corner radius repeats each corner). */
const distinct = pts => pts.filter((p, i) => { const q = pts[(i + pts.length - 1) % pts.length]; return Math.abs(p[0] - q[0]) > 1e-9 || Math.abs(p[1] - q[1]) > 1e-9; });

function pushTri(out, a, b, c) { out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); }

/** Loft convex rings (same point count, CCW) into a closed mesh; a ring that has shrunk to nothing becomes an apex. */
function loft(rings) {
  const out = [];
  const n = rings[0].pts.length;
  const ring3 = R => R.pts.map(([x, y]) => [x, y, R.z]);
  const isPoint = R => R.pts.every(([x, y]) => Math.abs(x) < 1e-4 && Math.abs(y) < 1e-4);
  const bottom = ring3(rings[0]);
  const c0 = [0, 0, rings[0].z];
  for (let i = 0; i < n; i++) pushTri(out, c0, bottom[(i + 1) % n], bottom[i]);          // bottom, facing down
  for (let k = 0; k + 1 < rings.length; k++) {
    const A = ring3(rings[k]), top = rings[k + 1];
    if (isPoint(top)) { const apex = [0, 0, top.z]; for (let i = 0; i < n; i++) pushTri(out, A[i], A[(i + 1) % n], apex); return out; }
    const B = ring3(top);
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; pushTri(out, A[i], A[j], B[j]); pushTri(out, A[i], B[j], B[i]); }
  }
  const T = ring3(rings[rings.length - 1]), cT = [0, 0, rings[rings.length - 1].z];
  for (let i = 0; i < n; i++) pushTri(out, cT, T[i], T[(i + 1) % n]);                      // top, facing up
  return out;
}

/** Down-facing surface above the bottom, by angle from vertical: { worst, area45, area60 } (as for meshes). */
export function overhangStats(t) {
  let worst = 0, area45 = 0, area60 = 0;
  for (let i = 0; i < t.length; i += 9) {
    const ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2], vx = t[i + 6] - t[i], vy = t[i + 7] - t[i + 1], vz = t[i + 8] - t[i + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz); if (L < 1e-9) continue;
    if (nz / L > -0.02) continue;
    if (t[i + 2] <= 0.05 && t[i + 5] <= 0.05 && t[i + 8] <= 0.05) continue;   // the bottom
    const deg = Math.atan2(-nz / L, Math.hypot(nx, ny) / L) * 180 / Math.PI;
    if (deg > worst) worst = deg;
    if (deg > 45) area45 += L / 2;
    if (deg > 60) area60 += L / 2;
  }
  return { worst, area45, area60 };
}

const cache = new Map();

/**
 * The size-independent body of a solid element, at the origin with its bottom at z = 0 and its rotation applied:
 * { tris, footprint, base, top, height, overhang, area45, area60 }. `top` is the flat top a block stacked on this
 * one can stand on (null for domes, pyramids and wedges).
 */
export function solidBody(el) {
  const sig = JSON.stringify([el.shape, el.w, el.h, el.out, el.corner, el.edge, el.edgeSize, el.taper, el.rotation]);
  const hit = cache.get(el.id);
  if (hit && hit.sig === sig) return hit;
  const a = Math.max(0.25, (el.w || 30) / 2), b = Math.max(0.25, (el.h || 12) / 2), height = Math.max(0.2, el.out || 6);
  const rot = el.rotation || 0;
  let tris, footprint, base, top = null;
  if (el.shape === 'wedge') {
    // a ramp rising toward the top of the plate: full height along the top edge, nothing at the bottom edge
    tris = sweepProfileX([[-b, 0], [b, 0], [b, height]], -a, a);
    footprint = base = P.rect(-a, -b, a, b);
  } else {
    const round = el.shape === 'cylinder' || el.shape === 'dome';
    const r = round ? 0 : Math.max(0, el.corner ?? 0);
    const lv = levels(el, height, a, b);
    const rings = lv.map(L => {
      const aa = Math.max(0, a * L.s - L.d), bb = Math.max(0, b * L.s - L.d);
      return { z: L.z, pts: aa < 1e-3 || bb < 1e-3 ? section(round, 0, 0, 0) : section(round, aa, bb, Math.max(0, r * L.s - L.d)) };
    });
    tris = loft(rings);
    const areaOf = R => Math.abs(P.ringArea([...R.pts, R.pts[0]]));
    footprint = P.polygon(hull(rings.flatMap(R => R.pts)));
    base = P.polygon(distinct(rings[0].pts));
    const last = rings[rings.length - 1];
    if (el.shape !== 'dome' && el.shape !== 'pyramid' && areaOf(last) > 0.5) top = P.polygon(distinct(last.pts));
  }
  transformTriangles(tris, rot, 0, 0, 0);
  footprint = P.rotate(footprint, rot); base = P.rotate(base, rot); if (top) top = P.rotate(top, rot);
  const { worst, area45, area60 } = overhangStats(tris);
  const body = { sig, tris, footprint, base, top, height, overhang: worst, area45, area60 };
  cache.set(el.id, body);
  return body;
}

/** A solid's body for a plate: moved to (cx, cy) and lifted to z0. */
export function placeSolid(el, body, cx, cy, z0) {
  const src = body.tris, tris = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) { tris[i] = src[i] + cx; tris[i + 1] = src[i + 1] + cy; tris[i + 2] = src[i + 2] + z0; }
  return {
    tris, color: el.color, elementId: el.id, name: el.name, kind: 'solid', style: el.shape,
    footprint: P.translate(body.footprint, cx, cy), base: P.translate(body.base, cx, cy), top: body.top ? P.translate(body.top, cx, cy) : null,
    z0, z1: z0 + body.height, overhang: body.overhang, area45: body.area45, area60: body.area60,
  };
}

/** The mirror image of a placed solid about x = 0 (the symmetry twin): triangles reflected and re-wound. */
export function mirrorSolid(s) {
  const src = s.tris, tris = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 9) {
    // reflect x and swap the second and third vertices so the normals still face out
    tris[i] = -src[i]; tris[i + 1] = src[i + 1]; tris[i + 2] = src[i + 2];
    tris[i + 3] = -src[i + 6]; tris[i + 4] = src[i + 7]; tris[i + 5] = src[i + 8];
    tris[i + 6] = -src[i + 3]; tris[i + 7] = src[i + 4]; tris[i + 8] = src[i + 5];
  }
  const occupies = s.occupies ? (z0, z1) => P.mirrorX(s.occupies(z0, z1), 0) : undefined;
  return { ...s, tris, footprint: P.mirrorX(s.footprint, 0), base: s.base ? P.mirrorX(s.base, 0) : s.base, top: s.top ? P.mirrorX(s.top, 0) : null, clear: s.clear ? P.mirrorX(s.clear, 0) : s.clear, occupies, twin: true };
}
