// Exact geometry for the 3D textures that have edges (2026-11-06; settings, bonds and seven more maps 2026-11-11):
// instead of sampling a height function on a grid, which draws every cliff and crease through the nearest grid
// points as a zigzag, these maps describe their relief as a planar mesh in the texture's own frame. Every face is
// a convex polygon on which the height is linear (a plane), so a cliff or a crease lies exactly on a face edge.
//
// The mesh is conforming: every vertex is made once, under a symbolic key (a Voronoi vertex by the three cells it
// is equidistant from, a lattice point by its indices, a crossing of two circles by the pair), so two faces that
// share an edge share both its ends and there are no T-junctions. Faces carry a `cell`: faces of one cell are
// continuous across their shared edges (a point has one height in every face of the cell); faces of two cells may
// meet at a cliff. Faces also carry a `tile`, the unit a colour is given to (a stone, a brick, a stud with the
// ground round it), a hash of its lattice key so it keeps its colour on every size.
//
// The local frame is the height maps' frame (heightmaps.js), shifted by DELTA (about a thousandth of a feature):
// cell lines then never fall exactly on a plate's edges or the mesher's other straight lines, which keeps the
// exact mesher (surface.js) out of the degenerate cases.

import { hash, hexSite, beadProfile, cleanTextureParams, SCALE_R, scaleHeight, blockHeight } from './heightmaps.js';
import { ShapeUtils, Vector2 } from '../../vendor/three/three.module.js';

export const CELL_MAPS = new Set(['crystal', 'pebbles', 'bricks', 'hexdome', 'knurl', 'weave', 'fluted', 'reeded', 'studs', 'dimples', 'scales', 'blocks', 'tread']);
const DELTA = [Math.SQRT2 * 7.3e-4, Math.PI * 2.3e-4];
const SQ3 = Math.sqrt(3);
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const fnv = key => { let h = 2166136261; for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619); return h >>> 0; };

/** The site of crystal and pebble cell (q, r): a hex lattice, moved by up to 0.4 units at full irregularity. */
export const voronoiSite = hexSite;

/**
 * The texture's frame for these options: world mm <-> local units (one feature across), the same rotation and
 * scale as heightFunction, plus the small DELTA shift.
 */
export function textureFrame({ scale = 4, angle = 0, centre = [0, 0] } = {}) {
  const s = Math.max(0.2, Number(scale) || 4), a = -(Number(angle) || 0) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
  const cx = Number(centre?.[0]) || 0, cy = Number(centre?.[1]) || 0;
  return {
    s,
    toLocal: (X, Y) => { const dx = X - cx, dy = Y - cy; return [(dx * c - dy * sn) / s + DELTA[0], (dx * sn + dy * c) / s + DELTA[1]]; },
    toWorld: (u, v) => { const lu = (u - DELTA[0]) * s, lv = (v - DELTA[1]) * s; return [cx + lu * c + lv * sn, cy - lu * sn + lv * c]; },
  };
}

/** Clip a convex polygon (array of [x, y, tag]) to the half-plane n . p <= d; the new edge carries `tag`. */
function clipHalf(poly, nx, ny, d, tag) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const fp = nx * p[0] + ny * p[1] - d, fq = nx * q[0] + ny * q[1] - d;
    if (fp <= 0) out.push(p);
    if ((fp <= 0) !== (fq <= 0)) {
      const t = fp / (fp - fq);
      // the crossing on edge p -> q; the edge leaving it is the clipping line when entering the outside -> inside
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, fp <= 0 ? tag : p[2]]);
    }
  }
  return out;
}
function circumcentre(a, b, c) {
  const ax = a[0], ay = a[1], bx = b[0] - ax, by = b[1] - ay, cx = c[0] - ax, cy = c[1] - ay;
  const d = 2 * (bx * cy - by * cx), b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  return [ax + (cy * b2 - by * c2) / d, ay + (bx * c2 - cx * b2) / d];
}

/**
 * The planar mesh of an edged map over a world box ({x0, y0, x1, y1}), for a mesh grid of `grid` mm (curved maps
 * use it for their rings and strips). opts: { map, scale, angle, centre, seed, params }. Returns { pts: [[x, y], ...]
 * (world mm), faces: [{ v: [point ids], h: [0..1 per vertex], cell, tile }], cells } with every face
 * counter-clockwise in world coordinates, or null when the map has no exact form or the mesh would exceed maxFaces.
 */
export function cellMesh(opts, box, grid = 0.4, { maxFaces = 250000 } = {}) {
  const map = opts.map;
  if (!CELL_MAPS.has(map) || !box) return null;
  const F = textureFrame(opts), seed = Math.round(Number(opts.seed) || 0), P = cleanTextureParams(map, opts.params);
  // the box in local units, with a margin of two features
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (const [X, Y] of [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]]) {
    const [u, v] = F.toLocal(X, Y);
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  u0 -= 2; v0 -= 2; u1 += 2; v1 += 2;
  const g = Math.max(0.05, Number(grid) || 0.4) / F.s;   // the mesh grid in local units
  const keys = new Map(), pts = [], lpts = [], faces = [];
  // a cell is built only when its outline's world box meets the area's box (a turned texture's local box is bigger)
  const pad = 0.5 * F.s;
  const wanted = loc => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [u, v] of loc) { const [X, Y] = F.toWorld(u, v); x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y); }
    return x1 >= box.x0 - pad && x0 <= box.x1 + pad && y1 >= box.y0 - pad && y0 <= box.y1 + pad;
  };
  // (Voronoi vertices a vanishing distance apart are kept apart: merging them would make a four-cell corner whose
  // cliffs cross, which no manifold wall can close. The mesher checks the body as the 3MF writer will weld it.)
  const point = (key, u, v) => {
    let id = keys.get(key);
    if (id === undefined) { id = pts.length; keys.set(key, id); pts.push(F.toWorld(u, v)); lpts.push([u, v]); }
    return id;
  };
  // cell 0 is every continuous map's one cell; named cells (a crystal facet, a scale) count from 1
  const cellIds = new Map();
  const cellOf = key => { let c = cellIds.get(key); if (c === undefined) { c = cellIds.size + 1; cellIds.set(key, c); } return c; };
  const face = (v, h, cell, tile = cell) => {
    if (faces.length >= maxFaces) throw new Error('too-many-faces');
    faces.push({ v, h, cell, tile });
  };
  // the number of features over the area's box, for a size estimate before any work
  const features = ((box.x1 - box.x0) / F.s + 3) * ((box.y1 - box.y0) / F.s + 3);
  const C = { seed, P, u0, v0, u1, v1, g, point, face, cellOf, features, maxFaces, wanted, pts, lpts, T: fnv };
  try {
    GENERATORS[map](C, map);
  } catch (e) {
    if (e.message === 'too-many-faces') return null;
    throw e;
  }
  // counter-clockwise in world coordinates (the knurl lattice, for one, flips handedness)
  for (const f of faces) {
    let s = 0;
    for (let i = 0; i < f.v.length; i++) { const p = pts[f.v[i]], q = pts[f.v[(i + 1) % f.v.length]]; s += p[0] * q[1] - q[0] * p[1]; }
    if (s < 0) { f.v.reverse(); f.h.reverse(); }
  }
  return { pts, faces, cells: cellIds.size + 1 };
}

