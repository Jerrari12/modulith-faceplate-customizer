// Grips: handles built into the face and printed face up with it, so every shape keeps to what prints without
// support: undercuts at 45 degrees or less, ends that lean in as they rise (never out), and bridges short enough
// to span. The language is the series' own handles: 45-degree chamfers, ends angled in plan, faceted lips.
//
// Every style but the arch is a convex cross-section across the grip in (u, v) - u across it (plate y when it is
// not turned), v out of the face - swept along its length x, between ends x = +/-X(u, v). X is the half-length,
// shortened toward one or both long sides by the end taper (angled or rounded in plan) and toward the top by the
// end lean. Because X never depends on anything but u and v, every face is planar (or a strip of planar quads on
// rounded ends) and the mesh is closed by construction. The arch pull is a bridge on two legs: its section is
// along the length, a 45-degree pointed arch under a top bar, swept across.
//
// Each shape also says where it has material at each height (occupies), so relief under an undercut or an arch
// keeps going under it instead of being cut away to the footprint.

import { extrudeMultiPolygon } from './extrude.js';
import { hoodShape, HOODS, HOOD_STYLES, HOOD_MIN_LENGTH } from './hoods.js';
import { cornerHood } from './cornerhood.js';

export { HOOD_STYLES };

export const GRIP_ENDS = [['square', 'Square'], ['angled', 'Angled'], ['round', 'Rounded']];

/** A new lip pull from the library: on the top edge, about the size of the drawer pulls it is after. */
export const LIP_PRESET = { name: 'Lip pull', style: 'lip', length: 70, depth: 16, height: 10, undercut: 6.5, lipEdge: 3, chamfer: 1, ends: 'angled', endTaper: 8, lean: 0, flush: 't' };

/** Sizes a style starts from when a grip switches to it and its current sizes would not suit it. */
export function styleStart(el, style) {
  // the series' grips sit where they ship: the Classics full width along the top edge, EdgeLabel in its corner
  if (HOODS[style]) return { fullWidth: true, flush: 't' };
  if (style === 'edgelabel') return { flush: '', corner: el.corner === 'left' ? 'left' : 'right' };
  if (style === 'arch' && !(Number(el.height) >= 16)) return { length: 56, depth: 10, height: 24, legs: 6, bar: 4, chamfer: 2 };
  if (style === 'lip' && !(Number(el.depth) >= 10)) return { length: 70, depth: 16, height: 10, undercut: 6.5, lipEdge: 3, chamfer: 1, ends: 'angled', endTaper: 8 };
  return {};
}

/**
 * How strong a grip is where it meets the face. Printed face up, every layer lies parallel to the face, so pulling
 * a drawer by its grip pulls those layers apart, and the weakest place is the grip's base: a narrow base with the
 * pull out at an undercut's edge bends open like a hinge. The estimate: a firm pull of `pullN` (about 10 kg)
 * straight out of the face at the edge your fingers hook (the middle for a pull you pinch), as tension plus
 * bending on the base's cross-section. Printed PLA parts between layers at roughly 15 to 30 MPa: over `warnMPa` is
 * thin, over `failMPa` it may snap off.
 */
export const GRIP_STRENGTH = { pullN: 100, warnMPa: 5, failMPa: 10, sturdyMPa: 4 };

function baseStrength(base, pullUs) {
  let A = 0, S = 0, I = 0, yMin = Infinity, yMax = -Infinity;
  for (const poly of base || []) {
    const r = poly[0];
    for (let i = 0; i + 1 < r.length; i++) {
      const [x0, y0] = r[i], [x1, y1] = r[i + 1], cr = x0 * y1 - x1 * y0;
      A += cr / 2; S += (y0 + y1) * cr / 6; I += (y0 * y0 + y0 * y1 + y1 * y1) * cr / 12;
      yMin = Math.min(yMin, y0); yMax = Math.max(yMax, y0);
    }
  }
  if (!(A > 1e-9)) return { area: 0, width: 0, sigma: Infinity };
  const yc = S / A, Ic = Math.max(1e-9, I - A * yc * yc), F = GRIP_STRENGTH.pullN;
  let sigma = F / A;
  for (const u of pullUs) { const e = Math.abs(u - yc), c = u < yc ? yc - yMin : yMax - yc; sigma = Math.max(sigma, F / A + F * e * c / Ic); }
  return { area: A, width: yMax - yMin, sigma };
}

