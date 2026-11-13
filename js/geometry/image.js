// Pictures on the face: a photo or a logo becomes a few TONES, each a flat region, raised in steps, cut in steps or
// inlaid in its own filament. Everything stays 2.5D: tone k is the part of the picture at least as dark as its
// threshold, so the tones nest (tone k lies inside tone k - 1) and a stepped relief is always supported.
//
// The picture is kept in the design as a small greyscale grid (at most 256 px on its long side, one byte a pixel,
// base64), so a design file carries it and reopens without the original. Outlines are iso-contours of that grid
// (marching squares with linear interpolation, so edges are smooth, not pixel stairs). Bands of a tone too thin to
// print are merged into a neighbouring tone before contouring; specks, pin holes and crumbs smaller than the
// element's "smallest piece" go after; rings nest into polygons with holes by containment (contours at one threshold
// never cross). Only exactly collinear points are dropped, so tones that share an outline share its points.

import * as P from './polys.js';
import { distanceTransform } from '../checks/raster.js';

export const IMAGE_LIMITS = { maxSide: 256, maxSteps: 6, minWidth: 0.1, maxWidth: 400, maxSmooth: 3, maxPiece: 10 };

// ---- the stored picture
export function bytesToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64ToBytes(b64) {
  const s = atob(b64), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

/**
 * RGBA pixels (from a canvas) to the stored greyscale: composited over white (a transparent background is paper),
 * luminance, then stretched so the 1st and 99th percentiles become black and white (a grey photo still finds its
 * tones). Returns { w, h, g } with g the base64 bytes, 0 black to 255 white.
 */
export function imageFromRGBA(rgba, w, h) {
  const n = w * h, lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = rgba[4 * i + 3] / 255;
    const r = rgba[4 * i] * a + 255 * (1 - a), g = rgba[4 * i + 1] * a + 255 * (1 - a), b = rgba[4 * i + 2] * a + 255 * (1 - a);
    lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const sorted = Float32Array.from(lum).sort();
  const lo = sorted[Math.floor(0.01 * (n - 1))], hi = sorted[Math.ceil(0.99 * (n - 1))];
  const span = hi - lo;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = span > 8 ? Math.round(Math.min(255, Math.max(0, (lum[i] - lo) * 255 / span))) : Math.round(lum[i]);
  return { w, h, g: bytesToB64(out) };
}

/** A stored picture checked: whole numbers in range and exactly w x h bytes. Returns a clean copy or null. */
export function cleanImageData(d) {
  if (!d || typeof d !== 'object' || typeof d.g !== 'string') return null;
  const w = Math.trunc(Number(d.w)), h = Math.trunc(Number(d.h));
  if (!(w >= 1 && h >= 1 && w <= IMAGE_LIMITS.maxSide && h <= IMAGE_LIMITS.maxSide)) return null;
  if (d.g.length > 4 * Math.ceil((w * h) / 3) + 4) return null;
  let bytes;
  try { bytes = b64ToBytes(d.g); } catch { return null; }
  return bytes.length === w * h ? { w, h, g: d.g } : null;
}

// ---- tones
/**
 * Gaussian blur of standard deviation sigma pixels, separable, edges clamped. Sub-pixel sigmas work (a box blur
 * rounded to whole pixels made "0.3 mm" a 1.4 mm smear at 0.27 mm a pixel, washing thin strokes out of their tone).
 */
function blur(src, w, h, sigma) {
  if (!(sigma >= 0.3)) return src;
  const r = Math.ceil(3 * sigma), k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    let v = 0;
    for (let d = -r; d <= r; d++) v += k[d + r] * src[j * w + Math.min(w - 1, Math.max(0, i + d))];
    tmp[j * w + i] = v;
  }
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    let v = 0;
    for (let d = -r; d <= r; d++) v += k[d + r] * tmp[Math.min(h - 1, Math.max(0, j + d)) * w + i];
    out[j * w + i] = v;
  }
  return out;
}

/**
 * Iso-contours of `f` (w x h, row 0 at the top) at level T: closed rings in pixel units around the cells where
 * f >= T. The grid is padded with a border below T, so every contour closes. Each cell's edges that the level
 * crosses get one interpolated point, keyed by the edge; the cell joins them in pairs (a saddle is split by its
 * centre value), and the pairs chain into rings.
 */