/**
 * Faces of a cell built as rings: the cell's outline (ids, loc in local units) scaled toward `centre` by each ring's
 * f, each band between two rings a set of planar trapezoids (two parallel edges at two heights), the innermost ring
 * a flat top or, when f reaches 0, a fan to the apex. rings: [[f, h], ...] from the outline (f = 1) in.
 */
function ringFaces(ids, loc, centre, rings, key, C, cell, tile) {
  const n = ids.length;
  let prev = ids, prevH = rings[0][1], prevF = rings[0][0];
  for (let r = 1; r < rings.length; r++) {
    const [f, h] = rings[r];
    if (Math.abs(f - prevF) < 1e-9) continue;   // a ring on the last one (no gap, say) adds nothing
    if (f <= 1e-9) {
      const apex = C.point(`${key}|apex`, centre[0], centre[1]);
      for (let m = 0; m < n; m++) C.face([prev[m], prev[(m + 1) % n], apex], [prevH, prevH, h], cell, tile);
      return;
    }
    const cur = loc.map(([x, y], m) => C.point(`${key}|${r}|${m}`, centre[0] + (x - centre[0]) * f, centre[1] + (y - centre[1]) * f));
    for (let m = 0; m < n; m++) C.face([prev[m], prev[(m + 1) % n], cur[(m + 1) % n], cur[m]], [prevH, prevH, h, h], cell, tile);
    prev = cur; prevH = h; prevF = f;
  }
  C.face(prev.slice(), prev.map(() => prevH), cell, tile);
}

/** A planar polygon that need not be convex (a holed square of ground round a stud, a scale): earcut into
 *  triangles, which are convex, with each vertex's height from hOf(id). */
function tileFaces(outer, holes, C, hOf, cell, tile) {
  const vec = id => new Vector2(C.pts[id][0], C.pts[id][1]);
  const all = [outer, ...holes].flat();
  for (const [a, b, c] of ShapeUtils.triangulateShape(outer.map(vec), holes.map(hl => hl.map(vec)))) {
    C.face([all[a], all[b], all[c]], [hOf(all[a]), hOf(all[b]), hOf(all[c])], cell, tile);
  }
}

// ---- crystal and pebbles: Voronoi cells of sites on a jittered hex lattice
function voronoiCells(C, map) {
  const { seed, P, u0, v0, u1, v1, g, point, face, cellOf, features, maxFaces, wanted, T } = C;
  const irr = P.irregular / 100;
  const rings = map === 'pebbles' ? pebbleRings(g, P.gap / 100, P.round / 100) : null;
  if (features * 1.2 * (rings ? 6 * rings.length + 1 : 1) > maxFaces) throw new Error('too-many-faces');
  const key = (q, r) => `${q},${r}`;
  const nb = [];
  for (let dr = -2; dr <= 2; dr++) for (let dq = -2; dq <= 2; dq++) if (dq || dr) nb.push([dq, dr]);
  const r0 = Math.floor(v0 / (SQ3 / 2)) - 1, r1 = Math.ceil(v1 / (SQ3 / 2)) + 1;
  for (let r = r0; r <= r1; r++) {
    const q0 = Math.floor(u0 - 0.5 * r) - 1, q1 = Math.ceil(u1 - 0.5 * r) + 1;
    for (let q = q0; q <= q1; q++) {
      const [px, py] = hexSite(seed, q, r, irr);
      if (!wanted([[px - 1.2, py - 1.2], [px + 1.2, py - 1.2], [px + 1.2, py + 1.2], [px - 1.2, py + 1.2]])) continue;
      // start from a square around the site and clip by the bisector with every nearby site, nearest first
      let poly = [[px - 2.5, py - 2.5, null], [px + 2.5, py - 2.5, null], [px + 2.5, py + 2.5, null], [px - 2.5, py + 2.5, null]];
      const others = nb.map(([dq, dr]) => { const s = hexSite(seed, q + dq, r + dr, irr); return { k: key(q + dq, r + dr), s, d: Math.hypot(s[0] - px, s[1] - py) }; }).sort((a, b) => a.d - b.d);
      for (const o of others) {
        let far = 0;
        for (const p of poly) far = Math.max(far, Math.hypot(p[0] - px, p[1] - py));
        if (o.d / 2 >= far) break;   // its bisector lies beyond every vertex: no farther site can cut the cell either
        poly = clipHalf(poly, o.s[0] - px, o.s[1] - py, (o.s[0] * o.s[0] + o.s[1] * o.s[1] - px * px - py * py) / 2, o.k);
      }
      // each vertex sits between the edges before and after it: equidistant from this site and those two neighbours
      const me = key(q, r), ids = [], loc = [];
      for (let m = 0; m < poly.length; m++) {
        const a = poly[(m + poly.length - 1) % poly.length][2], b = poly[m][2];
        if (a == null || b == null) { ids.length = 0; break; }   // still on the starting square: off the generated area
        const trio = [me, a, b].sort();
        // the vertex's position from the three sites, in canonical order, so all three cells agree to the last bit
        const S = trio.map(k => { const [sq, sr] = k.split(',').map(Number); return hexSite(seed, sq, sr, irr); });
        const c = circumcentre(S[0], S[1], S[2]);
        const id = point(`v|${trio.join('|')}`, c[0], c[1]);
        if (id !== ids[ids.length - 1]) { ids.push(id); loc.push(c); }   // never the same point twice in a row
      }
      while (ids.length > 1 && ids[0] === ids[ids.length - 1]) { ids.pop(); loc.pop(); }
      if (ids.length < 3) continue;
      if (map === 'crystal') {
        // a tilted plane at the cell's own height, its slope eased where it would leave 0..1 inside the cell
        const vary = P.vary / 100, top = 1 - vary + vary * hash(seed, q, r, 3), th = 2 * Math.PI * hash(seed, q, r, 4), cth = Math.cos(th), sth = Math.sin(th);
        let k = (P.tilt / 65) * (0.35 + 0.65 * hash(seed, q, r, 5)), dmin = 0, dmax = 0;
        for (const [x, y] of loc) { const dd = (x - px) * cth + (y - py) * sth; dmin = Math.min(dmin, dd); dmax = Math.max(dmax, dd); }
        if (dmax > 0) k = Math.min(k, top / dmax);
        if (dmin < 0) k = Math.min(k, (1 - top) / -dmin);
        face(ids, loc.map(([x, y]) => clamp01(top - k * ((x - px) * cth + (y - py) * sth))), cellOf(me), T(`c|${me}`));
      } else {
        // a pebble: rings shrinking toward the site, rising on a rounded shoulder to a flat top
        const vary = P.vary / 100, lift = 1 - vary + vary * hash(seed, q, r, 6);
        ringFaces(ids, loc, [px, py], rings.map(([f, h]) => [f, h * lift]), `p|${me}`, C, 0, T(`p|${me}`));
      }
    }
  }
}