/**
 * The arch pull's strength. A pull on the bar runs down the 45-degree flanks into each leg's root along a line
 * through the root's inner edge: half the pull outward (tension across the layers), offset half a leg from the
 * root's middle (bending it open), and half the pull inward along the face (shear across the layers), combined as
 * sqrt(s^2 + 3 t^2). The bar over a flat bridge also bends, but along its layers, where printed PLA is about three
 * times as strong, so its stress counts at a third. `width` is one leg's.
 */
function archStrength(leg, d, b, barT) {
  const F = GRIP_STRENGTH.pullN, A = leg * d, I = d * leg ** 3 / 12;
  const s = (F / 2) / A + (F / 2) * (leg / 2) * (leg / 2) / I, t = (F / 2) / A;
  const root = Math.sqrt(s * s + 3 * t * t);
  const bar = b > 0 ? (6 * (F * 2 * b / 4) / (d * barT * barT)) / 3 : 0;
  return { area: 2 * A, width: leg, sigma: Math.max(root, bar) };
}

/**
 * The same estimate for a base that is not symmetric across the pull (the EdgeLabel hood stands on an L): the pull at
 * a point in plan loads the base with tension plus bending about both axes, sigma(q) = F/A + F (p - c)' J^-1 (q - c),
 * J the base's second moments about its centroid c; the worst corner counts.
 */
function baseStrength2D(base, pull) {
  let A = 0, Sx = 0, Sy = 0, Ixx = 0, Iyy = 0, Ixy = 0, xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  const pts = [];
  for (const poly of base || []) for (const r of poly) for (let i = 0; i + 1 < r.length; i++) {
    const [x0, y0] = r[i], [x1, y1] = r[i + 1], cr = x0 * y1 - x1 * y0;
    A += cr / 2; Sx += (x0 + x1) * cr / 6; Sy += (y0 + y1) * cr / 6;
    Ixx += (y0 * y0 + y0 * y1 + y1 * y1) * cr / 12; Iyy += (x0 * x0 + x0 * x1 + x1 * x1) * cr / 12; Ixy += (x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * cr / 24;
    pts.push([x0, y0]); xMin = Math.min(xMin, x0); xMax = Math.max(xMax, x0); yMin = Math.min(yMin, y0); yMax = Math.max(yMax, y0);
  }
  if (!(A > 1e-9)) return { area: 0, width: 0, sigma: Infinity };
  const cx = Sx / A, cy = Sy / A, Jxx = Iyy - A * cx * cx, Jyy = Ixx - A * cy * cy, Jxy = Ixy - A * cx * cy, det = Jxx * Jyy - Jxy * Jxy;
  const F = GRIP_STRENGTH.pullN, ex = pull[0] - cx, ey = pull[1] - cy;
  const kx = (Jyy * ex - Jxy * ey) / det, ky = (Jxx * ey - Jxy * ex) / det;   // J^-1 (p - c)
  let sigma = F / A;
  for (const [x, y] of pts) sigma = Math.max(sigma, F / A + F * (kx * (x - cx) + ky * (y - cy)));
  // the narrowest the base is: its area over its longest run, a fair stand-in for 'width' on an L
  return { area: A, width: A / Math.max(xMax - xMin, yMax - yMin), sigma };
}

/**
 * The smallest change that makes a weak grip sturdy (stress at or under sturdyMPa): a smaller undercut first (it
 * keeps the look), then more depth; an arch gets wider legs. {} when it is already sturdy or nothing helps.
 */
export function sturdier(el) {
  if (HOODS[el.style] || el.style === 'edgelabel') return {};   // the series' own shape: nothing to tune
  const ok = o => gripShape(o).strength.sigma <= GRIP_STRENGTH.sturdyMPa;
  if (ok(el)) return {};
  if (el.style === 'arch') {
    for (let legs = Math.ceil((Number(el.legs) || 6) * 4) / 4; legs <= (Number(el.length) || 56) / 2 - 3; legs += 0.25) if (ok({ ...el, legs })) return { legs };
    return {};
  }
  const uc0 = Math.max(0, Number(el.undercut) || 0);
  if (['wedge', 'ledge', 'lip'].includes(el.style) && uc0 > 0 && ok({ ...el, undercut: 0 })) {
    let lo = 0, hi = uc0;   // the largest undercut that is still sturdy, to a quarter millimetre
    for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (ok({ ...el, undercut: mid })) lo = mid; else hi = mid; }
    return { undercut: Math.floor(lo * 4) / 4 };
  }
  for (let depth = Math.ceil((Number(el.depth) || 8) * 4) / 4; depth <= 40; depth += 0.25) if (ok({ ...el, depth })) return { depth };
  return {};
}

