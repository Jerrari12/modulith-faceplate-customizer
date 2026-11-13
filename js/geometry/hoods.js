// The series' integrated grips, rebuilt from the shipped models (measured 2026-11-07 from the viewer's GLB Library,
// Faceplate_ClassicPro_* and Faceplate_ClassicDecor_*, all 18 sizes): a hood along the plate's top edge that stands
// 23 mm proud. Seen from the side it is a 45-degree wedge 27 mm down the face; under it a finger pocket opens toward
// the bottom, closed at each end by a 2 mm wall; the ends lean in at 45 degrees, meeting the plate's sides at the
// face; a 2 x 2 mm slot along the bar takes an accent strip in a second colour. Classic Pro also carries a shallow
// panel recessed 1.75 mm into the middle of its slope, 46.4 mm long on every size.
//
// Built as one closed body: the outer section swept between the leaning ends, minus each notch (pocket, recess,
// slot) swept between its own ends, which sit strictly inside the outer ones. The outer faces a notch opens onto get
// a hole cut to match; the notch's own walls and ends close the cavity. Sections are in (e, v): e down the face from
// the flush edge, v out of it.

import * as P from './polys.js';
import { triangulate } from './extrude.js';

const SLOT = (s1 => { const r = Math.SQRT1_2 * 2; return [[s1, s1], [s1 + r, s1 + r], [s1 + 2 * r, s1], [s1 + r, s1 - r]]; })(19.47);
// each notch: its section, and the half-length of its ends at height v given the outer half-length A(v) and the
// grip's length L ('wall': 2.83 mm inside the leaning outer ends, i.e. 2 mm square to them)
export const HOODS = {
  classicpro: {
    label: 'Classic Pro', depth: 27, height: 23, wall: 2.83, overhang: 45,
    outer: [[0, 0], [27, 0], [27, 23], [23, 23]],
    notches: [
      { name: 'pocket', poly: [[5.66, 0], [27, 0], [27, 21.74], [26.72, 21.06]], ends: 'wall' },
      { name: 'recess', poly: [[0, 0], [2.48, 0], [18.46, 15.98], [17.22, 17.22]], ends: 'recess' },
      { name: 'slot', poly: SLOT, ends: 'slot', accent: true },
    ],
  },
  classic: {
    label: 'Classic', depth: 27, height: 23, wall: 2.83, overhang: 60,   // the bar's underside slopes at 30 degrees
    outer: [[0, 0], [27, 0], [27, 23], [23, 23]],
    notches: [
      { name: 'pocket', poly: [[2.83, 0], [27, 0], [27, 21], [19.5, 16.67]], ends: 'wall' },
      { name: 'slot', poly: SLOT, ends: 'slot', accent: true },
    ],
  },
};
export const HOOD_STYLES = Object.keys(HOODS);
/** The shortest hood that still closes: the ends lean in 23 mm each by the top and the pocket walls sit inside. */
export const HOOD_MIN_LENGTH = 56;

const ccw = poly => { let s = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; s += p[0] * q[1] - q[0] * p[1]; } return s >= 0 ? poly : poly.slice().reverse(); };

/** The vertical extent [lo, hi] of a convex polygon (u, v) at height v, or null. */
function rowAt(poly, v) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const a = Math.min(p[1], q[1]), b = Math.max(p[1], q[1]);
    if (v < a - 1e-9 || v > b + 1e-9) continue;
    if (b - a < 1e-12) { lo = Math.min(lo, p[0], q[0]); hi = Math.max(hi, p[0], q[0]); continue; }
    const u = p[0] + (q[0] - p[0]) * (Math.min(b, Math.max(a, v)) - p[1]) / (q[1] - p[1]);
    lo = Math.min(lo, u); hi = Math.max(hi, u);
  }
  return lo <= hi ? [lo, hi] : null;
}

/**
 * A hood grip of length L at the origin (x along it, y across: +y the flush edge, standing on z = 0):
 * { tris, accent: { tris, footprint } | null, footprint, base, top, height, overhang, bridge, occupies, pullU }.
 * `accentStrip` false leaves the bar solid (no slot).
 */