/** The rings of a pebble: [f (scale toward the site, 1 = the cell's edge), h], ground first, then the shoulder. */
function pebbleRings(g, gap, round) {
  const n = Math.max(3, Math.min(8, Math.round(0.3 / Math.max(g, 0.01))));
  const F0 = 1 - gap, out = [[1, 0]];
  if (gap > 1e-3) out.push([F0, 0]);
  for (let k = 1; k <= n; k++) { const e = k / n; out.push([F0 * (1 - round * e), 1 - (1 - e) ** 2]); }
  return out;
}

// ---- knurl: diamond pyramids between two crossing sets of grooves, cut flat on top if asked
function knurlMesh(C) {
  const { P, u0, v0, u1, v1, point, face, features, maxFaces, wanted, T } = C;
  const a = P.angle * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a), flat = P.flat / 100;
  // the knurl lattice (p, q): p = x cos a + y sin a, q = x cos a - y sin a; back: x = (p + q) / 2 cos a, y = (p - q) / 2 sin a
  const toXY = (p, q) => [(p + q) / (2 * ca), (p - q) / (2 * sa)];
  let p0 = Infinity, p1 = -Infinity, q0 = Infinity, q1 = -Infinity;
  for (const [x, y] of [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]) {
    const p = x * ca + y * sa, q = x * ca - y * sa;
    p0 = Math.min(p0, p); p1 = Math.max(p1, p); q0 = Math.min(q0, q); q1 = Math.max(q1, q);
  }
  if (features * Math.max(1, Math.sin(2 * a) * 2) * 6 > maxFaces) throw new Error('too-many-faces');
  const rings = flat > 1e-3 ? [[1, 0], [flat, 1]] : [[1, 0], [0, 1]];
  const corner = (i, j) => { const [x, y] = toXY(i, j); return point(`k|${i}|${j}`, x, y); };
  for (let j = Math.floor(q0); j < Math.ceil(q1); j++) for (let i = Math.floor(p0); i < Math.ceil(p1); i++) {
    const loc = [toXY(i, j), toXY(i + 1, j), toXY(i + 1, j + 1), toXY(i, j + 1)];
    if (!wanted(loc)) continue;
    const ids = [corner(i, j), corner(i + 1, j), corner(i + 1, j + 1), corner(i, j + 1)];
    ringFaces(ids, loc, toXY(i + 0.5, j + 0.5), rings, `kn|${i}|${j}`, C, 0, T(`k|${i},${j}`));
  }
}

// ---- the hexagonal lattice one unit apart: a hexagon's six corners, each the average of its three hexagons' centres
const HEX_DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];   // neighbours at 0, 60, ... 300 degrees
const hexCentre = (q, r) => [q + 0.5 * r, r * SQ3 / 2];
function hexCorners(q, r, point) {
  const ids = [], loc = [];
  for (let m = 0; m < 6; m++) {
    const A = HEX_DIRS[m], B = HEX_DIRS[(m + 1) % 6];
    const trio = [[q, r], [q + A[0], r + A[1]], [q + B[0], r + B[1]]].sort((s, t) => (s[0] - t[0]) || (s[1] - t[1]));
    // summed in canonical order, so all three hexagons agree exactly
    const cs = trio.map(([qq, rr]) => hexCentre(qq, rr));
    const x = (cs[0][0] + cs[1][0] + cs[2][0]) / 3, y = (cs[0][1] + cs[1][1] + cs[2][1]) / 3;
    ids.push(point(`h|${trio.map(t => `${t[0]},${t[1]}`).join('|')}`, x, y)); loc.push([x, y]);
  }
  return [ids, loc];   // corner m at 30 + 60 m degrees
}
function forHexes(C, fn) {
  const { u0, v0, u1, v1, wanted } = C;
  const r0 = Math.floor(v0 / (SQ3 / 2)) - 1, r1 = Math.ceil(v1 / (SQ3 / 2)) + 1;
  for (let r = r0; r <= r1; r++) {
    const q0 = Math.floor(u0 - 0.5 * r) - 1, q1 = Math.ceil(u1 - 0.5 * r) + 1;
    for (let q = q0; q <= q1; q++) {
      const c = hexCentre(q, r);
      if (wanted([[c[0] - 0.6, c[1] - 0.6], [c[0] + 0.6, c[1] - 0.6], [c[0] + 0.6, c[1] + 0.6], [c[0] - 0.6, c[1] + 0.6]])) fn(q, r, c);
    }
  }
}

// ---- hex domes: a dome (or cone, mesa, dimple) on every hexagon, meeting its neighbours at the ground
function hexMesh(C) {
  const { seed, P, g, point, features, maxFaces, T } = C;
  const F0 = 1 - P.gap / 100, vary = P.vary / 100, prof = P.profile;
  const n = Math.max(3, Math.min(10, Math.round(0.45 / Math.max(g, 0.01))));
  if (features * 1.2 * 6 * (n + 2) > maxFaces) throw new Error('too-many-faces');
  const ringsFor = lift => {
    if (prof === 'cone') return [[1, 0], [F0, 0], [0, lift]];
    if (prof === 'mesa') return [[1, 0], [F0, 0], [0.6 * F0, lift]];
    // rings evenly spaced along a quarter circle: f = sin(phi), h = cos(phi), so the steep foot gets its share
    const out = prof === 'dimple' ? [[1, 1], [F0, 1]] : [[1, 0], [F0, 0]];
    for (let k = 1; k <= n; k++) { const phi = (Math.PI / 2) * (1 - k / n); out.push([F0 * Math.sin(phi), prof === 'dimple' ? 1 - Math.cos(phi) * lift : Math.cos(phi) * lift]); }
    return out;
  };
  forHexes(C, (q, r, c) => {
    const [ids, loc] = hexCorners(q, r, point);
    ringFaces(ids, loc, c, ringsFor(1 - vary + vary * hash(seed, q, r, 11)), `hd|${q},${r}`, C, 0, T(`hd|${q},${r}`));
  });
}

