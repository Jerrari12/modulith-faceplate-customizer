// Crisp tapers (2026-11-11): the body of a raised drawing, combine or outline meshed exactly, with flat faces and
// sharp creases, where the grid mesher (surface.js) leaves 0.25 mm facets along every crease.
//
// The top of such a body is a profile of the distance d from the drawn outline (path.js sideProfile: a wall, then a
// chamfer or a round, then flat at the full height). That distance is exactly flat over each side's own strip (the
// band its foot runs along) and a cone over an inside corner; so the area is cut into pieces that each lie on one of
// those, the lowest wherever they meet (that line is the crease, a hip or a valley), and each piece is cut again
// where the profile turns (the top edge, a chamfer, the chords of a round). On every piece the height is then a
// flat function, so the triangles lie exactly on the true surface: the sides are flat and the creases straight,
// and only an inside corner's cone (in sectors of at most 7.5°) and a round (in chords) are followed by facets.
//
// The work is done cell by cell (a grid only to keep the candidate sides few), with plain convex cuts; the pieces of
// all cells are welded, every piece's edge is split wherever another piece has a corner on it, and every corner's
// height comes from the exact distance, so the top is watertight. The walls go down from the top's open edges (the
// outline, the plate's edge, a screw hole) and the bottom is the same pieces, flat and facing down. The result is
// checked closed; anything that fails comes back null and the caller uses the grid mesher.

import * as P from './polys.js';
import { triangulate } from './extrude.js';

// (WELDS: the welding distances tried in turn, 0.01 to 0.3 micron: the finest is near float32's own grain at 100 mm,
// the coarsest still thousands of times finer than a layer)
const EPS = 1e-9, WELDS = [1e-5, 2.5e-5, 6e-5, 1.5e-4, 3e-4], MITRE_TURN = 10 * Math.PI / 180;
export const ROOF_LIMITS = { maxPieces: 250000, maxCandidates: 600, maxWork: 2e7 };
export const roofStats = { exact: 0, fallback: 0, lastError: '' };

// ---- convex polygons, as [[x, y], ...] counter-clockwise
const area2 = poly => { let s = 0; for (let i = 0, n = poly.length; i < n; i++) { const p = poly[i], q = poly[(i + 1) % n]; s += p[0] * q[1] - q[0] * p[1]; } return s; };
function tidy(poly) {
  const out = [];
  for (const p of poly) { const l = out[out.length - 1]; if (!l || Math.abs(l[0] - p[0]) > 1e-12 || Math.abs(l[1] - p[1]) > 1e-12) out.push(p); }
  while (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) <= 1e-12 && Math.abs(out[0][1] - out[out.length - 1][1]) <= 1e-12) out.pop();
  return out.length >= 3 && Math.abs(area2(out)) > 1e-14 ? out : null;
}
/** A convex polygon cut by the line a x + b y + c = 0: [the part where that is <= 0, the part where it is >= 0]. */
function cut(poly, [a, b, c]) {
  const n = poly.length, v = poly.map(([x, y]) => a * x + b * y + c);
  let neg = false, pos = false;
  for (const x of v) { if (x < -EPS) neg = true; else if (x > EPS) pos = true; }
  if (!pos) return [poly, null];
  if (!neg) return [null, poly];
  const lo = [], hi = [];
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n], vp = v[i], vq = v[(i + 1) % n];
    if (vp <= EPS) lo.push(p);
    if (vp >= -EPS) hi.push(p);
    if ((vp < -EPS && vq > EPS) || (vp > EPS && vq < -EPS)) { const t = vp / (vp - vq), r = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]; lo.push(r); hi.push(r); }
  }
  return [tidy(lo), tidy(hi)];
}

/**
 * An outline with the points that add nothing taken out: each kept point is the farthest a straight run can reach
 * with every point it skips within `tol` mm of it (outlines traced from a raster, as offsets are, carry a point
 * every few hundredths of a millimetre along a straight side). Rings that collapse are dropped.
 */
export function simplifyOutline(mp, tol = 0.003) {
  const off = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy); return L < 1e-12 ? Math.hypot(p[0] - a[0], p[1] - a[1]) : Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / L; };
  const ringOut = ring => {
    const pts = ring.slice();
    if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    if (pts.length < 4) return pts.length >= 3 ? [...pts, pts[0]] : null;
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = i + 1;
      while (j + 1 < pts.length) {
        let ok = true;
        for (let k = i + 1; k <= j; k++) if (off(pts[k], pts[i], pts[j + 1]) > tol) { ok = false; break; }
        if (!ok) break;
        j++;
      }
      out.push(pts[j]); i = j;
    }
    if (out.length > 3 && off(out[out.length - 1], out[out.length - 2], out[0]) <= tol) out.pop();
    return out.length >= 3 ? [...out, out[0]] : null;
  };
  return mp.map(poly => poly.map(ringOut).filter(Boolean)).filter(poly => poly.length && poly[0].length >= 4);
}