const fin = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const EPS = 1e-9;

/** A convex polygon (counter-clockwise, open ring) clipped to a*u + b*v <= k. */
function clipHalf(poly, a, b, k) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const fp = a * p[0] + b * p[1] - k, fq = a * q[0] + b * q[1] - k;
    if (fp <= EPS) out.push(p);
    if ((fp < -EPS && fq > EPS) || (fp > EPS && fq < -EPS)) { const s = fp / (fp - fq); out.push([p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s]); }
  }
  return out.filter((p, i) => { const q = out[(i + out.length - 1) % out.length]; return Math.abs(p[0] - q[0]) > EPS || Math.abs(p[1] - q[1]) > EPS; });
}
const ccw = poly => { let s = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; s += p[0] * q[1] - q[0] * p[1]; } return s >= 0 ? poly : poly.slice().reverse(); };

/**
 * A profile style's cross-section: { poly (convex, CCW, in (u, v)), taper ('both' | 'neg' | 'pos': which long
 * side the ends come in toward), overhang (degrees from vertical of its undercut) }.
 */
function section(el, d, h) {
  let poly, taper = 'both', overhang = 0, chamferSides = ['neg', 'pos'];
  switch (el.style) {
    case 'wedge': {
      const uc = clamp(fin(el.undercut, 3), 0, d / 2 - 0.5);
      poly = [[-d / 2 + uc, 0], [d / 2 - uc, 0], [d / 2, h], [-d / 2, h]];
      overhang = uc > 0 ? Math.atan2(uc, h) * 180 / Math.PI : 0;
      break;
    }
    case 'ledge': {
      const uc = clamp(fin(el.undercut, 3), 0, d - 0.5);
      poly = [[-d / 2, 0], [d / 2 - uc, 0], [d / 2, h], [-d / 2, h]];
      if (el.flip) poly = poly.map(([u, v]) => [-u, v]).reverse();
      taper = el.flip ? 'neg' : 'pos';
      overhang = uc > 0 ? Math.atan2(uc, h) * 180 / Math.PI : 0;
      break;
    }
    case 'dome': {
      poly = [];
      for (let i = 0; i <= 20; i++) { const a = (i / 20) * Math.PI; poly.push([(d / 2) * Math.cos(a), h * Math.sin(a)]); }
      // a half-ellipse: the overhang angle grows toward the top; report the slope at 80 % height
      overhang = Math.max(0, Math.min(89, Math.atan2((d / 2) * 0.6, h * 0.2) * 180 / Math.PI - 45));
      chamferSides = [];
      break;
    }
    case 'lip': {
      // the flush side straight up at +u, the outer face at h, the lip's edge down to h - lipEdge at -u, then the
      // undercut back to the face; an undercut under 0.01 mm is none (it would only be a sliver level)
      const tl = Math.min(Math.max(0.4, fin(el.lipEdge, 3)), h - 0.4);
      const ucIn = clamp(fin(el.undercut, 6.5), 0, d - 1), uc = ucIn < 0.01 ? 0 : ucIn;
      poly = uc === 0 ? [[-d / 2, 0], [d / 2, 0], [d / 2, h], [-d / 2, h]] : [[d / 2 - (d - uc), 0], [d / 2, 0], [d / 2, h], [-d / 2, h], [-d / 2, h - tl]];
      taper = 'neg'; chamferSides = ['neg'];
      overhang = uc > 0 ? Math.atan2(uc, h - tl) * 180 / Math.PI : 0;
      break;
    }
    default:
      poly = [[-d / 2, 0], [d / 2, 0], [d / 2, h], [-d / 2, h]];
  }
  poly = ccw(poly);
  // chamfered top edges: the corner at each end of the top cut back `c` along the top, at 45 degrees
  const top = poly.filter(([, v]) => Math.abs(v - h) < 1e-9).map(([u]) => u);
  if (top.length && chamferSides.length) {
    const uL = Math.min(...top), uR = Math.max(...top);
    let c = clamp(fin(el.chamfer, 0.5), 0, Math.min((uR - uL) / 2 - 0.2, h - 0.2));
    if (el.style === 'lip') c = Math.min(c, Math.min(Math.max(0.4, fin(el.lipEdge, 3)), h - 0.4) - 0.2);
    if (c > 1e-6) {
      if (chamferSides.includes('pos')) poly = clipHalf(poly, 1, 1, uR + h - c);
      if (chamferSides.includes('neg')) poly = clipHalf(poly, -1, 1, -uL + h - c);
    }
  }
  return { poly, taper, overhang };
}