// ---- tumbling blocks: every hexagon three rhombi, a level top and two sides falling away (cliffs between rows)
function blockMesh(C) {
  const { P, point, face, cellOf, features, maxFaces, T } = C;
  if (features * 1.2 * 3 > maxFaces) throw new Error('too-many-faces');
  forHexes(C, (q, r, c) => {
    const [ids, loc] = hexCorners(q, r, point);
    const mid = point(`blc|${q},${r}`, c[0], c[1]), cell = cellOf(`bl|${q},${r}`);
    const hOf = (k, f) => (k < 0 ? 1 : blockHeight(f, loc[k][0] - c[0], loc[k][1] - c[1], P));
    // top: corners at 30, 90, 150 degrees; left: 150, 210, 270; right: 270, 330, 30
    [[0, 1, 2], [2, 3, 4], [4, 5, 0]].forEach((ks, f) => {
      face([mid, ...ks.map(k => ids[k])], [hOf(-1, f), ...ks.map(k => hOf(k, f))], cell, T(`bl|${q},${r}|${f}`));
    });
  });
}

// ---- bricks: rectangles of length L by 1 in five bonds, each with a mortar margin, chamfered sides and a flat top
function brickMesh(C) {
  const { seed, P, u0, v0, u1, v1, point, face, cellOf, features, maxFaces, wanted, T } = C;
  const L = Number(P.length) || 2, S = 6, bond = P.bond;
  const M = P.gap / 200, Tc = Math.min(0.45, M + P.chamfer / 100), vary = P.vary / 100, sharp = P.chamfer < 1;
  if (features * 10 > maxFaces) throw new Error('too-many-faces');
  // the bricks as rectangles in sixths of a brick's height, so every offset is a whole number
  const X0 = Math.floor(u0) - 2 * L, X1 = Math.ceil(u1) + 2 * L, Y0 = Math.floor(v0) - 2 * L, Y1 = Math.ceil(v1) + 2 * L;
  const rects = [], add = (x0, y0, x1, y1) => { if (x1 > S * X0 && x0 < S * X1 && y1 > S * Y0 && y0 < S * Y1) rects.push([x0, y0, x1, y1]); };
  if (bond === 'herringbone') {
    // staircases of a horizontal brick and a vertical one, each step (1, 1); the staircases repeat every (L, -L)
    for (let b = Math.floor((X0 - Y1) / (2 * L)) - 2; b <= Math.ceil((X1 - Y0) / (2 * L)) + 2; b++) {
      for (let m = Math.floor((X0 + Y0) / 2) - 2 * L - 2; m <= Math.ceil((X1 + Y1) / 2) + 2 * L + 2; m++) {
        const x = m + b * L, y = m - b * L;
        add(S * x, S * y, S * (x + L), S * (y + 1));
        add(S * (x + L), S * (y - L + 1), S * (x + L + 1), S * (y + 1));
      }
    }
  } else if (bond === 'basket') {
    // L-by-L blocks of L bricks, turned alternately
    for (let by = Math.floor(Y0 / L) - 1; by <= Math.ceil(Y1 / L); by++) for (let bx = Math.floor(X0 / L) - 1; bx <= Math.ceil(X1 / L); bx++) {
      for (let k = 0; k < L; k++) {
        if (((bx + by) & 1) === 0) add(S * L * bx, S * (L * by + k), S * L * (bx + 1), S * (L * by + k + 1));
        else add(S * (L * bx + k), S * L * by, S * (L * bx + k + 1), S * L * (by + 1));
      }
    }
  } else {
    for (let row = Y0; row < Y1; row++) {
      const off = bond === 'stack' ? 0 : bond === 'third' ? (((row % 3) + 3) % 3) * 2 * L : (row & 1) ? 3 * L : 0;
      for (let col = Math.floor((S * X0 + off) / (S * L)) - 1; col <= Math.ceil((S * X1 + off) / (S * L)) + 1; col++) add(S * L * col - off, S * row, S * L * (col + 1) - off, S * (row + 1));
    }
  }
  // any tiling of whole-number rectangles conforms when each brick lists every corner of its neighbours that lies
  // along its own sides
  const corners = new Set();
  for (const [x0, y0, x1, y1] of rects) for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) corners.add(`${x},${y}`);
  const lat = (x, y) => point(`b|${x}|${y}`, x / S, y / S);
  const side = (xa, ya, xb, yb) => {
    const out = [lat(xa, ya)], n = Math.max(Math.abs(xb - xa), Math.abs(yb - ya)), dx = Math.sign(xb - xa), dy = Math.sign(yb - ya);
    for (let k = 1; k < n; k++) if (corners.has(`${xa + dx * k},${ya + dy * k}`)) out.push(lat(xa + dx * k, ya + dy * k));
    out.push(lat(xb, yb));
    return out;
  };
  for (const [x0, y0, x1, y1] of rects) {
    const l = x0 / S, b = y0 / S, r = x1 / S, t = y1 / S;
    if (!wanted([[l, b], [r, b], [r, t], [l, t]])) continue;
    const key = `${x0},${y0}`, tile = T(`b|${key}`), hb = 1 - vary + vary * hash(seed, x0, y0, 10);
    const inset = (d, tag) => [point(`bi|${key}|${tag}|bl`, l + d, b + d), point(`bi|${key}|${tag}|br`, r - d, b + d), point(`bi|${key}|${tag}|tr`, r - d, t - d), point(`bi|${key}|${tag}|tl`, l + d, t - d)];
    const [mBL, mBR, mTR, mTL] = inset(M, 'm');
    const bot = side(x0, y0, x1, y0), rgt = side(x1, y0, x1, y1), top = side(x1, y1, x0, y1), lft = side(x0, y1, x0, y0);
    const flat = (ids, h) => ids.map(() => h);
    // mortar, flat at 0, holding every neighbour's corner on its outer edge
    face([...bot, mBR, mBL], flat([...bot, 0, 0], 0), 0, tile);
    face([...rgt, mTR, mBR], flat([...rgt, 0, 0], 0), 0, tile);
    face([...top, mTL, mTR], flat([...top, 0, 0], 0), 0, tile);
    face([...lft, mBL, mTL], flat([...lft, 0, 0], 0), 0, tile);
    if (sharp) { face([mBL, mBR, mTR, mTL], [hb, hb, hb, hb], cellOf(`b|${key}`), tile); continue; }   // square-edged: a cliff
    const [tBL, tBR, tTR, tTL] = inset(Tc, 't');
    face([mBL, mBR, tBR, tBL], [0, 0, hb, hb], 0, tile);
    face([mBR, mTR, tTR, tBR], [0, 0, hb, hb], 0, tile);
    face([mTR, mTL, tTL, tTR], [0, 0, hb, hb], 0, tile);
    face([mTL, mBL, tBL, tTL], [0, 0, hb, hb], 0, tile);
    face([tBL, tBR, tTR, tTL], [hb, hb, hb, hb], 0, tile);
  }
}