/**
 * The outline's features: each side (a segment) is a plane f(p) = its distance in from the side's line, over its
 * strip (its foot within the segment, on the inside); each inside corner a cone, in sectors of at most 7.5°, each
 * sector the plane along its middle. A feature is { f: [a, b, c] (f = a x + b y + c), dom: half-planes [a, b, c]
 * (a x + b y + c <= 0 inside), at (the point or segment its distance is measured to) }.
 */
export function roofFeatures(outline) {
  const feats = [];
  for (const poly of outline) poly.forEach((ring0, ri) => {
    // the inside on the left: outlines counter-clockwise, holes clockwise
    let ring = ring0.slice();
    if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
    if (ring.length < 3) return;
    if ((ri === 0) !== (area2(ring) > 0)) ring.reverse();
    const n = ring.length, segs = [];
    for (let k = 0; k < n; k++) {
      const A = ring[k], B = ring[(k + 1) % n], dx = B[0] - A[0], dy = B[1] - A[1], len = Math.hypot(dx, dy);
      if (len < 1e-9) { segs.push(null); continue; }
      const ux = dx / len, uy = dy / len, nx = -uy, ny = ux, au = ux * A[0] + uy * A[1], an = nx * A[0] + ny * A[1];
      const s = { f: [nx, ny, -an], dom: [[-ux, -uy, au], [ux, uy, -au - len], [-nx, -ny, an]], seg: [A, B], ux, uy };
      segs.push(s); feats.push(s);
    }
    for (let k = 0; k < n; k++) {
      // an inside corner turns right (for a counter-clockwise outline, and a clockwise hole alike)
      let i = (k - 1 + n) % n;
      while (!segs[i] && i !== k) i = (i - 1 + n) % n;
      const sIn = segs[i], sOut = segs[k];
      if (!sIn || !sOut || sIn === sOut) continue;
      if (sIn.ux * sOut.uy - sIn.uy * sOut.ux >= -1e-12) continue;
      const V = ring[k];
      // the cone's wedge runs from the outgoing side's inward normal round (counter-clockwise) to the incoming one's
      const t0 = Math.atan2(sOut.ux, -sOut.uy);
      let t1 = Math.atan2(sIn.ux, -sIn.uy);
      while (t1 < t0) t1 += 2 * Math.PI;
      const turn = t1 - t0;
      if (turn < MITRE_TURN) {
        // a slight inside turn (a curve's): no cone, the two sides meet on the bisector, as a mitred offset does
        // (the cone and the mitre differ by d * turn^2 / 8: under 0.01 mm at 6 mm in for a 10° turn)
        let mx = sIn.ux + sOut.ux, my = sIn.uy + sOut.uy;
        const L = Math.hypot(mx, my); mx /= L; my /= L;
        const mv = mx * V[0] + my * V[1];
        sIn.dom[1] = [mx, my, -mv];       // the incoming side ends at the bisector
        sOut.dom[0] = [-mx, -my, mv];     // the outgoing side starts there
        continue;
      }
      const m = Math.max(1, Math.ceil(turn / (Math.PI / 24)));
      for (let j = 0; j < m; j++) {
        const p0 = t0 + turn * j / m, p1 = t0 + turn * (j + 1) / m, pm = (p0 + p1) / 2;
        const ux = Math.cos(pm), uy = Math.sin(pm), r0 = [Math.cos(p0), Math.sin(p0)], r1 = [Math.cos(p1), Math.sin(p1)];
        feats.push({
          f: [ux, uy, -(ux * V[0] + uy * V[1])],
          dom: [[r0[1], -r0[0], r0[0] * V[1] - r0[1] * V[0]], [-r1[1], r1[0], r1[1] * V[0] - r1[0] * V[1]]],
          at: V,
        });
      }
    }
  });
  return feats;
}

/** The distance from (x, y) to a feature's own point or segment. */
function featureDistance(ft, x, y) {
  if (ft.at) return Math.hypot(x - ft.at[0], y - ft.at[1]);
  const [A, B] = ft.seg, dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - A[0]) * dx + (y - A[1]) * dy) / L2)) : 0;
  return Math.hypot(x - A[0] - dx * t, y - A[1] - dy * t);
}