/** The vertical extent [lo, hi] of a convex polygon at u. */
function sliceAt(poly, u) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const a = Math.min(p[0], q[0]), b = Math.max(p[0], q[0]);
    if (u < a - 1e-9 || u > b + 1e-9) continue;
    if (b - a < 1e-12) { lo = Math.min(lo, p[1], q[1]); hi = Math.max(hi, p[1], q[1]); continue; }
    const v = p[1] + (q[1] - p[1]) * (clamp(u, a, b) - p[0]) / (q[0] - p[0]);
    lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  return [lo, hi];
}

const closeRing = ring => [...ring, ring[0]];

/**
 * A profile grip (bar, wedge, ledge, dome, lip) at the origin, its length along x, standing on z = 0:
 * { tris, footprint, base, top, height, overhang, bridge: 0, occupies(z0, z1) } with outlines as MultiPolygons in
 * the plate plane (y = u). `occupies` is where it has material between heights z0 and z1 above its bottom.
 */
export function gripShape(el = {}, { plateW } = {}) {
  // full width: as long as the plate on every size (needs the plate's width; without it, the set length)
  const fullLen = el.fullWidth && plateW > 0 ? plateW : null;
  if (el.style === 'edgelabel') {
    const g = cornerHood();
    return { ...g, strength: baseStrength2D(g.base, g.pull), corner: true };
  }
  if (HOODS[el.style]) {
    // at least 56 mm: the ends lean in 23 mm each by the top, and the pocket's walls need room inside them
    const g = hoodShape(el, Math.max(HOOD_MIN_LENGTH, fullLen ?? fin(el.length, 87)));
    return { ...g, strength: baseStrength(g.base, [g.pullU]) };
  }
  if (el.style === 'arch') return archShape(fullLen ? { ...el, length: fullLen } : el);
  const L = fullLen ?? Math.max(4, fin(el.length, 50)), d = Math.max(1, fin(el.depth, 8)), h = Math.max(0.5, fin(el.height, 6));
  const { poly, taper, overhang } = section(el, d, h);
  const uMin = Math.min(...poly.map(p => p[0])), uMax = Math.max(...poly.map(p => p[0])), span = uMax - uMin, mid = (uMin + uMax) / 2;
  const ends = el.ends === 'angled' || el.ends === 'round' ? el.ends : 'square';
  const e = ends === 'square' ? 0 : clamp(fin(el.endTaper, 8), 0, L / 2 - 1);
  // end lean: the ends come in by tan(lean) per mm of height, never so far that the top runs out of length
  const leanMax = Math.atan(Math.max(0, L / 2 - e - 0.5) / h) * 180 / Math.PI;
  const lean = Math.tan(clamp(fin(el.lean, 0), 0, Math.min(45, leanMax)) * Math.PI / 180);
  const s = u => clamp(taper === 'both' ? Math.abs(u - mid) / (span / 2) : taper === 'neg' ? (uMax - u) / span : (u - uMin) / span, 0, 1);
  const X = (u, v) => L / 2 - (ends === 'round' ? e * (1 - Math.sqrt(Math.max(0, 1 - s(u) ** 2))) : e * s(u)) - lean * v;

  // levels across: every corner of the section, the middle when both sides taper, fine steps on rounded ends
  const corners = [...poly.map(p => p[0]), ...(taper === 'both' && e > 0 ? [mid] : [])];
  const us = [];
  for (const u of corners.sort((a, b) => a - b)) if (!us.length || u - us[us.length - 1] > 1e-6) us.push(u);
  if (ends === 'round' && e > 0) {
    for (let i = 1; i < 24; i++) { const u = uMin + (span * i) / 24; if (us.every(c => Math.abs(u - c) > 1e-6)) us.push(u); }
    us.sort((a, b) => a - b);
  }
  const lo = [], hi = [];
  for (const u of us) { const [a, b] = sliceAt(poly, u); lo.push(a); hi.push(b); }
  const m = us.length - 1;

  const tris = [];
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9 && Math.abs(a[2] - b[2]) < 1e-9;
  const tri = (a, b, c) => { if (same(a, b) || same(b, c) || same(c, a)) return; tris.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); };
  const Pt = (k, side, top) => { const v = top ? hi[k] : lo[k]; return [side * X(us[k], v), us[k], v]; };
  for (let k = 0; k < m; k++) {
    tri(Pt(k, 1, false), Pt(k + 1, 1, false), Pt(k + 1, 1, true)); tri(Pt(k, 1, false), Pt(k + 1, 1, true), Pt(k, 1, true));
    tri(Pt(k, -1, false), Pt(k + 1, -1, true), Pt(k + 1, -1, false)); tri(Pt(k, -1, false), Pt(k, -1, true), Pt(k + 1, -1, true));
  }
  const ring = [];
  for (let k = 0; k <= m; k++) ring.push([k, false]);
  for (let k = m; k >= 0; k--) ring.push([k, true]);
  for (let i = 0; i < ring.length; i++) {
    const [kp, tp] = ring[i], [kq, tq] = ring[(i + 1) % ring.length];
    const pp = Pt(kp, 1, tp), qp = Pt(kq, 1, tq);
    if (same(pp, qp)) continue;
    const pm = Pt(kp, -1, tp), qm = Pt(kq, -1, tq);
    tri(pm, qm, qp); tri(pm, qp, pp);
  }

  // outlines in the plate plane (counter-clockwise: down the left end, up the right) over levels a..b, the ends
  // at height vAt(u) (the widest the body is there, since the ends lean in going up)
  const lerp = (arr, u) => { for (let k = 0; k < m; k++) if (u <= us[k + 1] + 1e-12) { const f = (u - us[k]) / ((us[k + 1] - us[k]) || 1); return arr[k] + (arr[k + 1] - arr[k]) * f; } return arr[m]; };
  // the ends as the mesh has them: the taper sampled at the levels and straight between (on rounded ends the curve
  // between two levels bulges past the chord the mesh draws, and an outline must not reach past the body)
  const Xt = us.map(u => X(u, 0));
  const Xm = (u, v) => lerp(Xt, u) - lean * v;
  const outline = (uset, vAt) => {
    const pts = [];
    for (const u of uset.slice().sort((a, b) => a - b)) if (!pts.length || u - pts[pts.length - 1] > 1e-9) pts.push(u);
    if (pts.length < 2 || pts[pts.length - 1] - pts[0] < 1e-9) return [];
    return [[closeRing([...pts.slice().reverse().map(u => [-Xm(u, vAt(u)), u]), ...pts.map(u => [Xm(u, vAt(u)), u])])]];
  };
  const loAt = u => lerp(lo, u);
  const footprint = outline(us, loAt);
  const flatBase = us.filter((u, k) => lo[k] < 1e-9);
  const base = flatBase.length >= 2 ? outline(flatBase, () => 0) : footprint;
  const flatTop = us.filter((u, k) => hi[k] > h - 1e-9);
  const top = el.style === 'dome' || flatTop.length < 2 ? null : outline(flatTop, () => h);

  // where it has material between heights z0 and z1: across, the levels whose underside is below z1 (an interval:
  // the underside of a convex section is convex), each end at its widest height in the range
  const occupies = (z0, z1) => {
    if (z1 <= 1e-9) return [];
    const inside = (u) => loAt(u) < z1 - 1e-9;
    const cut = [];
    for (let k = 0; k < m; k++) {
      const a = lo[k] - z1, b = lo[k + 1] - z1;
      if ((a < 0) !== (b < 0) && Math.abs(a - b) > 1e-12) cut.push(us[k] + (us[k + 1] - us[k]) * (a / (a - b)));
      const c0 = lo[k] - z0, c1 = lo[k + 1] - z0;
      if ((c0 < 0) !== (c1 < 0) && Math.abs(c0 - c1) > 1e-12) cut.push(us[k] + (us[k + 1] - us[k]) * (c0 / (c0 - c1)));
    }
    const uset = [...us.filter(inside), ...cut.filter(u => loAt(u) <= z1 + 1e-9)];
    return outline(uset, u => Math.max(loAt(u), z0));
  };
  // where fingers pull: the edge of each undercut (a wedge either side), the middle of a pull you pinch
  const pullUs = overhang <= 0 || el.style === 'dome' ? [] : el.style === 'wedge' ? [uMin, uMax] : el.style === 'lip' ? [uMin] : el.style === 'ledge' ? [el.flip ? uMin : uMax] : [];
  return { tris, footprint, base, top, height: h, overhang, bridge: 0, occupies, strength: baseStrength(base, pullUs) };
}

