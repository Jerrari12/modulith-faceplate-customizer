// 3D textures: an area of the face lifted into a heightfield, a closed body whose top follows a height map.
//
// The area is meshed on a square grid. Every grid point carries the signed distance to the area's outline
// (positive inside), measured on a raster four times finer than the grid, so marching squares can cut each cell
// that straddles the outline at interpolated points: the outline comes out smooth, not in grid steps, and two
// neighbouring cells meet at the same point on their shared edge, so the top is watertight by construction. Each
// piece of a cell (a square, a clipped square, or a saddle's hexagon or two triangles) is convex and is fanned
// into triangles at the height map's heights. The boundary edges those pieces leave become vertical walls down
// to the body's bottom, and the bottom is the same boundary triangulated flat (earcut), so it shares the walls'
// points exactly. The result is a closed, outward-wound triangle soup.

import * as P from './polys.js';
import { rasterize, distanceTransform } from '../checks/raster.js';
import { nestRings } from './image.js';
import { triangulate, extrudeMultiPolygon } from './extrude.js';
import { ShapeUtils, Vector2 } from '../../vendor/three/three.module.js';
import { CELL_MAPS, cellMesh, latticeMesh, cutLevels, invertMesh } from './cells.js';
import { heightFunction, hash } from './heightmaps.js';
import { offsetPoly } from './offset.js';

export const SURFACE_GRIDS = { fine: 0.25, normal: 0.4, coarse: 0.6 };
export const SURFACE_LIMITS = { maxCells: 160000 };

/**
 * A heightfield body over `region` (a MultiPolygon in mm). `heightAt(x, y)` returns 0..1; the top is at
 * z0 + base + depth * heightAt. The grid is `grid` mm, coarsened so the area's box holds at most maxCells cells.
 * Returns { tris: Float32Array, footprint: MultiPolygon (the meshed outline), z0, z1, grid, cells } or null when
 * the area is empty.
 */
export function surfaceBody(region, heightAt, { z0 = 0, base = 0.4, depth = 0.6, grid = 0.4, maxCells = SURFACE_LIMITS.maxCells } = {}) {
  if (!region || !region.length) return null;
  const b = P.bbox(region);
  if (!b || b.w <= 0 || b.h <= 0) return null;
  const g = Math.max(grid, Math.sqrt((b.w * b.h) / maxCells));
  const nx = Math.ceil(b.w / g) + 3, ny = Math.ceil(b.h / g) + 3;
  const X0 = b.x0 - g, Y0 = b.y0 - g;
  // signed distance at every grid point, from a raster four times finer whose cell centres include the grid points
  const k = 4, res = g / k, rw = (nx - 1) * k + 1, rh = (ny - 1) * k + 1;
  const inside = rasterize(region, X0 - res / 2, Y0 - res / 2, rw, rh, res);
  const outside = new Uint8Array(rw * rh);
  for (let i = 0; i < outside.length; i++) outside[i] = inside[i] ? 0 : 1;
  const dIn = distanceTransform(inside, rw, rh), dOut = distanceTransform(outside, rw, rh, false);
  const f = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const q = (j * k) * rw + i * k;
    f[j * nx + i] = inside[q] ? dIn[q] - 0.5 : 0.5 - dOut[q];
  }
  const zb = z0 + base, H = (x, y) => zb + depth * heightAt(x, y);
  const gx = i => X0 + i * g, gy = j => Y0 + j * g;
  // points, keyed: a grid corner by its index id, a crossing on the horizontal edge from corner id by nGrid + id,
  // one on the vertical edge from corner id by 2 nGrid + id; neighbouring cells share their edge crossings
  const nGrid = nx * ny, pts = new Map();
  const corner = (i, j) => { const key = j * nx + i; if (!pts.has(key)) { const x = gx(i), y = gy(j); pts.set(key, [x, y, H(x, y)]); } return key; };
  const cross = (key, x0, y0, x1, y1, fa, fb) => {
    if (!pts.has(key)) { const t = fa / (fa - fb), x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t; pts.set(key, [x, y, H(x, y)]); }
    return key;
  };
  const hEdge = (i, j) => cross(nGrid + j * nx + i, gx(i), gy(j), gx(i + 1), gy(j), f[j * nx + i], f[j * nx + i + 1]);
  const vEdge = (i, j) => cross(2 * nGrid + j * nx + i, gx(i), gy(j), gx(i), gy(j + 1), f[j * nx + i], f[(j + 1) * nx + i]);
  const top = [], next = new Map();   // next: boundary edge start key -> end key (inside on the left)
  const emit = keys => {
    // a convex piece, counter-clockwise: fan it; the edges between two crossings are the outline
    for (let m = 1; m + 1 < keys.length; m++) top.push(keys[0], keys[m], keys[m + 1]);
    for (let m = 0; m < keys.length; m++) {
      const a = keys[m], c = keys[(m + 1) % keys.length];
      if (a >= nGrid && c >= nGrid) next.set(a, c);
    }
  };
  let cells = 0;
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const fa = f[j * nx + i], fb = f[j * nx + i + 1], fc = f[(j + 1) * nx + i + 1], fd = f[(j + 1) * nx + i];   // bl, br, tr, tl: counter-clockwise
    const ia = fa > 0, ib = fb > 0, ic = fc > 0, id = fd > 0;
    if (!ia && !ib && !ic && !id) continue;
    cells++;
    if (ia && ib && ic && id) {
      // split along the diagonal whose midpoint is nearer the true height at the square's centre, so a ridge or
      // valley running diagonally follows the triangles instead of stepping across them
      const A = corner(i, j), B = corner(i + 1, j), C = corner(i + 1, j + 1), D = corner(i, j + 1);
      const mid = H(gx(i) + g / 2, gy(j) + g / 2);
      if (Math.abs((pts.get(A)[2] + pts.get(C)[2]) / 2 - mid) <= Math.abs((pts.get(B)[2] + pts.get(D)[2]) / 2 - mid)) emit([A, B, C, D]);
      else emit([B, C, D, A]);
      continue;
    }
    const saddle = ia === ic && ib === id && ia !== ib;
    if (saddle && (fa + fb + fc + fd) / 4 <= 0) {
      // the two inside corners stay apart: one triangle at each
      if (ia) { emit([corner(i, j), hEdge(i, j), vEdge(i, j)]); emit([corner(i + 1, j + 1), hEdge(i, j + 1), vEdge(i + 1, j)]); }
      else { emit([corner(i + 1, j), vEdge(i + 1, j), hEdge(i, j)]); emit([corner(i, j + 1), vEdge(i, j), hEdge(i, j + 1)]); }
      continue;
    }
    // walk the square counter-clockwise: inside corners, and a crossing wherever the sign changes along an edge
    const keys = [];
    if (ia) keys.push(corner(i, j));
    if (ia !== ib) keys.push(hEdge(i, j));
    if (ib) keys.push(corner(i + 1, j));
    if (ib !== ic) keys.push(vEdge(i + 1, j));
    if (ic) keys.push(corner(i + 1, j + 1));
    if (ic !== id) keys.push(hEdge(i, j + 1));
    if (id) keys.push(corner(i, j + 1));
    if (id !== ia) keys.push(vEdge(i, j));
    emit(keys);
  }
  if (!top.length) return null;
  // the outline: chain the boundary edges into loops
  const loops = [], seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let cur = start;
    while (cur != null && !seen.has(cur)) { seen.add(cur); loop.push(cur); cur = next.get(cur); }
    if (loop.length >= 3) loops.push(loop);
  }
  // top vertices, two wall triangles per boundary edge, and at most edges + 4 per loop bottom triangles
  const E = loops.reduce((s, l) => s + l.length, 0);
  const out = new Float32Array(top.length * 3 + E * 18 + (E + 4 * loops.length) * 9);
  let o = 0;
  const put = (x, y, z) => { out[o++] = x; out[o++] = y; out[o++] = z; };
  for (let m = 0; m < top.length; m++) { const p = pts.get(top[m]); put(p[0], p[1], p[2]); }
  // walls: inside on the left of a -> c, so (a0, c0, c1) and (a0, c1, a1) face outward
  for (const loop of loops) for (let m = 0; m < loop.length; m++) {
    const a = pts.get(loop[m]), c = pts.get(loop[(m + 1) % loop.length]);
    put(a[0], a[1], z0); put(c[0], c[1], z0); put(c[0], c[1], c[2]);
    put(a[0], a[1], z0); put(c[0], c[1], c[2]); put(a[0], a[1], a[2]);
  }
  // the bottom: the same outline, triangulated flat and facing down
  const rings = loops.map(l => { const r = l.map(key => { const p = pts.get(key); return [p[0], p[1]]; }); r.push([r[0][0], r[0][1]]); return r; });
  const footprint = nestRings(rings, 0);
  for (const poly of footprint) {
    const cap = triangulate(poly, true);   // zero-area triangles kept: the bottom must pair every wall edge
    for (let m = 0; m < cap.length; m += 3) { put(cap[m][0], cap[m][1], z0); put(cap[m + 2][0], cap[m + 2][1], z0); put(cap[m + 1][0], cap[m + 1][1], z0); }
  }
  let z1 = zb;
  for (const p of pts.values()) if (p[2] > z1) z1 = p[2];
  return { tris: out.subarray(0, o), footprint, z0, z1, grid: g, cells };
}