/**
 * A convex piece cut where each feature is the lowest: each feature's part is kept inside the feature's own domain,
 * and what falls outside it is worked out again without that feature. Pushes { poly, f } (f null: no feature, flat).
 */
function envelope(poly, feats, out, ctx, depth = 0) {
  // only the sides that can be the lowest somewhere in this piece: the distance changes by at most 1 mm per mm, so
  // such a side is within (the distance at the piece's middle + twice its radius) of the middle; and one that stays
  // past the top's edge everywhere in it does not matter (the top is flat there)
  let cx = 0, cy = 0;
  for (const [x, y] of poly) { cx += x; cy += y; }
  cx /= poly.length; cy /= poly.length;
  let r = 0;
  for (const [x, y] of poly) r = Math.max(r, Math.hypot(x - cx, y - cy));
  const near = Math.min(ctx.dist(cx, cy) + 2 * r, ctx.T + r) + 1e-9;
  feats = feats.filter(ft => featureDistance(ft, cx, cy) <= near);
  if (!feats.length || depth > 48) { out.push({ poly, f: null }); return; }
  // lowest at the middle first: a side that is lowest nowhere is cut away by its first comparisons
  const at = ft => ft.f[0] * cx + ft.f[1] * cy + ft.f[2];
  feats = feats.slice().sort((p, q) => at(p) - at(q));
  for (let i = 0; i < feats.length; i++) {
    const fi = feats[i].f;
    let reg = poly;
    for (let j = 0; j < feats.length && reg; j++) {
      if (j === i) continue;
      const fj = feats[j].f, a = fi[0] - fj[0], b = fi[1] - fj[1], c = fi[2] - fj[2];
      // two features level with each other over the whole piece (the same plane, or two sides of a thinned curve
      // that are nearly in line): a tie, which the first one in the list takes (its domain then decides). Cut
      // instead, both would keep the piece, the cut treating every corner as on the line.
      if (reg.every(([x, y]) => Math.abs(a * x + b * y + c) <= EPS)) { if (j < i) reg = null; continue; }
      if (--ctx.left < 0) throw new Error('the crease search ran too long');
      reg = cut(reg, [a, b, c])[0];
    }
    if (!reg) continue;
    const rest = [];
    for (const h of feats[i].dom) {
      if (!reg) break;
      const [inside, outside] = cut(reg, h);
      if (outside) rest.push(outside);
      reg = inside;
    }
    if (reg) out.push({ poly: reg, f: fi });
    if (rest.length) { const others = feats.filter((_, j) => j !== i); for (const q of rest) envelope(q, others, out, ctx, depth + 1); }
  }
}

/**
 * The exact body: `region` (MultiPolygon, the part of the outline the plate keeps) raised from z0 with the side
 * `side` (sideProfile's { at, reach, levels }) measured from `outline`; `dist(x, y)` the exact distance to the
 * outline (at least up to reach). Returns { tris, footprint, z0, z1, exact: true } or null when it cannot be built
 * exactly (the caller then uses the grid mesher).
 */
export function roofBody(region, outline, { z0 = 0, side, dist } = {}) {
  try {
    const out = buildRoof(region, outline, z0, side, dist);
    if (out) { roofStats.exact++; return out; }
    roofStats.fallback++;
    return null;
  } catch (e) {
    roofStats.fallback++; roofStats.lastError = String(e?.message || e);
    return null;
  }
}