// ---- weave: blocks of strands, alternating across and along, each strand rising over its middle
function weaveHeight(n, bx, by, x, y) {
  const fx = x - bx, fy = y - by, across = ((bx + by) & 1) === 0;
  const s = across ? fy : fx, t = across ? fx : fy;
  const v = s * n - Math.floor(s * n);
  // at a strand's far border v wraps to 0, which is where its height is 0 anyway
  const w = s >= 1 ? 0 : v;
  return Math.pow(Math.sin(Math.PI * w), 0.6) * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, Math.max(0, t))));
}
function weaveMesh(C) {
  const { P, u0, v0, u1, v1, g, point, face, cellOf, features, maxFaces, wanted, T } = C;
  const n = Number(P.strands) || 3;
  // a lattice N per unit (a multiple of the strands, so every strand border is a lattice line), shared by
  // neighbouring blocks; at least two steps per strand, or every lattice point is a border and the weave comes out
  // flat (Sol 01a1b3bf)
  const N = n * Math.max(2, Math.min(8, Math.round(1 / (n * Math.max(g, 0.01)))));
  if (features * N * N * 2 > maxFaces) throw new Error('too-many-faces');
  const lat = (I, J) => point(`w|${I}|${J}`, I / N, J / N);
  for (let by = Math.floor(v0); by < Math.ceil(v1); by++) for (let bx = Math.floor(u0); bx < Math.ceil(u1); bx++) {
    if (!wanted([[bx, by], [bx + 1, by], [bx + 1, by + 1], [bx, by + 1]])) continue;
    const cell = cellOf(`${bx},${by}`), across = ((bx + by) & 1) === 0;
    const H = (I, J) => clamp01(weaveHeight(n, bx, by, I / N, J / N));
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const I = bx * N + i, J = by * N + j;
      const a = lat(I, J), b = lat(I + 1, J), c = lat(I + 1, J + 1), d = lat(I, J + 1);
      const ha = H(I, J), hb = H(I + 1, J), hc = H(I + 1, J + 1), hd = H(I, J + 1);
      const tile = T(`w|${bx},${by}|${Math.floor(((across ? j : i) + 0.5) / (N / n))}`);
      // split along the diagonal whose midpoint is nearer the true height at the square's centre
      const mid = clamp01(weaveHeight(n, bx, by, (I + 0.5) / N, (J + 0.5) / N));
      if (Math.abs((ha + hc) / 2 - mid) <= Math.abs((hb + hd) / 2 - mid)) { face([a, b, c], [ha, hb, hc], cell, tile); face([a, c, d], [ha, hc, hd], cell, tile); }
      else { face([b, c, d], [hb, hc, hd], cell, tile); face([b, d, a], [hb, hd, ha], cell, tile); }
    }
  }
}

// ---- fluted (grooves) and reeded (beads): long strips across each repeat, one planar strip per step of the profile
function stripMesh(C, map) {
  const { P, u0, v0, u1, v1, g, point, face, maxFaces, wanted, T } = C;
  const gap = P.gap / 100, prof = P.profile, concave = map === 'fluted';
  const n = prof === 'v' ? 2 : Math.max(4, Math.min(16, Math.round((1 - gap) / Math.max(g, 0.01))));
  const ts = prof === 'flat' ? [0, 0.2, 0.8, 1] : Array.from({ length: n + 1 }, (_, i) => i / n);
  const land = concave ? 1 : 0, bp = [];   // breakpoints across one repeat: [x, height]
  if (gap > 1e-3) bp.push([0, land]);
  for (const t of ts) bp.push([gap / 2 + t * (1 - gap), concave ? 1 - beadProfile(prof, t) : beadProfile(prof, t)]);
  if (gap > 1e-3) bp.push([1, land]);
  const V0 = Math.floor(v0), V1 = Math.ceil(v1), K0 = Math.floor(u0) - 1, K1 = Math.ceil(u1) + 1;
  if ((K1 - K0) * bp.length > maxFaces) throw new Error('too-many-faces');
  // a repeat's last breakpoint is the next one's first
  const pid = (k, i, end) => (i === bp.length - 1 ? point(`s|${k + 1}|0|${end}`, k + 1, end ? V1 : V0) : point(`s|${k}|${i}|${end}`, k + bp[i][0], end ? V1 : V0));
  for (let k = K0; k < K1; k++) {
    if (!wanted([[k, V0], [k + 1, V0], [k + 1, V1], [k, V1]])) continue;
    for (let i = 0; i + 1 < bp.length; i++) {
      if (bp[i + 1][0] - bp[i][0] < 1e-9) continue;
      const h0 = bp[i][1], h1 = bp[i + 1][1];
      face([pid(k, i, 0), pid(k, i + 1, 0), pid(k, i + 1, 1), pid(k, i, 1)], [h0, h1, h1, h0], 0, T(`f|${k}`));
    }
  }
}