// ---- exact meshing for the textures with edges (cells.js)

export const surfaceStats = { exact: 0, fallback: 0, coarse: 0, degraded: 0, lastError: '' };

/**
 * A 3D texture's bodies, one per filament (2026-11-11): the texture itself, a flat border or raised rim round it,
 * its cells in up to four colours, and its peaks in a tip colour. Each part is { tris, footprint, z0, z1, grid,
 * exact, colour } where colour is 0..3 (the element's colour, then its cell colours) or 'tip'.
 *
 * The maps with edges are always built exactly (cells.js), and so is a smooth map that asks for terraces, colours
 * or a tip (as a lattice of triangles): exactBody clips them to the area with sharp cliffs. A smooth map with none
 * of those, an edged map whose mesh would be too big, and any exact build that fails its own closure check take
 * the grid mesher instead (counted in surfaceStats), as one body in the element's colour.
 *
 * o: { z0, base, depth, grid, maxCells, terrace (step in mm, 0 off), edge ('none' | 'border' | 'rim'), edgeW (mm),
 * colors (1..4), colorMode ('random' | 'height'), tipAt (0..1 of the depth, or null) }
 */
export function textureBodies(region, opts, { z0 = 0, base = 0.4, depth = 0.6, grid = 0.4, maxCells = SURFACE_LIMITS.maxCells, terrace = 0, edge = 'none', edgeW = 2, colors = 1, colorMode = 'random', tipAt = null } = {}) {
  if (!region || !region.length) return [];
  const parts = [];
  let area = region;
  if (edge === 'border' || edge === 'rim') {
    // the texture keeps to an inset of the area; the band round it is a flat border at the base, or a rim at the top
    let inner = [];
    try { inner = offsetPoly(region, -Math.max(0.2, Number(edgeW) || 2)); } catch { inner = []; }
    const ring = P.isEmpty(inner) ? region : P.difference(region, inner), rb = P.bbox(ring);
    if (rb && rb.w > 0 && rb.h > 0) {
      // one flat face over the band's box, clipped to it exactly: at the base for a border, at the top for a rim
      const H = edge === 'rim' ? 1 : 0, flat = { pts: [[rb.x0 - 1, rb.y0 - 1], [rb.x1 + 1, rb.y0 - 1], [rb.x1 + 1, rb.y1 + 1], [rb.x0 - 1, rb.y1 + 1]], faces: [{ v: [0, 1, 2, 3], h: [H, H, H, H], cell: 0, tile: 0 }], cells: 1 };
      try {
        const body = exactBody(ring, flat, { z0, base, depth });
        if (body) parts.push({ ...body, colour: 0, edge: true });
      } catch (e) {
        surfaceStats.fallback++; surfaceStats.lastError = e.message;
        const top = z0 + Math.max(0.01, base) + depth * H;
        parts.push({ tris: Float32Array.from(extrudeMultiPolygon(ring, z0, top)), footprint: ring, z0, z1: top, grid: 0, exact: false, colour: 0, edge: true });
      }
    }
    area = inner;
    if (P.isEmpty(area)) return parts;
  }
  const b = P.bbox(area);
  if (!b || b.w <= 0 || b.h <= 0) return parts;
  const n = Math.max(1, Math.min(4, Math.round(Number(colors)) || 1));
  const tip = Number.isFinite(tipAt) && tipAt > 0.02 && tipAt < 0.98 ? tipAt : null;
  const step = Number(terrace) > 0 ? Math.min(depth, Number(terrace)) : 0;
  const edged = CELL_MAPS.has(opts.map);
  if (edged || step > 0 || n > 1 || tip !== null) {
    const g = Math.max(grid, Math.sqrt((b.w * b.h) / maxCells));
    try {
      // a smooth map's lattice here is no finer than 0.6 mm: its slopes are gentle, and terraces or colour bands
      // double its triangles (a 2W-1H face at 0.4 mm took several seconds and half a million triangles)
      const gm = edged ? g : Math.max(g, 0.6);
      let mesh = edged ? cellMesh(opts, b, g) : latticeMesh(heightFunction({ ...opts, invert: false }), b, gm);
      if (!mesh) surfaceStats.coarse++;
      else {
        if (opts.invert) mesh = invertMesh(mesh);
        // terraces: flat steps every `step` mm from the base up (floored, so they never pass the texture's height)
        if (step > 0) {
          const q = step / depth, levels = [];
          for (let m = 1; m * q < 1 - 1e-9; m++) levels.push(m * q);
          mesh = cutLevels(mesh, levels, { values: [0, ...levels] });
        }
        // colours: a cell or stone each, at random or by its height; a smooth map's colours are height bands
        if (n > 1) {
          if (colorMode === 'height' || !edged) {
            if (edged) {
              const top = tileHeights(mesh);
              let lo = Infinity, hi = -Infinity;
              for (const h of top.values()) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
              const span = hi - lo > 1e-6 ? hi - lo : 1;
              mesh = { ...mesh, faces: mesh.faces.map(f => ({ ...f, col: Math.min(n - 1, Math.floor(((top.get(f.tile) - lo) / span) * n)) })) };
            } else {
              mesh = cutLevels(mesh, Array.from({ length: n - 1 }, (_, k) => (k + 1) / n));
              mesh = { ...mesh, faces: mesh.faces.map(f => ({ ...f, col: f.band })) };
            }
          } else {
            const sd = Math.round(Number(opts.seed) || 0);
            mesh = { ...mesh, faces: mesh.faces.map(f => ({ ...f, col: Math.min(n - 1, Math.floor(hash(sd, f.tile & 0xffff, f.tile >>> 16, 13) * n)) })) };
          }
        }
        let made;
        try { made = exactParts(area, mesh, { z0, base, depth, n, tip }); } catch (e) {
          if (n === 1 && tip === null) throw e;
          // the colours or the tip would not close here (cliffs, colours and the outline all meeting at one corner
          // can make two pieces touch along an edge): the texture alone, still exact, in its own colour
          surfaceStats.degraded++; surfaceStats.lastError = e.message;
          made = exactParts(area, mesh, { z0, base, depth, n: 1, tip: null }).map(p => ({ ...p, dropped: true }));
        }
        for (const part of made) parts.push({ ...part, grid: gm });
        surfaceStats.exact++;
        return parts;
      }
    } catch (e) { surfaceStats.fallback++; surfaceStats.lastError = e.message; }
  }
  const body = surfaceBody(area, heightFunction(opts), { z0, base, depth, grid, maxCells });
  if (body) parts.push({ ...body, colour: 0 });
  return parts;
}