function buildRoof(region, outline, z0, side, dist) {
  if (!region?.length || !outline?.length || !side) return null;
  const T = side.reach, levels = (side.levels || []).filter(t => t > 1e-9 && t < T + 1e-9);
  const b = P.bbox(region);
  if (!b || !(b.w > 0) || !(b.h > 0)) return null;
  const feats = roofFeatures(outline);
  const s = Math.min(4, Math.max(0.75, T * 0.75)), diag = s * Math.SQRT2;
  const nx = Math.max(1, Math.ceil(b.w / s)), ny = Math.max(1, Math.ceil(b.h / s));
  const pieces = [], ctx = { left: ROOF_LIMITS.maxWork, dist, T };
  for (let j = 0; j < ny; j++) {
    const ry0 = b.y0 + j * s, ry1 = Math.min(b.y1, ry0 + s);
    if (ry1 - ry0 < 1e-9) continue;
    const row = P.intersection(region, P.rect(b.x0 - 1, ry0, b.x1 + 1, ry1));
    if (P.isEmpty(row)) continue;
    // the row's edges that run through cells (not along the row's own top and bottom)
    const edges = [];
    for (const poly of row) for (const ring of poly) for (let k = 0; k + 1 < ring.length; k++) {
      const [x0, y0] = ring[k], [x1, y1] = ring[k + 1];
      if (Math.abs(y0 - y1) < 1e-9 && (Math.abs(y0 - ry0) < 1e-9 || Math.abs(y0 - ry1) < 1e-9)) continue;
      edges.push([Math.min(x0, x1), Math.max(x0, x1)]);
    }
    for (let i = 0; i < nx; i++) {
      const cx0 = b.x0 + i * s, cx1 = Math.min(b.x1, cx0 + s);
      if (cx1 - cx0 < 1e-9) continue;
      const mx = (cx0 + cx1) / 2, my = (ry0 + ry1) / 2;
      let cell;
      if (!edges.some(([e0, e1]) => e1 >= cx0 - 1e-9 && e0 <= cx1 + 1e-9)) {
        if (!P.contains(row, mx, my)) continue;
        cell = [[[cx0, ry0], [cx1, ry0], [cx1, ry1], [cx0, ry1]]];
      } else {
        cell = [];
        for (const poly of P.intersection(row, P.rect(cx0, ry0, cx1, ry1))) {
          const tri = triangulate(poly);
          for (let m = 0; m + 2 < tri.length; m += 3) { const t = tidy([tri[m], tri[m + 1], tri[m + 2]]); if (t) cell.push(t); }
        }
        if (!cell.length) continue;
      }
      const dC = dist(mx, my);
      if (dC - diag / 2 >= T) { for (const c of cell) pieces.push(c); continue; }   // all of it flat at the top
      const bound = Math.min(T, dC + diag / 2) + diag / 2;
      const cand = feats.filter(ft => featureDistance(ft, mx, my) <= bound + 1e-9);
      if (cand.length > ROOF_LIMITS.maxCandidates) throw new Error(`too many sides near one cell (${cand.length})`);
      // an inside corner's sectors only compete inside their own sector: the cell is first cut along the sectors'
      // edges (lines through the corner, a few per corner), and each part takes the sectors it lies in. (A sector's
      // plane carried past its sector runs low, so letting it claim and give back would go round and round.)
      const segs = cand.filter(ft => ft.seg), cones = cand.filter(ft => ft.at), lines = [], seenLine = new Set();
      for (const ft of cones) for (const h of ft.dom) {
        const k = h.map(v => Math.round(v * 1e9)).join(',');
        if (!seenLine.has(k)) { seenLine.add(k); lines.push(h); }
      }
      for (const c of cell) {
        let parts = [c];
        for (const h of lines) { const next = []; for (const q of parts) { const [lo, hi] = cut(q, h); if (lo) next.push(lo); if (hi) next.push(hi); } parts = next; }
        const regions = [];
        for (const q of parts) {
          let qx = 0, qy = 0;
          for (const [x, y] of q) { qx += x; qy += y; }
          qx /= q.length; qy /= q.length;
          const active = segs.concat(cones.filter(ft => ft.dom.every(([a, bb, k]) => a * qx + bb * qy + k <= 1e-9)));
          envelope(q, active, regions, ctx);
        }
        for (const { poly, f } of regions) {
          if (!f) { pieces.push(poly); continue; }
          let rem = poly;
          for (const t of levels) {
            if (!rem) break;
            const [lo, hi] = cut(rem, [f[0], f[1], f[2] - t]);
            if (lo) pieces.push(lo);
            rem = hi;
          }
          if (rem) pieces.push(rem);
        }
      }
      if (pieces.length > ROOF_LIMITS.maxPieces) throw new Error('too many pieces');
    }
  }
  if (!pieces.length) return null;
  // the pieces must cover the region once: anything else is a gap or an overlap
  let covered = 0;
  for (const p of pieces) covered += Math.abs(area2(p)) / 2;
  const want = P.area(region);
  if (Math.abs(covered - want) > Math.max(1e-6, want * 1e-7)) throw new Error(`pieces cover ${covered}, the region ${want}`);
  if (roofStats.keep) roofStats.pieces = pieces;   // (for a test that looks inside)
  // two corners a hair apart, just past the welding distance, can leave a sliver of a gap or a fold: welded a little
  // coarser, they are one corner
  let err;
  for (const weld of WELDS) {
    try { return assemble(pieces, region, want, z0, side, dist, s, weld); } catch (e) { err = e; }
  }
  throw err;
}