// ---- studs and dimples: a round bump or dent (a 16-sided base) on each square, the ground round it in one piece
function studMesh(C, map) {
  const { P, u0, v0, u1, v1, g, point, face, features, maxFaces, wanted, T } = C;
  const dimple = map === 'dimples', R = P.size / 200, stag = !!P.staggered, K = 16, land = dimple ? 1 : 0;
  const n = Math.max(3, Math.min(8, Math.round(R / Math.max(g, 0.01))));
  let rings;
  if (P.profile === 'cone') rings = [[1, land], [0, 1 - land]];
  else if (P.profile === 'button') rings = [[1, 0], [0.7, 1]];
  else { rings = [[1, land]]; for (let k = 1; k <= n; k++) { const phi = (Math.PI / 2) * (1 - k / n); rings.push([Math.sin(phi), dimple ? 1 - Math.cos(phi) : Math.cos(phi)]); } }
  if (features * (K * rings.length + 24) > maxFaces) throw new Error('too-many-faces');
  // corners in half units (staggered rows sit half a square along), so every key is a whole number
  const lat = (x2, y) => point(`q|${x2}|${y}`, x2 / 2, y);
  for (let j = Math.floor(v0) - 1; j <= Math.ceil(v1); j++) {
    const off2 = stag && (j & 1) ? 1 : 0;
    for (let i = Math.floor(u0) - 2; i <= Math.ceil(u1) + 1; i++) {
      const x2 = 2 * i + off2, x0 = x2 / 2, cx = x0 + 0.5, cy = j + 0.5;
      if (!wanted([[x0, j], [x0 + 1, j], [x0 + 1, j + 1], [x0, j + 1]])) continue;
      // the base: 16 sides, with corners at 90 and 270 degrees, on the square's vertical midline
      const key = `${x2}|${j}`, tile = T(`sd|${key}`), loc = [], ids = [];
      for (let k = 0; k < K; k++) { const a = k * 2 * Math.PI / K, p = [cx + R * Math.cos(a), cy + R * Math.sin(a)]; loc.push(p); ids.push(point(`sd|${key}|${k}`, p[0], p[1])); }
      if (stag) {
        // staggered, the square's top and bottom have their midpoints as corners (the next rows' corners), in a line
        // with its own; earcut would make flat slivers of them, so the ground is cut in two along the midline
        const bm = lat(x2 + 1, j), tm = lat(x2 + 1, j + 1);
        tileFaces([lat(x2, j), bm, ...[12, 11, 10, 9, 8, 7, 6, 5, 4].map(k => ids[k]), tm, lat(x2, j + 1)], [], C, () => land, 0, tile);
        tileFaces([bm, lat(x2 + 2, j), lat(x2 + 2, j + 1), tm, ...[4, 3, 2, 1, 0, 15, 14, 13, 12].map(k => ids[k])], [], C, () => land, 0, tile);
      } else tileFaces([lat(x2, j), lat(x2 + 2, j), lat(x2 + 2, j + 1), lat(x2, j + 1)], [ids.slice().reverse()], C, () => land, 0, tile);
      ringFaces(ids, loc, [cx, cy], rings, `sdr|${key}`, C, 0, tile);
    }
  }
}

// ---- diamond tread plate: a chamfered diamond bar on each square, turned alternately, on flat ground
function treadMesh(C) {
  const { P, u0, v0, u1, v1, point, face, features, maxFaces, wanted, T } = C;
  const L = P.length / 200, W = P.width / 200, c = Math.SQRT1_2, rings = [[1, 0], [0.65, 1]];
  if (features * 24 > maxFaces) throw new Error('too-many-faces');
  const lat = (x, y) => point(`tq|${x}|${y}`, x, y);
  for (let j = Math.floor(v0) - 1; j <= Math.ceil(v1); j++) for (let i = Math.floor(u0) - 1; i <= Math.ceil(u1); i++) {
    if (!wanted([[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]])) continue;
    const s = ((i + j) & 1) ? 1 : -1, cx = i + 0.5, cy = j + 0.5, key = `${i},${j}`, tile = T(`tr|${key}`);
    const dir = [c, s * c], perp = [-s * c, c];
    const loc = [[cx + L * dir[0], cy + L * dir[1]], [cx + W * perp[0], cy + W * perp[1]], [cx - L * dir[0], cy - L * dir[1]], [cx - W * perp[0], cy - W * perp[1]]];
    const ids = loc.map((p, k) => point(`tr|${key}|${k}`, p[0], p[1]));
    tileFaces([lat(i, j), lat(i + 1, j), lat(i + 1, j + 1), lat(i, j + 1)], [ids], C, () => 0, 0, tile);
    ringFaces(ids, loc, [cx, cy], rings, `trr|${key}`, C, 0, tile);
  }
}