/**
 * Each tile's mean height (0..1) over its area: per face, a fan of triangles from its first corner, each its area
 * times its corners' mean height, which is exact for a height linear over a planar face (a vertex mean is not).
 */
export function tileHeights(mesh) {
  const wsum = new Map(), asum = new Map(), top = new Map();
  for (const f of mesh.faces) {
    let a = 0, w = 0;
    const p0 = mesh.pts[f.v[0]];
    for (let i = 1; i + 1 < f.v.length; i++) {
      const p = mesh.pts[f.v[i]], q = mesh.pts[f.v[i + 1]], at = ((p[0] - p0[0]) * (q[1] - p0[1]) - (q[0] - p0[0]) * (p[1] - p0[1])) / 2;
      a += at; w += at * (f.h[0] + f.h[i] + f.h[i + 1]) / 3;
    }
    if (a < 0) { a = -a; w = -w; }
    wsum.set(f.tile, (wsum.get(f.tile) || 0) + w);
    asum.set(f.tile, (asum.get(f.tile) || 0) + a);
  }
  for (const [t, w] of wsum) top.set(t, w / Math.max(1e-12, asum.get(t)));
  return top;
}

/** The exact bodies of a prepared mesh: one per colour present, and a tip body above `tip` (0..1) if asked. */
function exactParts(area, mesh, { z0, base, depth, n, tip }) {
  const out = [];
  let lower = mesh, upper = null;
  if (tip !== null) {
    const cut = cutLevels(mesh, [tip]);
    // below the tip: everything, its peaks cut off flat at the tip; above it: the peaks, standing on that cut
    // (capped at the tip throughout: a crossing slid clear of a corner sits a hair off the level)
    lower = { ...cut, faces: cut.faces.map(f => ({ ...f, h: f.h.map(h => (f.band === 1 ? tip : Math.min(h, tip))) })) };
    upper = { ...cut, faces: cut.faces.map(f => ({ ...f, h: f.h.map(h => Math.max(0, (h - tip) / (1 - tip))) })) };
  }
  for (let c = 0; c < n; c++) {
    if (n > 1 && !lower.faces.some(f => f.col === c)) continue;
    const body = exactBody(area, lower, { z0, base, depth, filter: n > 1 ? fi => lower.faces[fi].col === c : null });
    if (body) out.push({ ...body, colour: c });
  }
  if (upper && upper.faces.some(f => f.band === 1)) {
    // the tip body stands on the lower body's flat cut with a base of TIP_SINK sunk into it: a body that thinned
    // to nothing at its edge would have corners closer to its bottom than the 3MF writer's weld, which folds it
    const zt = Math.round((z0 + Math.max(0.01, base) + depth * tip) * 1e5) / 1e5;
    const body = exactBody(area, upper, { z0: zt - TIP_SINK, base: TIP_SINK, depth: depth * (1 - tip), filter: fi => upper.faces[fi].band === 1 });
    if (body) out.push({ ...body, colour: 'tip' });
  }
  return out;
}

/** How far a tip colour's body reaches down into the texture under it (mm): a quarter of a fine layer. */
export const TIP_SINK = 0.05;

/** One body (the first of textureBodies): a texture with no border, colours or tip. */
export function textureBody(region, opts, o = {}) {
  const parts = textureBodies(region, opts, o);
  return parts.length ? parts[0] : null;
}

const orient = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
const NUDGE = 3e-4;
/** (x, y) moved straight off the segment to NUDGE from it when it is nearer than that; null when it is not. */
function awayFrom(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / L2)) : 0;
  const cx = x1 + dx * t, cy = y1 + dy * t;
  let nx = x - cx, ny = y - cy;
  const d = Math.hypot(nx, ny);
  if (d >= NUDGE) return null;
  if (d > 1e-12) { nx /= d; ny /= d; } else { const L = Math.sqrt(L2) || 1; nx = -dy / L; ny = dx / L; }
  return [cx + nx * NUDGE, cy + ny * NUDGE];
}

/**
 * Whether triangle lists close: with vertices renamed by `as` (a weld), triangles whose corners merge dropped,
 * every directed edge must appear exactly once and its reverse exactly once. Sorting the edges and their reverses
 * and comparing the two lists decides it without a hash of every edge. Returns false, or the number of edges left.
 */
function closes(lists, as, W) {
  let E = 0;
  for (const idx of lists) E += idx.length;
  const fwd = new Float64Array(E), rev = new Float64Array(E);
  let n = 0;
  for (const idx of lists) for (let i = 0; i < idx.length; i += 3) {
    const a = as(idx[i]), b = as(idx[i + 1]), c = as(idx[i + 2]);
    if (a === b || b === c || a === c) continue;
    fwd[n] = a * W + b; rev[n++] = b * W + a;
    fwd[n] = b * W + c; rev[n++] = c * W + b;
    fwd[n] = c * W + a; rev[n++] = a * W + c;
  }
  const f = fwd.subarray(0, n).sort(), r = rev.subarray(0, n).sort();
  for (let i = 0; i < n; i++) if (f[i] !== r[i] || (i && f[i] === f[i - 1])) return false;
  return n;
}