export function hoodShape(el, L) {
  const H = HOODS[el.style];
  const d = H.depth, h = H.height, w = H.wall;
  const A = v => L / 2 - v;                                          // the outer ends lean in at 45 degrees
  const toUV = ([e, v]) => [d / 2 - e, v];                           // +u toward the flush edge
  const outer = ccw(H.outer.map(toUV));
  const notches = H.notches.filter(n => !(n.accent && el.accentStrip === false)).map(n => {
    const B = n.ends === 'wall' ? (v => A(v) - w)
      : n.ends === 'recess' ? (() => Math.min(23.2, A(Math.max(...n.poly.map(p => p[1]))) - w))   // fixed 46.4 mm, inside short grips' walls
        : (() => L / 2 - 21.2);                                      // the slot: 21.2 mm in from each end
    return { ...n, poly: ccw(n.poly.map(toUV)), B };
  }).filter(n => n.B(0) > 1);

  const tris = [];
  const push = (a, b, c) => tris.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  const at = (x, [u, v]) => [x, u, v];
  // the outer ends, facing +x and -x
  for (let i = 1; i + 1 < outer.length; i++) {
    const a = outer[0], b = outer[i], c = outer[i + 1];
    push(at(A(a[1]), a), at(A(b[1]), b), at(A(c[1]), c));
    push(at(-A(a[1]), a), at(-A(c[1]), c), at(-A(b[1]), b));
  }
  // the outer sides: each edge swept between the ends, less the holes the notches open onto it
  const onEdge = (p, q, a, b) => {
    const dx = q[0] - p[0], dy = q[1] - p[1], len2 = dx * dx + dy * dy;
    const off = pt => Math.abs((pt[0] - p[0]) * dy - (pt[1] - p[1]) * dx) / Math.sqrt(len2);
    if (off(a) > 1e-6 || off(b) > 1e-6) return null;
    const s = pt => ((pt[0] - p[0]) * dx + (pt[1] - p[1]) * dy) / Math.sqrt(len2);
    return [s(a), s(b)];
  };
  for (let i = 0; i < outer.length; i++) {
    const p = outer[i], q = outer[(i + 1) % outer.length], len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const pt = s => [p[0] + (q[0] - p[0]) * s / len, p[1] + (q[1] - p[1]) * s / len];
    const ring = r => [[...r, r[0]]];
    let face = [ring([[0, -A(p[1])], [len, -A(q[1])], [len, A(q[1])], [0, A(p[1])]])];
    for (const n of notches) for (let j = 0; j < n.poly.length; j++) {
      const a = n.poly[j], b = n.poly[(j + 1) % n.poly.length], sp = onEdge(p, q, a, b);
      if (!sp) continue;
      const [s0, s1] = sp[0] < sp[1] ? sp : [sp[1], sp[0]];
      const B0 = n.B(pt(s0)[1]), B1 = n.B(pt(s1)[1]);
      face = P.difference(face, ring([[s0, -B0], [s1, -B1], [s1, B1], [s0, B0]]));
    }
    for (const poly of face) {
      const t = triangulate(poly, true);   // counter-clockwise in (s, x): outward for an outer side
      for (let k = 0; k < t.length; k += 3) push(...t.slice(k, k + 3).map(([s, x]) => at(x, pt(s))));
    }
  }
  // each notch: its ends (facing into the cavity) and the walls of its edges that are not open to the outside
  for (const n of notches) {
    const np = n.poly;
    for (let i = 1; i + 1 < np.length; i++) {
      const a = np[0], b = np[i], c = np[i + 1];
      push(at(n.B(a[1]), a), at(n.B(c[1]), c), at(n.B(b[1]), b));
      push(at(-n.B(a[1]), a), at(-n.B(b[1]), b), at(-n.B(c[1]), c));
    }
    for (let j = 0; j < np.length; j++) {
      const a = np[j], b = np[(j + 1) % np.length];
      if (outer.some((p, i) => onEdge(p, outer[(i + 1) % outer.length], a, b))) continue;
      const Pm = at(-n.B(a[1]), a), Pp = at(n.B(a[1]), a), Qm = at(-n.B(b[1]), b), Qp = at(n.B(b[1]), b);
      push(Pm, Qp, Qm); push(Pm, Pp, Qp);
    }
  }

  // the accent strip: the slot's section swept between the slot's ends, a closed body of its own
  const slot = notches.find(n => n.accent);
  let accent = null;
  if (slot) {
    const at2 = [], sp = slot.poly, B = slot.B(0);
    const add = (a, b, c) => at2.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let i = 1; i + 1 < sp.length; i++) { add(at(B, sp[0]), at(B, sp[i]), at(B, sp[i + 1])); add(at(-B, sp[0]), at(-B, sp[i + 1]), at(-B, sp[i])); }
    for (let j = 0; j < sp.length; j++) { const a = sp[j], b = sp[(j + 1) % sp.length]; add(at(-B, a), at(-B, b), at(B, b)); add(at(-B, a), at(B, b), at(B, a)); }
    const us = sp.map(p => p[0]);
    accent = { tris: at2, footprint: P.rect(-B, Math.min(...us), B, Math.max(...us)), z0: Math.min(...sp.map(p => p[1])), z1: Math.max(...sp.map(p => p[1])) };
  }

  // outlines: the footprint (the outer ends are widest at the face), what touches the face (less the pocket and the
  // recess), the flat front a block can stand on, and where it has material between two heights
  const A0 = A(0), footprint = P.rect(-A0, -d / 2, A0, d / 2);
  const holeAt = (n, z0, z1) => {
    const vs = [z0, z1, ...n.poly.map(p => p[1]).filter(v => v > z0 && v < z1)];
    let lo = -Infinity, hi = Infinity, half = Infinity;
    for (const v of vs) { const r = rowAt(n.poly, v); if (!r) return null; lo = Math.max(lo, r[0]); hi = Math.min(hi, r[1]); half = Math.min(half, n.B(v)); }
    return hi - lo > 1e-6 && half > 0 ? P.rect(-half, lo, half, hi) : null;
  };
  const less = (z0, z1) => { const holes = notches.map(n => holeAt(n, z0, z1)).filter(Boolean); return holes.length ? P.difference(footprint, ...holes) : footprint; };
  const base = less(0, 0);
  const frontU = outer.filter(p => Math.abs(p[1] - h) < 1e-9).map(p => p[0]);
  const top = P.rect(-A(h), Math.min(...frontU), A(h), Math.max(...frontU));
  // where it has material between two heights: the union of its slices at heights at most 0.2 mm apart (and at
  // every corner height). Each slice is worked out exactly as rectangles (the outer row less the notch rows, slab by
  // slab across x), and only then grown by the step, so the union reaches past the body by no more than the step
  const minus = (ivs, [a, b]) => ivs.flatMap(([c, e]) => (b <= c || a >= e ? [[c, e]] : [...(a > c ? [[c, a]] : []), ...(b < e ? [[b, e]] : [])]));
  const sliceRects = v => {
    const r = rowAt(outer, v);
    if (!r) return [];
    const ns = notches.map(m => ({ q: rowAt(m.poly, v), b: Math.min(m.B(v), A(v)) })).filter(o => o.q && o.b > 0);
    const xs = [...new Set([...ns.map(o => o.b), A(v)])].sort((a, b) => a - b), out = [];
    let x0 = 0;
    for (const x1 of xs) {
      if (x1 - x0 > 1e-9) {
        let ivs = [[r[0], r[1]]];
        for (const o of ns) if (o.b >= x1 - 1e-9) ivs = minus(ivs, o.q);
        for (const [a, b] of ivs) if (b - a > 1e-9) out.push([x0, x1, a, b]);
      }
      x0 = x1;
    }
    return out;
  };
  const occupies = (z0, z1) => {
    z0 = Math.max(0, z0); z1 = Math.min(h, z1);
    if (z1 <= 1e-9 || z1 < z0) return [];
    const n = Math.max(1, Math.ceil((z1 - z0) / 0.2)), step = (z1 - z0) / n, g = Math.max(step, 1e-3);
    const vs = [...Array.from({ length: n + 1 }, (_, i) => z0 + i * step), ...[outer, ...notches.map(m => m.poly)].flat().map(p => p[1]).filter(v => v > z0 && v < z1)];
    const parts = [];
    for (const v of vs) for (const [x0, x1, a, b] of sliceRects(v)) {
      parts.push(P.rect(x0 > 1e-9 ? x0 - g : -x1 - g, a - g, x1 + g, b + g));
      if (x0 > 1e-9) parts.push(P.rect(-x1 - g, a - g, -x0 + g, b + g));
    }
    return parts.length ? P.intersection(P.union(...parts), footprint) : [];
  };
  return { tris, accent, footprint, base, top, height: h, overhang: H.overhang, bridge: 0, occupies, pullU: -d / 2 };
}