/** For tests: the welding and closing step alone, on pieces made by hand. */
export function roofAssemble(pieces, region, { z0 = 0, side, dist, s = 1, weld = WELDS[0] } = {}) {
  return assemble(pieces, region, P.area(region), z0, side, dist, s, weld);
}

/**
 * The pieces welded into a closed body: top, walls down from its open edges, and the same pieces as the bottom.
 * WELD: corners closer than this (mm, each way) are one corner. want: the region's area.
 */
function assemble(pieces, region, want, z0, side, dist, s, WELD) {
  // welding: a point takes the vertex already within WELD of it, looked for in its hash cell and the eight round it
  // (rounding to a grid would split two points a hair apart that straddle a grid line, and leave a micro-edge)
  const V = [], buckets = new Map(), bw = 4 * WELD;
  const vid = p => {
    const gx = Math.floor(p[0] / bw), gy = Math.floor(p[1] / bw);
    for (let i = gx - 1; i <= gx + 1; i++) for (let j = gy - 1; j <= gy + 1; j++) {
      for (const w of buckets.get(`${i},${j}`) || []) if (Math.abs(V[w][0] - p[0]) <= WELD && Math.abs(V[w][1] - p[1]) <= WELD) return w;
    }
    const k = `${gx},${gy}`, idx = V.length;
    V.push(p);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(idx);
    return idx;
  };
  let polys = [], lost = 0;   // (lost: the area of the slivers left out, the most their gaps can add up to)
  for (const p of pieces) {
    // a sliver (thinner than the welding can tell apart, where a cut grazed a corner or a dense traced edge) is left
    // out: kept, the corner-on-edge repair below would fold its neighbour over it; left out, at worst a hairline gap
    // opens, and the walls close it like any edge
    let longest = 0;
    for (let k = 0; k < p.length; k++) { const q = p[(k + 1) % p.length]; longest = Math.max(longest, Math.hypot(q[0] - p[k][0], q[1] - p[k][1])); }
    if (Math.abs(area2(p)) / Math.max(longest, 1e-12) < 4 * WELD) { lost += Math.abs(area2(p)) / 2; continue; }
    const r = [];
    for (const q of p) { const i = vid(q); if (r[r.length - 1] !== i) r.push(i); }
    while (r.length > 1 && r[0] === r[r.length - 1]) r.pop();
    if (r.length < 3) continue;
    if (area2(r.map(i => V[i])) < 0) r.reverse();
    polys.push(r);
  }
  if (!polys.length) throw new Error('nothing was left after the slivers');
  // every corner lying on another piece's edge goes into that edge (the pieces of two cells, or two sides of a
  // crease, meet at the same points)
  const hs = Math.max(0.05, s / 4), grid = new Map(), cellOf = (x, y) => `${Math.floor(x / hs)},${Math.floor(y / hs)}`;
  V.forEach(([x, y], i) => { const k = cellOf(x, y); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
  const tol = 2 * WELD;
  polys = polys.map(r => {
    const outR = [];
    for (let k = 0; k < r.length; k++) {
      const a = r[k], c = r[(k + 1) % r.length], [ax, ay] = V[a], [cx, cy] = V[c];
      outR.push(a);
      const dx = cx - ax, dy = cy - ay, L2 = dx * dx + dy * dy;
      if (L2 < 1e-18) continue;
      const on = [];
      const gx0 = Math.floor((Math.min(ax, cx) - tol) / hs), gx1 = Math.floor((Math.max(ax, cx) + tol) / hs);
      const gy0 = Math.floor((Math.min(ay, cy) - tol) / hs), gy1 = Math.floor((Math.max(ay, cy) + tol) / hs);
      for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
        for (const w of grid.get(`${gx},${gy}`) || []) {
          if (w === a || w === c) continue;
          const [wx, wy] = V[w], t = ((wx - ax) * dx + (wy - ay) * dy) / L2;
          if (t <= 1e-9 || t >= 1 - 1e-9) continue;
          if (Math.abs((wx - ax) * dy - (wy - ay) * dx) / Math.sqrt(L2) > tol) continue;
          on.push([t, w]);
        }
      }
      on.sort((p, q) => p[0] - q[0]);
      for (const [, w] of on) if (outR[outR.length - 1] !== w) outR.push(w);
    }
    return outR;
  });
  // a spike (a -> b -> a, where welding pulled a piece's corners together round a point a hair off them) has no
  // area, and its two edges would each pair with a neighbour's: taken out, as are corners repeated in a row. A piece
  // that welding and the repair above leave with no area is then left out too: its corners are in its neighbours'
  // edges, which then pair with each other (and if a hairline is left, the walls close it like any edge)
  const despike = r => {
    for (let again = true; again && r.length >= 3;) {
      again = false;
      for (let k = 0, n = r.length; k < n; k++) {
        if (r[k] === r[(k + 1) % n] || r[(k + n - 1) % n] === r[(k + 1) % n]) { r.splice(k, 1); again = true; break; }
      }
    }
    return r;
  };
  // a ring through the same corner twice (a tiny loop pinched off it) is two rings; one that runs backwards (a
  // fold) has no area to give and is left out with the slivers
  const split = r => {
    const seen = new Map();
    for (let k = 0; k < r.length; k++) {
      if (seen.has(r[k])) { const j = seen.get(r[k]); return [...split(despike(r.slice(0, j).concat(r.slice(k)))), ...split(despike(r.slice(j, k)))]; }
      seen.set(r[k], k);
    }
    return [r];
  };
  polys = polys.flatMap(r => split(despike(r))).filter(r => {
    if (r.length < 3) return false;
    let longest = 0;
    for (let k = 0; k < r.length; k++) { const p = V[r[k]], q = V[r[(k + 1) % r.length]]; longest = Math.max(longest, Math.hypot(q[0] - p[0], q[1] - p[1])); }
    const a2 = area2(r.map(i => V[i]));
    if (a2 / Math.max(longest, 1e-12) >= 4 * WELD) return true;
    lost += Math.abs(a2) / 2;
    return false;
  });
  if (!polys.length) throw new Error('nothing was left after the slivers');
  // a sliver left out can leave a hairline gap in the top, and where a gap reaches a corner that another gap or the
  // outline also reaches, the walls down their sides would share that corner's upright edge. So the top's open
  // edges are walked into loops (the top on the left; at a corner with more than one way on, the first one turning
  // counter-clockwise from the way back), and a loop that runs clockwise, is thinner than the slivers, and has no
  // more area than they left out (what is still unspent of it, plus the leeway the cover check allows) is filled as
  // one more piece: a gap, where a hole of the region's own is far larger. It is filled only if fanned from one of
  // its corners every triangle faces up (a gap is thin but need not be convex, and a fan from the wrong corner would
  // lay folded triangles across it), and only if all of it lies inside the region; one that cannot be is left to
  // the walls
  {
    let budget = lost + Math.max(1e-6, want * 1e-7);
    const have = new Set(), open = new Map(), used = new Set();
    for (const r of polys) for (let k = 0; k < r.length; k++) have.add(`${r[k]}>${r[(k + 1) % r.length]}`);
    for (const r of polys) for (let k = 0; k < r.length; k++) {
      const a = r[k], b = r[(k + 1) % r.length];
      if (!have.has(`${b}>${a}`)) { if (!open.has(a)) open.set(a, []); open.get(a).push(b); }
    }
    const fills = [];
    for (const [a0, outs] of open) for (const b0 of outs) {
      if (used.has(`${a0}>${b0}`)) continue;
      used.add(`${a0}>${b0}`);
      const loop = [a0];
      let a = a0, b = b0;
      while (b !== a0 && loop.length < 5000) {
        loop.push(b);
        const back = Math.atan2(V[a][1] - V[b][1], V[a][0] - V[b][0]);
        let next = -1, best = Infinity;
        for (const c of open.get(b) || []) {
          if (used.has(`${b}>${c}`)) continue;
          let t = Math.atan2(V[c][1] - V[b][1], V[c][0] - V[b][0]) - back;
          while (t <= 0) t += 2 * Math.PI;
          if (t < best) { best = t; next = c; }
        }
        if (next < 0) break;
        used.add(`${b}>${next}`); a = b; b = next;
      }
      if (b !== a0) continue;
      const pts = loop.map(i => V[i]);
      let perim = 0;
      for (let k = 0; k < pts.length; k++) { const q = pts[(k + 1) % pts.length]; perim += Math.hypot(q[0] - pts[k][0], q[1] - pts[k][1]); }
      const A2 = area2(pts);
      if (!(A2 < 0) || -A2 / Math.max(perim, 1e-12) >= 8 * WELD || -A2 / 2 > budget || loop.length > 64) continue;
      const f = loop.reverse();
      let start = -1;
      for (let k = 0; k < f.length && start < 0; k++) {
        let up = true;
        for (let j = 1; j + 1 < f.length && up; j++) {
          const A = V[f[k]], B = V[f[(k + j) % f.length]], C = V[f[(k + j + 1) % f.length]];
          if ((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]) < -1e-10) up = false;
        }
        if (up) start = k;
      }
      if (start < 0) continue;
      // and the whole of it must lie inside the region: a gap is missing material, a hole of the region's own is not,
      // and a loop round both would fill the hole too. What of it falls outside the region must be under a
      // thousandth of it (a clipping that cannot be worked out counts as outside)
      let outside = Infinity;
      try { outside = P.area(P.difference([[[...f.map(i => V[i]), V[f[0]]]]], region)); } catch { /* left to the walls */ }
      if (!(outside <= 1e-3 * (-A2 / 2) + 1e-12)) continue;
      budget += A2 / 2;
      fills.push(f.slice(start).concat(f.slice(0, start)));
    }
    for (const f of fills) polys.push(f);
  }
  // where the region pinches to a point (a drawn path that crosses itself: two lobes touching at a corner), the
  // walls of both lobes would share that corner's upright edge. Each lobe after the first gets its own copy of the
  // corner, moved 0.05 micron into the lobe
  {
    const at = new Map();   // corner -> [[poly, position], ...]
    polys.forEach((r, pi) => r.forEach((v, k) => { if (!at.has(v)) at.set(v, []); at.get(v).push([pi, k]); }));
    const outOf = new Map();   // "corner>next" -> poly
    polys.forEach((r, pi) => r.forEach((v, k) => outOf.set(`${v}>${r[(k + 1) % r.length]}`, pi)));
    const moves = [];   // [poly, position, new corner], made once every corner has been looked at (so each is judged
                        // on the pieces as they were)
    for (const [P, uses] of at) {
      if (uses.length < 2) continue;
      const pos = new Map(uses);   // poly -> position of P in it
      const prevOf = pi => { const r = polys[pi], k = pos.get(pi); return r[(k + r.length - 1) % r.length]; };
      const nextOf = pi => { const r = polys[pi], k = pos.get(pi); return r[(k + 1) % r.length]; };
      // a lobe's fan starts at a piece whose way out (P -> x) no piece comes back along
      const starts = uses.map(([pi]) => pi).filter(pi => !outOf.has(`${nextOf(pi)}>${P}`));
      if (starts.length < 2) continue;
      starts.slice(1).forEach(first => {
        const fan = [first];
        for (let pi = first, guard = 0; guard < uses.length; guard++) {
          const back = outOf.get(`${P}>${prevOf(pi)}`);
          if (back === undefined || back === first || !pos.has(back)) break;
          fan.push(back); pi = back;
        }
        // into the lobe: halfway round (counter-clockwise) from its first way out to its last way in
        const tx = Math.atan2(V[nextOf(first)][1] - V[P][1], V[nextOf(first)][0] - V[P][0]);
        const last = fan[fan.length - 1];
        let tu = Math.atan2(V[prevOf(last)][1] - V[P][1], V[prevOf(last)][0] - V[P][0]);
        while (tu <= tx) tu += 2 * Math.PI;
        const t = (tx + tu) / 2, Q = V.length;
        V.push([V[P][0] + 5e-5 * Math.cos(t), V[P][1] + 5e-5 * Math.sin(t)]);
        for (const pi of fan) moves.push([pi, pos.get(pi), Q]);
      });
    }
    for (const [pi, k, Q] of moves) polys[pi][k] = Q;
  }
  // heights from the exact distance, the same for every piece that shares a corner
  // (a corner on the outline comes out a hair off it, 1e-15 or so: exactly on it, so its wall has no height at all)
  const z = V.map(([x, y]) => { const d = dist(x, y); return z0 + side.at(d < 1e-7 ? 0 : Math.min(d, side.reach + 1)); });
  const tris = [], keys = [], z0f = Math.fround(z0);
  // each corner as a number: 2i for corner i at the bottom, 2i + 1 at the top (unless the top comes out, in float32,
  // at the bottom's height, where the two are one corner)
  const key = (i, top) => 2 * i + (top && Math.fround(z[i]) !== z0f ? 1 : 0);
  const put = (i, top) => tris.push(V[i][0], V[i][1], top ? z[i] : z0);
  const tri = (a, at, b, bt, c, ct) => {
    // a triangle with two corners at the same place has no area: left out (its edges pair with the rest anyway)
    const ka = key(a, at), kb = key(b, bt), kc = key(c, ct);
    if (ka === kb || kb === kc || ka === kc) return;
    put(a, at); put(b, bt); put(c, ct); keys.push(ka, kb, kc);
  };
  const edges = new Set();
  for (const r of polys) for (let k = 0; k < r.length; k++) edges.add(`${r[k]}>${r[(k + 1) % r.length]}`);
  for (const r of polys) {
    for (let k = 1; k + 1 < r.length; k++) { tri(r[0], true, r[k], true, r[k + 1], true); tri(r[0], false, r[k + 1], false, r[k], false); }
    for (let k = 0; k < r.length; k++) {
      const a = r[k], c = r[(k + 1) % r.length];
      if (edges.has(`${c}>${a}`)) continue;
      // an open edge of the top: a wall down to the bottom, facing out (the inside is on the left of a -> c)
      tri(a, false, c, false, c, true);
      tri(a, false, c, true, a, true);
    }
  }
  // closed, counted on the corners' numbers first (quick), then on the coordinates themselves. Within 128 mm of the
  // origin (every plate) the welding keeps every two corners more than float32's grain apart, so the two counts
  // agree; farther out, two corners float32 makes one could fail the first count alone, and the build falls back
  {
    const M = 2 * V.length + 2, n = new Map();
    for (let t = 0; t < keys.length; t += 3) for (let e = 0; e < 3; e++) { const k = keys[t + e] * M + keys[t + (e + 1) % 3]; n.set(k, (n.get(k) || 0) + 1); }
    let bad = 0, where = null;
    for (const [k, c] of n) {
      const a = Math.floor(k / M), b = k - a * M;
      if (c !== 1 || n.get(b * M + a) !== 1) { bad++; where ||= V[a >> 1]; }
    }
    if (bad) throw new Error(`the crisp body did not close (${bad} edges, one at ${where[0].toFixed(4)}, ${where[1].toFixed(4)})`);
  }
  // a triangle that float32 rounding collapses onto a line (two corners the same) has no area: left out
  const soup = new Float32Array(tris), keep = [];
  for (let i = 0; i < soup.length; i += 9) if (!collapsed(soup, i)) keep.push(i);
  if (!keep.length) throw new Error('the crisp body came out empty');
  const out = new Float32Array(keep.length * 9);
  keep.forEach((i, k) => out.set(soup.subarray(i, i + 9), k * 9));
  if (!closedSoup(out)) throw new Error(`the crisp body did not close (${openEdges(out).slice(0, 3).join(' | ')})`);
  let z1 = z0;
  for (const v of z) if (v > z1) z1 = v;
  return { tris: out, footprint: region, z0, z1, exact: true, grid: 0 };
}