// ---- fish scales: discs of radius SCALE_R in rows one unit apart, two apart along a row, odd rows shifted by one.
// A scale is its disc less every disc in front of it: the next along its row and the two rows above. Its outline
// is arcs: its own circle where nothing covers it, and the circles in front where they cut into it. Every circle
// is sampled at the same points (fixed angles plus its crossings with every nearby circle, each crossing made once
// per pair), so a stretch of arc shared by two scales has the same vertices in both.
function scaleMesh(C) {
  const { seed, P, u0, v0, u1, v1, g, point, face, cellOf, features, maxFaces, wanted, T, lpts } = C;
  const R = SCALE_R, K = 2 * Math.max(12, Math.min(48, Math.round(Math.PI * R / Math.max(g, 0.01))));
  if (features * K > maxFaces) throw new Error('too-many-faces');
  const centre = (i, j) => [2 * i + (j & 1), j], ck = (i, j) => `${i},${j}`;
  const near = (i, j) => {
    const [cx, cy] = centre(i, j), out = [];
    for (let dj = -2; dj <= 2; dj++) for (let di = -3; di <= 3; di++) {
      if (!di && !dj) continue;
      const [x, y] = centre(i + di, j + dj);
      if (Math.hypot(x - cx, y - cy) < 2 * R - 1e-9) out.push([i + di, j + dj]);
    }
    return out;
  };
  const verts = new Map(), crossings = new Map();
  const circleVerts = (i, j) => {
    const k = ck(i, j);
    if (verts.has(k)) return verts.get(k);
    const [cx, cy] = centre(i, j), list = [];
    for (const [ni, nj] of near(i, j)) {
      const k2 = ck(ni, nj), pk = k < k2 ? `${k}|${k2}` : `${k2}|${k}`;
      let ids = crossings.get(pk);
      if (!ids) {
        const [A, B] = k < k2 ? [[i, j], [ni, nj]] : [[ni, nj], [i, j]];
        const [ax, ay] = centre(...A), [bx, by] = centre(...B), d = Math.hypot(bx - ax, by - ay);
        const hh = Math.sqrt(R * R - d * d / 4), ux = (bx - ax) / d, uy = (by - ay) / d, mx = (ax + bx) / 2, my = (ay + by) / 2;
        ids = [point(`sx|${pk}|0`, mx - uy * hh, my + ux * hh), point(`sx|${pk}|1`, mx + uy * hh, my - ux * hh)];
        crossings.set(pk, ids);
      }
      for (const id of ids) { let a = Math.atan2(lpts[id][1] - cy, lpts[id][0] - cx); if (a < 0) a += 2 * Math.PI; list.push({ a, id }); }
    }
    for (let m = 0; m < K; m++) {
      const a = 2 * Math.PI * m / K;
      if (list.some(o => Math.abs(o.a - a) < 1e-4 || Math.abs(Math.abs(o.a - a) - 2 * Math.PI) < 1e-4)) continue;   // too close to a crossing
      list.push({ a, id: point(`sc|${k}|${m}`, cx + R * Math.cos(a), cy + R * Math.sin(a)) });
    }
    list.sort((p, q) => p.a - q.a);
    verts.set(k, list);
    return list;
  };
  // each piece of a circle between two neighbouring sample points, with the point halfway round it
  const arcs = (i, j) => {
    const list = circleVerts(i, j), [cx, cy] = centre(i, j), out = [];
    for (let m = 0; m < list.length; m++) {
      const p = list[m], q = list[(m + 1) % list.length], am = m + 1 < list.length ? (p.a + q.a) / 2 : (p.a + q.a + 2 * Math.PI) / 2;
      out.push([p.id, q.id, cx + R * Math.cos(am), cy + R * Math.sin(am)]);
    }
    return out;
  };
  const inside = (x, y, [i, j]) => { const [cx, cy] = centre(i, j); return Math.hypot(x - cx, y - cy) < R - 1e-9; };
  for (let j = Math.floor(v0) - 2; j <= Math.ceil(v1) + 2; j++) {
    for (let i = Math.floor((u0 - 2) / 2) - 1; i <= Math.ceil((u1 + 2) / 2) + 1; i++) {
      const [cx, cy] = centre(i, j);
      if (!wanted([[cx - R, cy - R], [cx + R, cy - R], [cx + R, cy + R], [cx - R, cy + R]])) continue;
      const own = [i, j], fronts = near(i, j).filter(([ni, nj]) => nj > j || (nj === j && ni === i + 1)), segs = [];
      // its own circle, counter-clockwise, where nothing in front covers it
      for (const [p, q, mx, my] of arcs(i, j)) if (!fronts.some(f => inside(mx, my, f))) segs.push([p, q]);
      // the circles in front, clockwise round them, where they cut into this disc and no other front covers them
      for (const f of fronts) for (const [p, q, mx, my] of arcs(...f)) if (inside(mx, my, own) && !fronts.some(o => o !== f && inside(mx, my, o))) segs.push([q, p]);
      if (!segs.length) continue;
      const next = new Map();
      for (const [p, q] of segs) { if (next.has(p)) throw new Error('a scale outline branches'); next.set(p, q); }
      const used = new Set(), key = ck(i, j), cell = cellOf(`sc|${key}`), tile = T(`sc|${key}`);
      for (const start of next.keys()) {
        if (used.has(start)) continue;
        const loop = [];
        let cur = start;
        while (!used.has(cur)) { used.add(cur); loop.push(cur); cur = next.get(cur); if (cur === undefined) throw new Error('a scale outline is open'); }
        if (loop.length >= 3) tileFaces(loop, [], C, id => scaleHeight(seed, i, j, lpts[id][1], P), cell, tile);
      }
    }
  }
}

const GENERATORS = { crystal: voronoiCells, pebbles: voronoiCells, knurl: knurlMesh, hexdome: hexMesh, bricks: brickMesh, weave: weaveMesh, fluted: stripMesh, reeded: stripMesh, studs: studMesh, dimples: studMesh, scales: scaleMesh, blocks: blockMesh, tread: treadMesh };

/**
 * A smooth map as a mesh like cellMesh's (one cell): a square grid over the world box at `grid` mm (coarsened to
 * stay under maxFaces), each square split along the diagonal nearer the height at its centre. For the exact path's
 * extras on smooth maps: terraces, colours by height, a tip colour.
 */
export function latticeMesh(hf, box, grid = 0.4, { maxFaces = 300000 } = {}) {
  const W = box.x1 - box.x0, H = box.y1 - box.y0;
  const g = Math.max(grid, Math.sqrt(((W + 3 * grid) * (H + 3 * grid) * 2) / maxFaces));
  // started an irrational share of a step off the box, so no lattice line lies along a straight edge of the area
  const nx = Math.ceil(W / g) + 3, ny = Math.ceil(H / g) + 3, x0 = box.x0 - g * (1 - 0.381966), y0 = box.y0 - g * (1 - 0.2360679);
  const pts = [], hs = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = x0 + i * g, y = y0 + j * g; pts.push([x, y]); hs.push(hf(x, y)); }
  const faces = [];
  for (let j = 0; j + 1 < ny; j++) for (let i = 0; i + 1 < nx; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx + 1, d = a + nx;
    const mid = hf(x0 + (i + 0.5) * g, y0 + (j + 0.5) * g);
    if (Math.abs((hs[a] + hs[c]) / 2 - mid) <= Math.abs((hs[b] + hs[d]) / 2 - mid)) { faces.push({ v: [a, b, c], h: [hs[a], hs[b], hs[c]], cell: 0, tile: 0 }); faces.push({ v: [a, c, d], h: [hs[a], hs[c], hs[d]], cell: 0, tile: 0 }); }
    else { faces.push({ v: [b, c, d], h: [hs[b], hs[c], hs[d]], cell: 0, tile: 0 }); faces.push({ v: [b, d, a], h: [hs[b], hs[d], hs[a]], cell: 0, tile: 0 }); }
  }
  return { pts, faces, cells: 1, grid: g };
}

/** High is low: every height h becomes 1 - h. */
export function invertMesh(mesh) {
  return { ...mesh, faces: mesh.faces.map(f => ({ ...f, h: f.h.map(h => 1 - h) })) };
}

/**
 * Cut every face along the level lines h = levels[k] (ascending). On a face its heights are a plane, so its level
 * lines are parallel and cut it into convex strips. Every crossing a cell makes on an edge is added to both faces
 * on that edge (a cliff edge gets its points from both sides), so the cut mesh still conforms. Each strip carries
 * `band` (the number of levels below it). With `values`, a strip is flattened to values[band] and gets a cell of
 * its own per (cell, band), so the steps between bands become cliffs: terraces.
 *
 * A crossing is kept at least CLEAR mm from either end of its edge (nearer, the 3MF writer's weld, to 0.0001 mm,
 * would merge it with that corner): it slides along its edge, and a strip takes its points by which level made
 * them, not by their height, so the line between two strips stays a chord of the face and both strips stay convex.
 * A level is never moved onto a corner, which would let several strips of different heights meet at that corner.
 */