export function isoRings(f, w, h, T, lvl = null) {
  const W = w + 2, H = h + 2;
  // the border: below T beside a pixel that is not in, and mirrored about T beside one that is, so the contour
  // crosses exactly halfway, on the picture's own edge, whatever the level (every tone shares that edge)
  const v = (i, j) => {
    if (i >= 1 && j >= 1 && i <= w && j <= h) return f[(j - 1) * w + (i - 1)];
    const fe = f[(Math.min(h, Math.max(1, j)) - 1) * w + (Math.min(w, Math.max(1, i)) - 1)];
    return fe > T ? 2 * T - fe : -1;
  };
  const pts = new Map(), links = new Map();
  // where an edge jumps across more than one tone (a hard edge in the picture), every tone's contour crosses it at
  // its midpoint, so the tones meet there instead of leaving thin bands of the tones in between
  const point = (key, x0, y0, x1, y1, a, b) => {
    if (!pts.has(key)) {
      const t = lvl && Math.abs(lvl(a) - lvl(b)) > 1 ? 0.5 : (T - a) / (b - a);
      pts.set(key, [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
    }
    return key;
  };
  const link = (p, q) => { (links.get(p) || links.set(p, []).get(p)).push(q); (links.get(q) || links.set(q, []).get(q)).push(p); };
  for (let j = 0; j < H - 1; j++) for (let i = 0; i < W - 1; i++) {
    const a = v(i, j), b = v(i + 1, j), c = v(i + 1, j + 1), d = v(i, j + 1);   // tl, tr, br, bl
    const idx = (a >= T ? 1 : 0) | (b >= T ? 2 : 0) | (c >= T ? 4 : 0) | (d >= T ? 8 : 0);
    if (idx === 0 || idx === 15) continue;
    const top = () => point(`h${i},${j}`, i, j, i + 1, j, a, b);
    const right = () => point(`v${i + 1},${j}`, i + 1, j, i + 1, j + 1, b, c);
    const bottom = () => point(`h${i},${j + 1}`, i, j + 1, i + 1, j + 1, d, c);
    const left = () => point(`v${i},${j}`, i, j, i, j + 1, a, d);
    switch (idx) {
      case 1: case 14: link(left(), top()); break;
      case 2: case 13: link(top(), right()); break;
      case 3: case 12: link(left(), right()); break;
      case 4: case 11: link(right(), bottom()); break;
      case 6: case 9: link(top(), bottom()); break;
      case 7: case 8: link(left(), bottom()); break;
      case 5: case 10: {
        // a saddle: the centre decides whether the two high corners join (one band) or stay apart (two corners)
        const joined = (a + b + c + d) / 4 >= T;
        if ((idx === 5) === joined) { link(left(), bottom()); link(top(), right()); }
        else { link(left(), top()); link(right(), bottom()); }
        break;
      }
    }
  }
  const rings = [], used = new Set();
  for (const start of links.keys()) {
    if (used.has(start)) continue;
    const ring = [];
    let prev = null, cur = start;
    while (cur != null && !used.has(cur)) {
      used.add(cur); ring.push(pts.get(cur));
      const next = links.get(cur).find(k => k !== prev && !used.has(k));
      prev = cur; cur = next;
    }
    if (ring.length >= 3) { ring.push([ring[0][0], ring[0][1]]); rings.push(ring); }
  }
  return rings;
}

/**
 * Drop the points that lie exactly on the line through their neighbours (runs along a hard edge). Nothing else is
 * simplified: two tones that share a stretch of outline share its points, so they meet with no sliver between them,
 * which an approximating simplifier would not guarantee.
 */
function collinear(ring) {
  const pts = ring.slice(0, -1), out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
    if (Math.abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) > 1e-12) out.push(b);
  }
  if (out.length < 3) return ring;
  out.push([out[0][0], out[0][1]]);
  return out;
}

/**
 * Bands of one tone thinner than about 2 x rho pixels (the halo an anti-aliased or softened hard edge leaves between
 * paper and ink) are given to the next darker tone when they touch it, and to the paler one otherwise. Works on the
 * per-pixel tone map L (0 = background .. n), palest band first, so a halo of several tones runs up into the ink. A
 * band's thin part is what an opening by a disc of radius rho + 1/2 removes: a pixel at distance d from the band's
 * edge sits in a band about 2d - 1 pixels wide, so a band narrower than 2 rho has no pixel that deep.
 */