/** The edges of a soup that are not met by a reverse edge (for a failure's message). */
export function openEdges(t) {
  const n = new Map(), key = i => `${t[i]},${t[i + 1]},${t[i + 2]}`;
  for (let i = 0; i < t.length; i += 9) {
    if (collapsed(t, i)) continue;
    for (const [a, b] of [[0, 3], [3, 6], [6, 0]]) { const k = `${key(i + a)}>${key(i + b)}`; n.set(k, (n.get(k) || 0) + 1); }
  }
  const outE = [];
  for (const [k, c] of n) { const [p, q] = k.split('>'); if (c !== 1 || n.get(`${q}>${p}`) !== 1) outE.push(`${k} x${c}/${n.get(`${q}>${p}`) || 0}`); }
  return outE.length ? [`${outE.length} bad`, ...outE] : [];
}

const collapsed = (t, i) => (t[i] === t[i + 3] && t[i + 1] === t[i + 4] && t[i + 2] === t[i + 5]) || (t[i + 3] === t[i + 6] && t[i + 4] === t[i + 7] && t[i + 5] === t[i + 8]) || (t[i] === t[i + 6] && t[i + 1] === t[i + 7] && t[i + 2] === t[i + 8]);

/**
 * Whether a soup is a closed body: leaving out triangles with two corners the same (no area), every edge a -> b
 * (exact coordinates) is used once, and b -> a once. (Twice each way would be a doubled surface.)
 */
export function closedSoup(t) {
  const n = new Map(), key = i => `${t[i]},${t[i + 1]},${t[i + 2]}`;
  for (let i = 0; i < t.length; i += 9) {
    if (collapsed(t, i)) continue;
    for (const [a, b] of [[0, 3], [3, 6], [6, 0]]) { const k = `${key(i + a)}>${key(i + b)}`; n.set(k, (n.get(k) || 0) + 1); }
  }
  for (const [k, c] of n) { const [p, q] = k.split('>'); if (c !== 1 || n.get(`${q}>${p}`) !== 1) return false; }
  return true;
}