/**
 * A closed body over `region` whose top is the planar mesh `mesh` (cells.js) clipped to the area exactly.
 *
 * Faces wholly inside the area stay whole; faces the outline crosses are clipped: the area's edges inside the face
 * and the face's edges inside the area link into loops (holes and all), which earcut triangulates. A crossing point
 * is made once per (area edge, mesh edge), so both faces on that edge share it. Every predicate is evaluated on the
 * mesh edge in one canonical direction, so the two faces always agree on what crosses where.
 *
 * Heights are per cell: a point on an edge between two cells has a height in each, and where they differ the top
 * leaves a cliff. Edges whose two heights cross are split there first, so no wall twists. A top vertex is a point at
 * one height (quantised to 1e-5 mm), so cells that meet at the same height share it. Every edge of the top left
 * without a twin, and every outline edge of the flat bottom, pairs with exactly one other along the same segment;
 * the wall between them passes through every height in the vertical column at each end, so walls that meet at a
 * point share their vertical edges. The result is checked for closure; any failure throws, and the caller falls
 * back to the grid.
 */
export function exactBody(region, mesh, { z0 = 0, base = 0.4, depth = 0.6, invert = false, filter = null, minBase = 0.01 } = {}) {
  // never a zero-thickness skin: top and bottom stay apart, unless the caller stands the body on another (a tip)
  const zb = z0 + Math.max(minBase, base);
  const { pts, faces } = mesh, NG = pts.length;
  // points: the mesh's own, then crossings, splits, area vertices and face centres. pa/pb/pt: an edge point's
  // canonical edge (pa < pb) and parameter along it; pa -1 a free point (height from its face's plane), -2 a mesh point
  const px = [], py = [], pa = [], pb = [], pt = [];
  for (const [x, y] of pts) { px.push(x); py.push(y); pa.push(-2); pb.push(-2); pt.push(0); }
  const addPoint = (x, y, a = -1, b = -1, t = 0) => { px.push(x); py.push(y); pa.push(a); pb.push(b); pt.push(t); return px.length - 1; };

  // ---- the area: outer rings counter-clockwise, holes clockwise; edge e runs from vertex e to anext[e]
  const ax = [], ay = [], anext = [];
  let areaSum = 0;
  for (const poly of region) for (let ri = 0; ri < poly.length; ri++) {
    const r = [];
    for (const [x, y] of poly[ri]) { const l = r[r.length - 1]; if (!l || Math.abs(l[0] - x) > 1e-9 || Math.abs(l[1] - y) > 1e-9) r.push([x, y]); }
    while (r.length > 2 && Math.abs(r[0][0] - r[r.length - 1][0]) <= 1e-9 && Math.abs(r[0][1] - r[r.length - 1][1]) <= 1e-9) r.pop();
    if (r.length < 3) continue;
    let s = 0;
    for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; s += p[0] * q[1] - q[0] * p[1]; }
    if (s === 0) continue;
    if ((ri === 0) !== (s > 0)) { r.reverse(); s = -s; }
    areaSum += s / 2;
    const start = ax.length;
    r.forEach(([x, y], i) => { ax.push(x); ay.push(y); anext.push(start + (i + 1) % r.length); });
  }
  const NE = ax.length;
  if (!NE || areaSum <= 0) return null;
  // Keep every crossing at least NUDGE mm from the points it could be confused with: the 3MF writer welds vertices
  // to 0.0001 mm, and two of ours closer than that would be welded behind the mesh's back. An area corner within
  // NUDGE of a mesh edge or corner moves off it (the area changes by far less than a printer can show); a mesh
  // corner within NUDGE of the outline moves off that, below.
  {
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let i = 0; i < NE; i++) { bx0 = Math.min(bx0, ax[i]); bx1 = Math.max(bx1, ax[i]); by0 = Math.min(by0, ay[i]); by1 = Math.max(by1, ay[i]); }
    const S = Math.max(0.25, Math.max(bx1 - bx0, by1 - by0) / 160), nx = Math.floor((bx1 - bx0) / S) + 1, ny = Math.floor((by1 - by0) / S) + 1;
    const fb = new Array(nx * ny);
    faces.forEach((f, fi) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const v of f.v) { x0 = Math.min(x0, px[v]); x1 = Math.max(x1, px[v]); y0 = Math.min(y0, py[v]); y1 = Math.max(y1, py[v]); }
      if (x1 < bx0 - NUDGE || x0 > bx1 + NUDGE || y1 < by0 - NUDGE || y0 > by1 + NUDGE) return;
      const i0 = Math.max(0, Math.floor((x0 - NUDGE - bx0) / S)), i1 = Math.min(nx - 1, Math.floor((x1 + NUDGE - bx0) / S));
      const j0 = Math.max(0, Math.floor((y0 - NUDGE - by0) / S)), j1 = Math.min(ny - 1, Math.floor((y1 + NUDGE - by0) / S));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const k = j * nx + i; (fb[k] || (fb[k] = [])).push(fi); }
    });
    for (let i = 0; i < NE; i++) for (let pass = 0; pass < 3; pass++) {
      const bi = Math.min(nx - 1, Math.max(0, Math.floor((ax[i] - bx0) / S))), bj = Math.min(ny - 1, Math.max(0, Math.floor((ay[i] - by0) / S)));
      let moved = false;
      for (const fi of fb[bj * nx + bi] || []) {
        const v = faces[fi].v;
        for (let m = 0; m < v.length; m++) {
          const r = awayFrom(ax[i], ay[i], px[v[m]], py[v[m]], px[v[(m + 1) % v.length]], py[v[(m + 1) % v.length]]);
          if (r) { ax[i] = r[0]; ay[i] = r[1]; moved = true; }
        }
      }
      if (!moved) break;
    }
    areaSum = 0;
    for (let i = 0; i < NE; i++) areaSum += (ax[i] * ay[anext[i]] - ax[anext[i]] * ay[i]) / 2;
  }
  // a bucket grid of the area's edges
  let X0 = Infinity, Y0 = Infinity, X1 = -Infinity, Y1 = -Infinity;
  for (let i = 0; i < NE; i++) { X0 = Math.min(X0, ax[i]); X1 = Math.max(X1, ax[i]); Y0 = Math.min(Y0, ay[i]); Y1 = Math.max(Y1, ay[i]); }
  const BS = Math.max(0.25, Math.max(X1 - X0, Y1 - Y0) / 160);
  const nbx = Math.floor((X1 - X0) / BS) + 1, nby = Math.floor((Y1 - Y0) / BS) + 1;
  const buckets = new Array(nbx * nby);
  const col = x => Math.floor((x - X0) / BS), row = y => Math.floor((y - Y0) / BS);
  for (let e = 0; e < NE; e++) {
    const f = anext[e];
    const i0 = Math.max(0, col(Math.min(ax[e], ax[f]))), i1 = Math.min(nbx - 1, col(Math.max(ax[e], ax[f])));
    const j0 = Math.max(0, row(Math.min(ay[e], ay[f]))), j1 = Math.min(nby - 1, row(Math.max(ay[e], ay[f])));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const k = j * nbx + i; (buckets[k] || (buckets[k] = [])).push(e); }
  }
  const stampQ = new Int32Array(NE), stampR = new Int32Array(NE);
  let tagQ = 0, tagR = 0;
  const query = (x0, y0, x1, y1) => {
    const out = [];
    const i0 = Math.max(0, col(x0)), i1 = Math.min(nbx - 1, col(x1)), j0 = Math.max(0, row(y0)), j1 = Math.min(nby - 1, row(y1));
    if (i0 > i1 || j0 > j1) return out;
    tagQ++;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const bk = buckets[j * nbx + i];
      if (bk) for (const e of bk) if (stampQ[e] !== tagQ) { stampQ[e] = tagQ; out.push(e); }
    }
    return out;
  };
  // inside the area: a ray to +x, counted with the half-open rule
  const inArea = (x, y) => {
    if (x < X0 || x > X1 || y < Y0 || y > Y1) return false;
    const j = Math.min(nby - 1, row(y));
    tagR++;
    let n = 0;
    for (let i = Math.max(0, col(x)); i < nbx; i++) {
      const bk = buckets[j * nbx + i];
      if (bk) for (const e of bk) {
        if (stampR[e] === tagR) continue;
        stampR[e] = tagR;
        const f = anext[e], y0 = ay[e], y1 = ay[f];
        if ((y0 > y) !== (y1 > y) && ax[e] + (y - y0) * (ax[f] - ax[e]) / (y1 - y0) > x) n++;
      }
    }
    return (n & 1) === 1;
  };

  for (let v = 0; v < NG; v++) for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const e of query(px[v] - NUDGE, py[v] - NUDGE, px[v] + NUDGE, py[v] + NUDGE)) {
      const f = anext[e], r = awayFrom(px[v], py[v], ax[e], ay[e], ax[f], ay[f]);
      if (r) { px[v] = r[0]; py[v] = r[1]; moved = true; }
    }
    if (!moved) break;
  }

  // ---- heights: canonical per (mesh point, cell), from the first face that has it
  const NC = (mesh.cells || 1) + 1, hc = new Map();
  for (const f of faces) for (let i = 0; i < f.v.length; i++) { const k = f.v[i] * NC + f.cell; if (!hc.has(k)) hc.set(k, f.h[i]); }
  const H = (v, cell) => hc.get(v * NC + cell);
  const planes = new Map();
  const plane = fi => {
    let pl = planes.get(fi);
    if (pl) return pl;
    const f = faces[fi], v = f.v, n = v.length;
    let bi = 1, bj = 2, best = -1;
    for (let i = 1; i < n; i++) for (let j = i + 1; j < n; j++) {
      const s = Math.abs(orient(px[v[0]], py[v[0]], px[v[i]], py[v[i]], px[v[j]], py[v[j]]));
      if (s > best) { best = s; bi = i; bj = j; }
    }
    const x0 = px[v[0]], y0 = py[v[0]], h0 = f.h[0];
    const x1 = px[v[bi]] - x0, y1 = py[v[bi]] - y0, h1 = f.h[bi] - h0, x2 = px[v[bj]] - x0, y2 = py[v[bj]] - y0, h2 = f.h[bj] - h0;
    const d = x1 * y2 - x2 * y1;
    const B = d ? (h1 * y2 - h2 * y1) / d : 0, C = d ? (x1 * h2 - x2 * h1) / d : 0;
    pl = [h0 - B * x0 - C * y0, B, C];
    planes.set(fi, pl);
    return pl;
  };
  const heightIn = (pid, fi) => {
    const f = faces[fi];
    if (pid < NG) return H(pid, f.cell);
    const a = pa[pid];
    if (a >= 0) { const ha = H(a, f.cell), hb = H(pb[pid], f.cell); return ha + (hb - ha) * pt[pid]; }
    const pl = plane(fi);
    return pl[0] + pl[1] * px[pid] + pl[2] * py[pid];
  };

  // ---- the mesh's edges, each with its faces, and the points that will lie on it
  const ekey = (a, b) => (a < b ? a * NG + b : b * NG + a);
  const edges = new Map();   // key -> { a, b, f: [face indices], on: [{ id, t, cross }] }
  faces.forEach((f, fi) => {
    for (let i = 0; i < f.v.length; i++) {
      const p = f.v[i], q = f.v[(i + 1) % f.v.length], k = ekey(p, q);
      const ed = edges.get(k);
      if (ed) ed.f.push(fi); else edges.set(k, { a: Math.min(p, q), b: Math.max(p, q), f: [fi], on: null });
    }
  });
  const onEdge = (k, item) => { const ed = edges.get(k); (ed.on || (ed.on = [])).push(item); };
  // cliffs whose two heights cross part way: split there, so each wall keeps one side above the other
  for (const [k, ed] of edges) {
    if (ed.f.length !== 2) continue;
    const A = faces[ed.f[0]].cell, B = faces[ed.f[1]].cell;
    if (A === B) continue;
    const da = H(ed.a, A) - H(ed.a, B), db = H(ed.b, A) - H(ed.b, B);
    if ((da > 1e-9 && db < -1e-9) || (da < -1e-9 && db > 1e-9)) {
      const t = da / (da - db);
      onEdge(k, { id: addPoint(px[ed.a] + (px[ed.b] - px[ed.a]) * t, py[ed.a] + (py[ed.b] - py[ed.a]) * t, ed.a, ed.b, t), t, cross: false });
    }
  }

  // ---- where the outline meets the mesh: the same answer from both faces of an edge
  const crosses = (e, a, b) => {   // a < b
    const f = anext[e];
    const o1 = orient(ax[e], ay[e], ax[f], ay[f], px[a], py[a]), o2 = orient(ax[e], ay[e], ax[f], ay[f], px[b], py[b]);
    if ((o1 >= 0) === (o2 >= 0)) return null;
    const o3 = orient(px[a], py[a], px[b], py[b], ax[e], ay[e]), o4 = orient(px[a], py[a], px[b], py[b], ax[f], ay[f]);
    if ((o3 >= 0) === (o4 >= 0)) return null;
    return [o1 / (o1 - o2), o3 / (o3 - o4)];   // along a -> b, and along the area edge
  };
  const crossIds = new Map();
  const crossing = (e, a, b) => {
    const c = crosses(e, a, b);
    if (!c) return null;
    const ck = `${e}|${a}|${b}`;
    let id = crossIds.get(ck);
    if (id === undefined) {
      id = addPoint(px[a] + (px[b] - px[a]) * c[0], py[a] + (py[b] - py[a]) * c[0], a, b, c[0]);
      crossIds.set(ck, id);
      onEdge(ekey(a, b), { id, t: c[0], cross: true });
    }
    return { id, s: c[1] };
  };
  // inside a (convex, counter-clockwise) face; a point exactly on an edge belongs to the face that runs it a -> b
  const insideFace = (f, x, y) => {
    const v = f.v, n = v.length;
    for (let i = 0; i < n; i++) {
      const p = v[i], q = v[(i + 1) % n], fwd = p < q, a = fwd ? p : q, b = fwd ? q : p;
      const o = orient(px[a], py[a], px[b], py[b], x, y);
      if (fwd ? o < 0 : o >= 0) return false;
    }
    return true;
  };
  const areaPid = new Int32Array(NE).fill(-1);
  const apid = i => (areaPid[i] >= 0 ? areaPid[i] : (areaPid[i] = addPoint(ax[i], ay[i])));
  const inMesh = new Int8Array(NG);   // 0 unknown, 1 inside, 2 outside
  const inV = v => { if (!inMesh[v]) inMesh[v] = inArea(px[v], py[v]) ? 1 : 2; return inMesh[v] === 1; };

  // ---- which faces the outline touches
  const touching = new Array(faces.length);
  faces.forEach((f, fi) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const v of f.v) { x0 = Math.min(x0, px[v]); x1 = Math.max(x1, px[v]); y0 = Math.min(y0, py[v]); y1 = Math.max(y1, py[v]); }
    const touch = [];
    for (const e of query(x0, y0, x1, y1)) {
      const g = anext[e];
      let hit = insideFace(f, ax[e], ay[e]) || insideFace(f, ax[g], ay[g]);
      for (let i = 0; !hit && i < f.v.length; i++) { const p = f.v[i], q = f.v[(i + 1) % f.v.length]; hit = !!crosses(e, Math.min(p, q), Math.max(p, q)); }
      if (hit) touch.push(e);
    }
    if (touch.length) touching[fi] = touch;
  });
  // the untouched faces in connected groups, each wholly inside or wholly outside: one test per group
  const parent = new Int32Array(faces.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (const ed of edges.values()) if (ed.f.length === 2 && !touching[ed.f[0]] && !touching[ed.f[1]]) { const r0 = find(ed.f[0]), r1 = find(ed.f[1]); if (r0 !== r1) parent[r0] = r1; }
  const groupIn = new Map();

  // ---- the top
  const vx = [], vy = [], vz = [], vp = [], vq = [], cols = new Map();
  const vertex = (pid, zq, z) => {
    let c = cols.get(pid);
    if (!c) { c = []; cols.set(pid, c); }
    for (const id of c) if (vq[id] === zq) return id;
    const id = vx.length;
    vx.push(px[pid]); vy.push(py[pid]); vz.push(z); vp.push(pid); vq.push(zq); c.push(id);
    return id;
  };
  const topVertex = (pid, h) => { const zq = Math.round((zb + depth * (invert ? 1 - h : h)) * 1e5); return vertex(pid, zq, zq / 1e5); };
  const botVertex = pid => vertex(pid, -Infinity, z0);
  const topIdx = [], botIdx = [];
  let topArea = 0;
  // every triangle arrives counter-clockwise: the fans by construction, earcut's in its own order (which it keeps
  // for every triangle, the nearly flat ones included; re-deciding those by sign here would flip some of them)
  const emit = (fi, p, q, r) => {
    topArea += orient(px[p], py[p], px[q], py[q], px[r], py[r]) / 2;
    topIdx.push(topVertex(p, heightIn(p, fi)), topVertex(q, heightIn(q, fi)), topVertex(r, heightIn(r, fi)));
  };
  const sortedOn = (p, q) => {
    const ed = edges.get(ekey(p, q));
    if (!ed || !ed.on) return [];
    const s = ed.on.slice().sort((A, B) => A.t - B.t);
    return p > q ? s.reverse() : s;
  };
  faces.forEach((f, fi) => {
    if (filter && !filter(fi)) return;   // another colour's face: its edges against this colour become outline
    const v = f.v, n = v.length;
    if (!touching[fi]) {
      const root = find(fi);
      let inside = groupIn.get(root);
      if (inside === undefined) {
        let cx = 0, cy = 0;
        for (const id of v) { cx += px[id]; cy += py[id]; }
        inside = inArea(cx / n, cy / n);
        groupIn.set(root, inside);
      }
      if (!inside) return;
      // whole: its corners, and any split points on its edges
      const ring = [];
      let flat = false;
      for (let i = 0; i < n; i++) {
        ring.push(v[i]);
        const on = sortedOn(v[i], v[(i + 1) % n]);
        if (on.length) { flat = true; for (const it of on) ring.push(it.id); }
      }
      if (!flat && n > 3) for (let i = 0; i < n && !flat; i++) {
        const a = v[(i + n - 1) % n], b = v[i], c = v[(i + 1) % n];
        const cr = orient(px[a], py[a], px[b], py[b], px[c], py[c]);
        flat = Math.abs(cr) <= 1e-9 * Math.hypot(px[b] - px[a], py[b] - py[a]) * Math.hypot(px[c] - px[b], py[c] - py[b]);
      }
      if (!flat) { for (let i = 1; i + 1 < n; i++) emit(fi, v[0], v[i], v[i + 1]); return; }
      // a point in a line with its neighbours: fan from the centre instead, so no triangle is a sliver
      let cx = 0, cy = 0;
      for (const id of v) { cx += px[id]; cy += py[id]; }
      const c = addPoint(cx / n, cy / n);
      for (let i = 0; i < ring.length; i++) emit(fi, c, ring[i], ring[(i + 1) % ring.length]);
      return;
    }
    // clipped: the area's edges inside the face, and the face's edges inside the area, as directed pieces
    const segs = [];
    for (const e of touching[fi]) {
      const g = anext[e];
      const ins = insideFace(f, ax[e], ay[e]), ine = insideFace(f, ax[g], ay[g]);
      const xs = [];
      for (let i = 0; i < n; i++) { const p = v[i], q = v[(i + 1) % n], c = crossing(e, Math.min(p, q), Math.max(p, q)); if (c) xs.push(c); }
      if (!ins && !ine && !xs.length) continue;
      xs.sort((A, B) => A.s - B.s);
      const L = [];
      if (ins) L.push(apid(e));
      for (const c of xs) L.push(c.id);
      if (ine) L.push(apid(g));
      if (L.length & 1) throw new Error('an area edge enters a face and never leaves');
      for (let m = 0; m < L.length; m += 2) if (L[m] !== L[m + 1]) segs.push([L[m], L[m + 1]]);
    }
    for (let i = 0; i < n; i++) {
      const p = v[i], q = v[(i + 1) % n], on = sortedOn(p, q);
      const ids = [p, ...on.map(it => it.id), q], cross = [false, ...on.map(it => it.cross), false];
      let ins = inV(p);
      for (let m = 0; m + 1 < ids.length; m++) {
        if (ins) segs.push([ids[m], ids[m + 1]]);
        if (cross[m + 1]) ins = !ins;
      }
      if (ins !== inV(q)) throw new Error('a face edge disagrees with the area about its end');
    }
    if (!segs.length) return;
    const next = new Map();
    for (const [a, b] of segs) { if (next.has(a)) throw new Error('two pieces leave one point'); next.set(a, b); }
    const loops = [], used = new Set();
    for (const start of next.keys()) {
      if (used.has(start)) continue;
      const loop = [];
      let cur = start;
      while (!used.has(cur)) { used.add(cur); loop.push(cur); cur = next.get(cur); if (cur === undefined) throw new Error('an open piece'); }
      if (cur !== start) throw new Error('pieces that do not close');
      loops.push(loop);
    }
    const ringArea = l => { let s = 0; for (let i = 0; i < l.length; i++) { const p = l[i], q = l[(i + 1) % l.length]; s += px[p] * py[q] - px[q] * py[p]; } return s / 2; };
    const outers = [], holes = [];
    for (const l of loops) (ringArea(l) > 0 ? outers : holes).push(l);
    if (!outers.length) throw new Error('a clipped face with holes and no outline');
    outers.sort((a, b) => ringArea(a) - ringArea(b));   // smallest first: a hole belongs to the smallest outline round it
    const groups = outers.map(o => ({ o, h: [] }));
    for (const hl of holes) {
      const x = px[hl[0]], y = py[hl[0]];
      const home = groups.find(gr => {
        let c = false;
        const o = gr.o;
        for (let i = 0, j = o.length - 1; i < o.length; j = i++) { const yi = py[o[i]], yj = py[o[j]]; if ((yi > y) !== (yj > y) && x < px[o[j]] + (y - yj) * (px[o[i]] - px[o[j]]) / (yi - yj)) c = !c; }
        return c;
      });
      if (!home) throw new Error('a hole outside its face');
      home.h.push(hl);
    }
    for (const gr of groups) {
      const all = [gr.o, ...gr.h].flat();
      const tris = ShapeUtils.triangulateShape(gr.o.map(id => new Vector2(px[id], py[id])), gr.h.map(hl => hl.map(id => new Vector2(px[id], py[id]))));
      for (const [a, b, c] of tris) emit(fi, all[a], all[b], all[c]);
    }
  });
  if (!topIdx.length) return null;
  if (!filter && Math.abs(topArea - areaSum) > 1e-6 * areaSum + 1e-6) throw new Error(`the top covers ${topArea.toFixed(4)} of ${areaSum.toFixed(4)} mm2`);
  let footprint = region;

  // ---- pinches: where the top touches itself at a single corner, the walls of two pieces would come down the same
  // vertical edge, which four faces would then share. Two passes, each splitting a point, one copy per piece after
  // the first, at a point moved 0.0004 mm into its piece: far enough that the 3MF writer's weld (to 0.0001 mm) keeps
  // the copies apart, too little to see. First by point: the triangles round a point fall into pieces joined across
  // their edges from it (a cliff joins too), so two stones of one colour meeting corner to corner come apart, and
  // so do a low pair and a high pair of cells with nothing between them. Then by vertex (a point at one height),
  // joined only where both triangles use that vertex: one plateau reaching a point on both sides of a lower cell.
  const splitPinches = byVertex => {
    const NPP = px.length, nTri = topIdx.length / 3, segTris = new Map(), at = new Map();
    const pidAt = Int32Array.from(topIdx, id => vp[id]);   // each corner's point before any split
    for (let t = 0; t < nTri; t++) for (let m = 0; m < 3; m++) {
      const p = pidAt[3 * t + m], q = pidAt[3 * t + (m + 1) % 3], sk = p < q ? p * NPP + q : q * NPP + p;
      (segTris.get(sk) || segTris.set(sk, []).get(sk)).push(t);
      const k = byVertex ? topIdx[3 * t + m] : p;
      (at.get(k) || at.set(k, []).get(k)).push(3 * t + m);
    }
    for (const uses of at.values()) {
      if (uses.length < 2) continue;
      const pid = pidAt[uses[0]];
      const tris = uses.map(sl => Math.floor(sl / 3)), idx = new Map(tris.map((t, i) => [t, i])), par = tris.map((_, i) => i);
      const find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
      for (const t of tris) for (let m = 0; m < 3; m++) {
        const q = pidAt[3 * t + m];
        if (q === pid) continue;
        for (const u of segTris.get(pid < q ? pid * NPP + q : q * NPP + pid)) if (idx.has(u)) { const a = find(idx.get(t)), b = find(idx.get(u)); if (a !== b) par[a] = b; }
      }
      const fans = new Map();
      tris.forEach((t, i) => { const r = find(i); (fans.get(r) || fans.set(r, []).get(r)).push(uses[i]); });
      if (fans.size < 2) continue;
      let first = true;
      for (const slots of fans.values()) {
        if (first) { first = false; continue; }
        // into the piece: toward the average of its triangles' other corners at this point
        let sx = 0, sy = 0;
        for (const sl of slots) { const t = Math.floor(sl / 3); for (let m = 0; m < 3; m++) { const q = pidAt[3 * t + m]; if (q !== pid) { sx += px[q] - px[pid]; sy += py[q] - py[pid]; } } }
        const L = Math.hypot(sx, sy) || 1, np = addPoint(px[pid] + 4e-4 * sx / L, py[pid] + 4e-4 * sy / L), remap = new Map();
        for (const sl of slots) {
          const old = topIdx[sl];
          let nv = remap.get(old);
          if (nv === undefined) { nv = vertex(np, vq[old], vz[old]); remap.set(old, nv); }
          topIdx[sl] = nv;
        }
      }
    }
  };
  splitPinches(false);
  splitPinches(true);

  // ---- the bottom: the outline triangulated flat. The outline is every open edge of the top that has no open edge
  // of another cell along the same segment (those are cliffs)
  {
    const NT = vx.length, NPX = px.length, topDir = new Set();
    for (let i = 0; i < topIdx.length; i += 3) for (let m = 0; m < 3; m++) topDir.add(topIdx[i + m] * NT + topIdx[i + (m + 1) % 3]);
    const openBySeg = new Map();
    for (const k of topDir) {
      const a = Math.floor(k / NT), b = k - a * NT;
      if (topDir.has(b * NT + a)) continue;
      const p = vp[a], q = vp[b], sk = p < q ? p * NPX + q : q * NPX + p;
      const l = openBySeg.get(sk);
      if (l) l.push([p, q]); else openBySeg.set(sk, [[p, q]]);
    }
    const along = new Map(), oedges = [];
    for (const l of openBySeg.values()) if (l.length === 1) { const e = { p: l[0][0], q: l[0][1], used: false }; oedges.push(e); (along.get(e.p) || along.set(e.p, []).get(e.p)).push(e); }
    // walk each outline with the inside on the left; at a corner where two pieces touch (two ways on), take the
    // first edge clockwise from the way back, which keeps to the piece the walk is on
    const loops = [];
    for (const first of oedges) {
      if (first.used) continue;
      const loop = [];
      let e = first;
      for (let guard = 0; guard <= oedges.length; guard++) {
        e.used = true; loop.push(e.p);
        const v = e.q, ways = (along.get(v) || []).filter(o => !o.used || o === first);
        if (!ways.length) throw new Error('the outline does not close');
        let next = ways[0];
        if (ways.length > 1) {
          const back = Math.atan2(py[e.p] - py[v], px[e.p] - px[v]);
          const cw = o => { let a = back - Math.atan2(py[o.q] - py[v], px[o.q] - px[v]); while (a <= 1e-12) a += 2 * Math.PI; return a; };
          next = ways.reduce((best, o) => (cw(o) < cw(best) ? o : best));
        }
        if (next === first) break;
        e = next;
      }
      if (loop.length < 3) throw new Error('the outline does not close');
      loops.push(loop);
    }
    const ringArea = l => { let s = 0; for (let i = 0; i < l.length; i++) { const p = l[i], q = l[(i + 1) % l.length]; s += px[p] * py[q] - px[q] * py[p]; } return s / 2; };
    const outers = [], holes = [];
    for (const l of loops) { const a = ringArea(l); (a > 0 ? outers : holes).push({ l, a: Math.abs(a) }); }
    outers.sort((s, t) => s.a - t.a);   // smallest first: a hole belongs to the smallest outline around it
    const groups = outers.map(o => ({ o: o.l, h: [] }));
    const inside = (ring, x, y) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const yi = py[ring[i]], yj = py[ring[j]]; if ((yi > y) !== (yj > y) && x < px[ring[j]] + (y - yj) * (px[ring[i]] - px[ring[j]]) / (yi - yj)) c = !c; } return c; };
    for (const { l } of holes) {
      const home = groups.find(gr => inside(gr.o, px[l[0]], py[l[0]]));
      if (!home) throw new Error('an outline hole outside every outline');
      home.h.push(l);
    }
    let botArea = 0;
    if (!filter) {
      for (const gr of groups) {
        const all = [gr.o, ...gr.h].flat();
        const tris = ShapeUtils.triangulateShape(gr.o.map(id => new Vector2(px[id], py[id])), gr.h.map(hl => hl.map(id => new Vector2(px[id], py[id]))));
        for (let [a, b, c] of tris) {
          a = all[a]; b = all[b]; c = all[c];   // counter-clockwise, in earcut's own order
          botArea += orient(px[a], py[a], px[b], py[b], px[c], py[c]) / 2;
          botIdx.push(botVertex(a), botVertex(c), botVertex(b));   // facing down
        }
      }
      // earcut can drop a point that lies exactly in line with its neighbours: then an outline edge has no
      // bottom edge under it, and the top's own triangles, laid flat, are the bottom instead
      const have = new Set();
      for (let i = 0; i < botIdx.length; i += 3) for (let m = 0; m < 3; m++) have.add(`${vp[botIdx[i + m]]}|${vp[botIdx[i + (m + 1) % 3]]}`);
      if (!oedges.every(e => have.has(`${e.q}|${e.p}`))) { botIdx.length = 0; botArea = 0; }
    }
    if (!botIdx.length) {
      // a part of the area (one colour), or earcut came up short: the bottom is the top's triangles laid flat,
      // which meet its outline edge for edge
      for (let i = 0; i < topIdx.length; i += 3) {
        const a = vp[topIdx[i]], b = vp[topIdx[i + 1]], c = vp[topIdx[i + 2]];
        botArea += orient(px[a], py[a], px[b], py[b], px[c], py[c]) / 2;
        botIdx.push(botVertex(a), botVertex(c), botVertex(b));   // facing down
      }
    }
    // against the top as it now stands (a pinch split moved a few of its corners by 0.0004 mm)
    let topNow = 0;
    for (let i = 0; i < topIdx.length; i += 3) topNow += orient(vx[topIdx[i]], vy[topIdx[i]], vx[topIdx[i + 1]], vy[topIdx[i + 1]], vx[topIdx[i + 2]], vy[topIdx[i + 2]]) / 2;
    if (Math.abs(botArea - topNow) > 1e-6 * topNow + 1e-6) throw new Error('the bottom does not cover the top');
    // a part of the area (one colour of it) stands on its own outline
    if (filter) footprint = nestRings(loops.map(l => { const r = l.map(id => [px[id], py[id]]); r.push(r[0].slice()); return r; }), 0);
  }

  // ---- walls: every unpaired edge of the top and of the bottom, paired along its segment
  const NV = vx.length, NP = px.length;
  const dir = new Map();
  const count = idx => { for (let i = 0; i < idx.length; i += 3) for (let m = 0; m < 3; m++) { const k = idx[i + m] * NV + idx[i + (m + 1) % 3]; dir.set(k, (dir.get(k) || 0) + 1); } };
  count(topIdx); count(botIdx);
  const segsOf = new Map();
  for (const [k, n] of dir) {
    if (n !== 1) throw new Error('an edge used twice in one direction');
    const a = Math.floor(k / NV), b = k - a * NV;
    if (dir.has(b * NV + a)) continue;
    const p = vp[a], q = vp[b];
    if (p === q) throw new Error('a vertical edge on the top');
    const sk = p < q ? p * NP + q : q * NP + p;
    const l = segsOf.get(sk);
    if (l) l.push([a, b]); else segsOf.set(sk, [[a, b]]);
  }
  const between = (pid, from, to) => {
    const lo = Math.min(from, to), hi = Math.max(from, to);
    const out = (cols.get(pid) || []).filter(id => vq[id] > lo && vq[id] < hi).sort((s, t) => vq[s] - vq[t]);
    return from < to ? out : out.reverse();
  };
  const wallIdx = [];
  for (const l of segsOf.values()) {
    if (l.length !== 2) throw new Error(`a segment with ${l.length} open edges`);
    const [[a1, b1], [a2, b2]] = l;
    if (vp[a1] !== vp[b2] || vp[b1] !== vp[a2]) throw new Error('two open edges running the same way');
    const pc = a1 === b2 ? [a1] : [a1, ...between(vp[a1], vq[a1], vq[b2]), b2];
    const qc = a2 === b1 ? [a2] : [a2, ...between(vp[a2], vq[a2], vq[b1]), b1];
    for (let i = 0; i + 1 < pc.length; i++) wallIdx.push(b1, pc[i], pc[i + 1]);
    for (let j = 0; j + 1 < qc.length; j++) wallIdx.push(b2, qc[j], qc[j + 1]);
  }
  // closure: every directed edge once, and its reverse once (by ids, then as the 3MF writer will weld it)
  if (!closes([topIdx, botIdx, wallIdx], id => id, NV)) throw new Error('the body does not close');
  {
    const wk = new Map(), wid = new Int32Array(NV), f4 = v => Math.fround(v).toFixed(4);
    for (let i = 0; i < NV; i++) { const k = `${f4(vx[i])},${f4(vy[i])},${f4(vz[i])}`; let w = wk.get(k); if (w === undefined) { w = wk.size; wk.set(k, w); } wid[i] = w; }
    const left = closes([topIdx, botIdx, wallIdx], id => wid[id], wk.size);
    if (left === false) throw new Error('the body would not close once the 3MF writer welds it');
    if (left === 0) return null;   // an area too small to survive the weld leaves nothing to print (Sol 01a1b3bf)
  }

  const all = topIdx.length + wallIdx.length + botIdx.length, out = new Float32Array(all * 3);
  let o = 0;
  for (const idx of [topIdx, wallIdx, botIdx]) for (const id of idx) { out[o++] = vx[id]; out[o++] = vy[id]; out[o++] = vz[id]; }
  let z1 = zb;
  for (const z of vz) if (z > z1) z1 = z;
  return { tris: out, footprint, z0, z1, grid: 0, cells: faces.length, exact: true };
}