export function cutLevels(mesh, levels, { values = null } = {}) {
  // EPS: a corner this close to a level (in h) is on it: in both strips round it, and no crossing is made beside it
  const { faces } = mesh, NG = mesh.pts.length, pts = mesh.pts.slice(), EPS = 1e-7, CLEAR = 3e-4;
  const NC = mesh.cells + 1, hc = new Map();
  for (const f of faces) for (let i = 0; i < f.v.length; i++) { const k = f.v[i] * NC + f.cell; if (!hc.has(k)) hc.set(k, f.h[i]); }
  const H = (v, c) => hc.get(v * NC + c);
  const ekey = (a, b) => (a < b ? a * NG + b : b * NG + a);
  // the first level above h (levels ascending)
  const above = h => { let lo = 0, hi = levels.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (levels[mid] <= h) lo = mid + 1; else hi = mid; } return lo; };
  const on = new Map();   // edge -> [{ t, id, tags: [[cell, level index], ...] }]
  for (const f of faces) for (let i = 0; i < f.v.length; i++) {
    const p = f.v[i], q = f.v[(i + 1) % f.v.length], a = Math.min(p, q), b = Math.max(p, q);
    const ha = H(a, f.cell), hb = H(b, f.cell);
    if (Math.abs(hb - ha) < EPS) continue;
    const k = ekey(a, b), len = Math.hypot(pts[b][0] - pts[a][0], pts[b][1] - pts[a][1]);
    if (len < 2 * CLEAR) continue;   // too short to hold a crossing apart from its ends (sub-micron; never seen)
    let list = on.get(k);
    for (let li = above(Math.min(ha, hb)); li < levels.length && levels[li] < Math.max(ha, hb); li++) {
      const L = levels[li];
      if (Math.abs(ha - L) <= EPS || Math.abs(hb - L) <= EPS) continue;   // the edge ends on the level: no crossing
      const t = Math.min(1 - CLEAR / len, Math.max(CLEAR / len, (L - ha) / (hb - ha)));
      // made already: by this cell's other face on the edge, by a neighbouring cell level with it there, or by
      // another level slid to the same place
      const same = list && list.find(it => Math.abs(it.t - t) * len < 1e-9);
      if (same) { if (!same.tags.some(([c, l]) => c === f.cell && l === li)) same.tags.push([f.cell, li]); continue; }
      const id = pts.length;
      pts.push([pts[a][0] + (pts[b][0] - pts[a][0]) * t, pts[a][1] + (pts[b][1] - pts[a][1]) * t]);
      if (!list) { list = []; on.set(k, list); }
      list.push({ t, id, tags: [[f.cell, li]] });
    }
  }
  const bandOf = h => { let m = 0; while (m < levels.length && h > levels[m] + EPS) m++; return m; };
  const newCells = new Map(), out = [];
  for (const f of faces) {
    // the face's outline with every point on its edges: each point's height in this cell, and its bands
    const n = f.v.length, ring = [], rh = [], rb = [];
    const bandsAt = h => { const m = bandOf(h); return m < levels.length && Math.abs(h - levels[m]) <= EPS ? [m, m + 1] : [m]; };
    for (let i = 0; i < n; i++) {
      const p = f.v[i], q = f.v[(i + 1) % n], hp = H(p, f.cell);
      ring.push(p); rh.push(hp); rb.push(bandsAt(hp));
      const list = on.get(ekey(p, q));
      if (!list) continue;
      const a = Math.min(p, q), b = Math.max(p, q), ha = H(a, f.cell), hb = H(b, f.cell);
      const s = list.slice().sort((x, y) => x.t - y.t);
      if (p > q) s.reverse();
      for (const it of s) {
        const h = ha + (hb - ha) * it.t, mine = it.tags.filter(([c]) => c === f.cell).map(([, l]) => l);
        // a crossing this cell made sits on the line between the two bands round its level
        ring.push(it.id); rh.push(h); rb.push(mine.length ? [...new Set(mine.flatMap(l => [l, l + 1]))] : bandsAt(h));
      }
    }
    let lo = Infinity, hi = -Infinity, hmin = Infinity, hmax = -Infinity;
    for (const bs of rb) for (const m of bs) { lo = Math.min(lo, m); hi = Math.max(hi, m); }
    for (const h of rh) { hmin = Math.min(hmin, h); hmax = Math.max(hmax, h); }
    // a face lying flat on a level is one strip: a terrace keeps it at that level (steps are floored, so the band
    // above), a plain cut (the tip, colour bands) leaves it in the band below, so no tip film of zero height
    if (hmax - hmin <= 2 * EPS) hi = lo = values ? above(hmin + EPS) : bandOf(hmin);
    for (let m = lo; m <= hi; m++) {
      const v = [], h = [];
      ring.forEach((id, k) => { if (rb[k].includes(m)) { v.push(id); h.push(rh[k]); } });
      if (v.length < 3) continue;
      let area = 0;
      for (let k = 0; k < v.length; k++) { const P0 = pts[v[k]], P1 = pts[v[(k + 1) % v.length]]; area += P0[0] * P1[1] - P1[0] * P0[1]; }
      if (Math.abs(area) < 1e-14) continue;
      if (values) {
        const ck = `${f.cell}|${m}`;
        let cell = newCells.get(ck);
        if (cell === undefined) { cell = newCells.size; newCells.set(ck, cell); }
        out.push({ ...f, v, h: v.map(() => values[m]), cell, band: m });
      } else out.push({ ...f, v, h, band: m });
    }
  }
  return { pts, faces: out, cells: values ? Math.max(1, newCells.size) : mesh.cells };
}

/** About how fine a texture's finest printed detail is, in mm, for the check that it is not finer than a nozzle can
 *  draw. null for a picture (its detail is the picture's). */
export function finestFeature(map, scale, raw) {
  const P = cleanTextureParams(map, raw), s = Number(scale) || 4;
  switch (map) {
    case 'weave': return s / (Number(P.strands) || 3);
    case 'fluted': case 'reeded': return 0.5 * s * (1 - P.gap / 100);
    case 'studs': case 'dimples': return s * P.size / 100;
    case 'tread': return s * P.width / 100;
    case 'blocks': return s / SQ3;
    case 'noise': return 0.25 * s;
    case 'picture': return null;
    default: return 0.5 * s;
  }
}