function mergeThinBands(L, w, h, n, rho) {
  const R = rho + 0.5, pad = Math.ceil(R) + 2, W = w + 2 * pad, H = h + 2 * pad, N = W * H;
  const at = p => (Math.floor(p / w) + pad) * W + (p % w) + pad;
  const band = new Uint8Array(N), away = new Uint8Array(N), paler = new Uint8Array(N);
  for (let k = 1; k <= n; k++) {
    band.fill(0);
    let any = false;
    for (let p = 0; p < w * h; p++) if (L[p] === k) { band[at(p)] = 1; any = true; }
    if (!any) continue;
    const dt = distanceTransform(band, W, H);
    for (let q = 0; q < N; q++) away[q] = band[q] && dt[q] >= R ? 0 : 1;
    const dc = distanceTransform(away, W, H);
    const thin = [];
    for (let p = 0; p < w * h; p++) { const q = at(p); if (band[q] && dc[q] > R) thin.push(p); }
    if (!thin.length) continue;
    paler.fill(1);                                   // the padding is background: never "darker"
    for (let p = 0; p < w * h; p++) if (L[p] > k) paler[at(p)] = 0;
    const toDarker = k < n ? distanceTransform(paler, W, H) : null;
    for (const p of thin) L[p] = toDarker && toDarker[at(p)] <= R + 1 ? k + 1 : k - 1;
  }
}

