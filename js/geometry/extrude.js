// Turns 2D polygons into closed triangle soups. Pure arithmetic apart from three's earcut wrapper, so it runs
// in Node tests as well as the browser. Output triangles are flat number arrays [x,y,z, x,y,z, x,y,z, ...]
// with outward-facing counter-clockwise winding.

import { ShapeUtils, Vector2 } from '../../vendor/three/three.module.js';
import { ringArea } from './polys.js';

export function triangulate(poly, keepDegenerate = false) {
  // poly: [outerRing, ...holeRings], closed rings. Returns [[x,y],[x,y],[x,y], ...] triangles (CCW in xy).
  // keepDegenerate keeps earcut's zero-area triangles (three boundary points in a line): dropping one leaves its two
  // boundary edges unpaired, which opens a closed body that shares those edges with walls
  const contour = poly[0].slice(0, -1).map(([x, y]) => new Vector2(x, y));
  const holes = poly.slice(1).map(r => r.slice(0, -1).map(([x, y]) => new Vector2(x, y)));
  if (contour.length < 3) return [];
  const all = [...contour, ...holes.flat()];
  const tris = ShapeUtils.triangulateShape(contour, holes);
  const out = [];
  for (const [a, b, c] of tris) {
    const A = all[a], B = all[b], C = all[c];
    const s = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
    if (Math.abs(s) < 1e-12 && !keepDegenerate) continue;
    if (s >= 0) out.push([A.x, A.y], [B.x, B.y], [C.x, C.y]); else out.push([A.x, A.y], [C.x, C.y], [B.x, B.y]);
  }
  return out;
}

/**
 * Extrude a MultiPolygon between z0 and z1. Rings must follow the RFC 7946 convention (outer CCW, holes CW),
 * which is what polys.js produces; wall normals then face outward for both kinds of ring.
 */
export function extrudeMultiPolygon(mp, z0, z1, out = []) {
  if (z1 <= z0) return out;
  for (const poly of mp) {
    if (!poly.length || poly[0].length < 4) continue;
    const cap = triangulate(poly);
    for (let i = 0; i < cap.length; i += 3) {
      const [a, b, c] = [cap[i], cap[i + 1], cap[i + 2]];
      out.push(a[0], a[1], z1, b[0], b[1], z1, c[0], c[1], z1);     // top, CCW seen from +z
      out.push(a[0], a[1], z0, c[0], c[1], z0, b[0], b[1], z0);     // bottom, reversed
    }
    poly.forEach((ring, ri) => {
      // outer rings must be CCW and holes CW for the wall winding below; normalise defensively
      const a = ringArea(ring);
      const r = ((ri === 0 && a < 0) || (ri > 0 && a > 0)) ? ring.slice().reverse() : ring;
      for (let i = 0; i < r.length - 1; i++) {
        const [ax, ay] = r[i], [bx, by] = r[i + 1];
        if (ax === bx && ay === by) continue;
        out.push(ax, ay, z0, bx, by, z0, bx, by, z1);
        out.push(ax, ay, z0, bx, by, z1, ax, ay, z1);
      }
    });
  }
  return out;
}

/**
 * Sweep a closed 2D profile (points [u, v]: u across, v up, CCW) along the local x axis from x0 to x1.
 * Returns triangles in local coordinates (x along the sweep, y = u, z = v).
 */
export function sweepProfileX(profile, x0, x1, out = []) {
  const ring = profile.slice();
  if (ringArea([...ring, ring[0]]) < 0) ring.reverse();
  const poly = [[...ring, ring[0]]];
  const tmp = extrudeMultiPolygon([poly], x0, x1);
  // (u, v, w) -> (x = w, y = u, z = v): a cyclic permutation keeps the winding right-handed
  for (let i = 0; i < tmp.length; i += 3) out.push(tmp[i + 2], tmp[i], tmp[i + 1]);
  return out;
}

/** Apply rotation about z (degrees) then translation to a flat triangle array in place. */
export function transformTriangles(tris, rotDeg, dx, dy, dz) {
  const a = (rotDeg || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1];
    tris[i] = x * c - y * s + dx; tris[i + 1] = x * s + y * c + dy; tris[i + 2] += dz;
  }
  return tris;
}

/** Bounding box of a flat triangle array. */
export function trianglesBounds(tris) {
  const b = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1], z = tris[i + 2];
    if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y; if (z < b.z0) b.z0 = z; if (z > b.z1) b.z1 = z;
  }
  return b;
}