/**
 * The arch pull: a bar on two legs over a 45-degree pointed arch (a short flat bridge where the arch is wide), so it
 * prints face up with no support. Along the length x: legs `legs` wide, the bar `bar` thick on top, its top end
 * corners chamfered `chamfer`; across, `depth` deep. bridge is the flat span under the bar (0 for a pointed arch).
 */
function archShape(el) {
  const L = Math.max(12, fin(el.length, 56)), d = Math.max(2, fin(el.depth, 10)), h = Math.max(6, fin(el.height, 24));
  const leg = clamp(fin(el.legs, 6), 2, L / 2 - 3), bar = clamp(fin(el.bar, 4), 1.5, h - 2);
  const a = L / 2 - leg, b = Math.max(0, a - (h - bar)), oh = a - b;       // half opening at the face, half bridge, opening height
  const c = clamp(fin(el.chamfer, 2), 0, Math.min(leg, bar) - 0.2);
  const ring = [[-L / 2, 0], [-a, 0], [-b, oh], ...(b > 1e-9 ? [[b, oh]] : []), [a, 0], [L / 2, 0], [L / 2, h - c], [L / 2 - c, h], [-L / 2 + c, h], [-L / 2, h - c]]
    .filter((p, i, r) => { const q = r[(i + r.length - 1) % r.length]; return Math.abs(p[0] - q[0]) > 1e-9 || Math.abs(p[1] - q[1]) > 1e-9; });
  // the section (x, v) swept across u by the extruder (caps by earcut, walls along the outline), then turned so v is
  // up: (x, v, u) -> (x, u, v) swaps two axes, a reflection, so each triangle's winding is flipped back
  const raw = extrudeMultiPolygon([[closeRing(ring)]], -d / 2, d / 2), tris = [];
  for (let i = 0; i < raw.length; i += 9) tris.push(raw[i], raw[i + 2], raw[i + 1], raw[i + 6], raw[i + 8], raw[i + 7], raw[i + 3], raw[i + 5], raw[i + 4]);
  const rect = (x0, y0, x1, y1) => [[[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]];
  const footprint = rect(-L / 2, -d / 2, L / 2, d / 2);
  const occupies = (z0, z1) => {
    if (z1 <= 1e-9) return [];
    if (z1 > oh + 1e-9) return footprint;
    const x = a - z1;   // the arch's flanks: below z1 wherever a - |x| < z1
    return [...rect(-L / 2, -d / 2, -x, d / 2), ...rect(x, -d / 2, L / 2, d / 2)];
  };
  return {
    tris, footprint, base: [...rect(-L / 2, -d / 2, -a, d / 2), ...rect(a, -d / 2, L / 2, d / 2)], top: rect(-L / 2 + c, -d / 2, L / 2 - c, d / 2),
    height: h, overhang: 45, bridge: 2 * b, occupies,
    strength: archStrength(leg, d, b, h - oh),
  };
}