const bboxOf = r => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of r) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { x0, y0, x1, y1 }; };
function inside(ring, x, y) {
  let c = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/**
 * Non-crossing rings to a MultiPolygon: a ring's parent is the smallest ring around it, its depth the number of
 * rings around it; even depths are outlines and odd depths their holes. Rings under minArea are dropped first (a
 * speck goes, a pin hole fills).
 */
export function nestRings(rings, minArea = 0) {
  const rs = rings.map(r => ({ r, a: Math.abs(P.ringArea(r)), b: bboxOf(r) })).filter(x => x.a >= minArea && x.a > 0);
  rs.sort((p, q) => q.a - p.a);   // a ring can only lie inside a bigger one
  for (let i = 0; i < rs.length; i++) {
    const me = rs[i], [x, y] = me.r[0];
    me.parent = -1;
    for (let k = i - 1; k >= 0; k--) {       // the smallest bigger ring that holds it
      const o = rs[k];
      if (x < o.b.x0 || x > o.b.x1 || y < o.b.y0 || y > o.b.y1) continue;
      if (inside(o.r, x, y)) { me.parent = k; break; }
    }
    me.depth = me.parent < 0 ? 0 : rs[me.parent].depth + 1;
  }
  const polys = new Map();
  rs.forEach((x, i) => { if (x.depth % 2 === 0) polys.set(i, [x.r]); });
  rs.forEach(x => { if (x.depth % 2 === 1 && polys.has(x.parent)) polys.get(x.parent).push(x.r); });
  return [...polys.values()];
}

const perimeter = poly => poly.reduce((s, r) => { for (let i = 0; i + 1 < r.length; i++) s += Math.hypot(r[i + 1][0] - r[i][0], r[i + 1][1] - r[i][1]); return s; }, 0);

/**
 * What each tone shows on its own is its BAND: the tone minus the next darker one. A band piece smaller than
 * minArea, or thinner than minThick on average (twice its area over its perimeter), cannot print as a piece of its
 * own: it joins the next darker tone (the darkest tone's own crumbs go). These are what the raster merge cannot see:
 * corners where tone outlines meet the picture's edge, and hairline slivers where two outlines run side by side
 * through a pixel cell that each level splits differently. Darker tones stay inside paler ones throughout.
 */
function cleanBands(tones, minArea, minThick) {
  for (let k = 0; k < tones.length; k++) {
    const darker = tones[k + 1];
    const band = darker && darker.length ? P.difference(tones[k], darker) : tones[k];
    const crumbs = band.filter(poly => { const a = P.area([poly]); return a < minArea || 2 * a / perimeter(poly) < minThick; });
    if (!crumbs.length) continue;
    if (darker) tones[k + 1] = P.union(darker, crumbs);
    else tones[k] = P.difference(tones[k], crumbs);
  }
}

const decoded = new WeakMap();
function grey(data) {
  let g = decoded.get(data);
  if (!g) { g = b64ToBytes(data.g); decoded.set(data, g); }
  return g;
}

const bodies = new Map(), BODY_CACHE = 12;
/** How many pictures' tones are held (for the tests: the cache is bounded). */
export const imageCacheSize = () => bodies.size;

/**
 * An image element's tones in mm, centred on its own origin (before placement): { tones: [MultiPolygon] (tone 1,
 * the palest step, first; each inside the one before), width, height, px (mm per pixel) }. Cached per element and
 * parameters. Darker is more (a higher step, a deeper cut, a later colour) unless the element is inverted.
 */
export function imageTones(el) {
  const data = el.data;
  if (!data || !data.w || !data.h) return null;
  // held to the parameters' own ranges: a design file can carry any number (a huge smallest piece or smoothing would
  // ask for enormous buffers), and a very thin picture's width can be tiny without being wrong
  const num = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  const steps = Math.round(num(el.steps, 1, IMAGE_LIMITS.maxSteps, 1));
  const width = num(el.width, IMAGE_LIMITS.minWidth, IMAGE_LIMITS.maxWidth, 40), px = width / data.w;
  const balance = num(el.balance, -0.45, 0.45, 0);
  const smooth = num(el.smooth, 0, IMAGE_LIMITS.maxSmooth, 0), minPiece = num(el.minPiece, 0, IMAGE_LIMITS.maxPiece, 0);
  const sig = JSON.stringify([data.w, data.h, data.g.length, data.g.slice(0, 64), data.g.slice(-64), steps, width, balance, !!el.invert, smooth, minPiece]);
  const hit = bodies.get(el.id);
  if (hit && hit.sig === sig && hit.data === data) return hit;
  const w = data.w, h = data.h, g = grey(data), n = w * h;
  let f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = el.invert ? g[i] / 255 : 1 - g[i] / 255;   // darkness, 0 paper to 1 ink
  // Smoothing is about two standard deviations across; a blur wider than a third of the picture means nothing more
  // and would cost seconds (3 mm on a picture 0.1 mm wide is thousands of pixels)
  f = blur(f, w, h, Math.min(smooth / px / 2, Math.max(w, h) / 3));
  // the levels, a hair off the 1/255 grid the pixels sit on so no sample lies exactly on one (a contour through a
  // pixel centre would pinch two rings together at a point), and kept strictly rising where Balance clamps them
  const T = [0];
  for (let k = 1; k <= steps; k++) T.push(Math.max(T[k - 1] + 1e-4, Math.min(0.98, Math.max(0.02, k / (steps + 1) - balance)) + 1e-5));
  T.push(1);
  const lvl = v => { let c = 0; while (c < steps && v >= T[c + 1]) c++; return c; };
  // the tone of every pixel, with thin bands merged away; a pixel whose tone changed is re-seated in the middle of
  // its new tone's range, so the contours follow the merge and still interpolate everywhere else
  const L = new Uint8Array(n);
  for (let i = 0; i < n; i++) L[i] = lvl(f[i]);
  // no band is thinner than the whole picture: capping the radius there keeps the merge's buffers near the picture's
  // own size whatever the width and smallest piece (0.1 mm wide with a 10 mm piece would ask for 12,800 px of margin)
  const rho = Math.min(minPiece / px / 2, Math.max(w, h));
  if (rho >= 0.75 && steps > 1) {
    mergeThinBands(L, w, h, steps, rho);
    for (let i = 0; i < n; i++) if (lvl(f[i]) !== L[i]) f[i] = (T[L[i]] + T[L[i] + 1]) / 2;
  }
  const minAreaPx = (minPiece / px) ** 2;
  const toMm = ([x, y]) => [(x - 0.5 - w / 2) * px, -(y - 0.5 - h / 2) * px];
  const tones = [];
  for (let k = 1; k <= steps; k++) {
    const rings = isoRings(f, w, h, T[k], lvl).map(collinear);
    tones.push(nestRings(rings, minAreaPx).map(poly => poly.map(r => r.map(toMm))));
  }
  // a band piece under a quarter of the smallest piece's square, or averaging under a third of it in thickness (a
  // 1 mm dot averages 0.5, a long 1 mm strip about 1), is a crumb
  if (minPiece > 0) cleanBands(tones, (minPiece / 2) ** 2, minPiece / 3);
  const body = { sig, data, tones, width, height: data.h * px, px };
  bodies.delete(el.id); bodies.set(el.id, body);
  // bounded, oldest first out: a deleted picture's pixels and outlines are not kept for the rest of the session
  while (bodies.size > BODY_CACHE) bodies.delete(bodies.keys().next().value);
  return body;
}
