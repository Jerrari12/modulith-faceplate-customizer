// Polygon helpers over polygon-clipping (Martinez clipping). In the browser the UMD build is loaded as a
// classic script and exposes window.polygonClipping; Node tests set globalThis.polygonClipping before import.
//
// Types (GeoJSON-style, RFC 7946 winding on output): a MultiPolygon is an array of Polygons; a Polygon is an
// array of rings (first = exterior, counter-clockwise; the rest = holes, clockwise); a ring is an array of
// [x, y] points, closed (first point repeated at the end). All units are millimetres.

const pc = () => {
  const lib = globalThis.polygonClipping;
  if (!lib) throw new Error('polygon-clipping is not loaded');
  return lib.union ? lib : lib.default;
};

export const EPS = 1e-7;

export function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return a / 2;
}

export function area(mp) {
  let a = 0;
  for (const poly of mp) poly.forEach((ring, i) => { a += (i === 0 ? 1 : -1) * Math.abs(ringArea(ring)); });
  return a;
}

export function isEmpty(mp) { return !mp || mp.length === 0; }

function closeRing(ring) {
  if (ring.length < 3) return ring;
  const a = ring[0], b = ring[ring.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) return [...ring, [a[0], a[1]]];
  return ring;
}

/** A simple polygon from a point list; winding is normalised to counter-clockwise. */
export function polygon(points) {
  let ring = closeRing(points.map(p => [p[0], p[1]]));
  if (ringArea(ring) < 0) ring = ring.slice().reverse();
  return [[ring]];
}

export function rect(x0, y0, x1, y1) {
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  return [[[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]];
}

export function roundRect(x0, y0, x1, y1, r, segs = 8) {
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  r = Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2);
  if (r <= 0) return rect(x0, y0, x1, y1);
  const pts = [];
  const corner = (cx, cy, a0) => { for (let i = 0; i <= segs; i++) { const a = a0 + (i / segs) * Math.PI / 2; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } };
  corner(x1 - r, y0 + r, -Math.PI / 2);
  corner(x1 - r, y1 - r, 0);
  corner(x0 + r, y1 - r, Math.PI / 2);
  corner(x0 + r, y0 + r, Math.PI);
  return polygon(pts);
}

export function circle(cx, cy, r, n = 48) {
  const ring = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * 2 * Math.PI; ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  ring.push([ring[0][0], ring[0][1]]);
  return [[ring]];
}

export function ellipse(cx, cy, rx, ry, n = 48) {
  const ring = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * 2 * Math.PI; ring.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
  ring.push([ring[0][0], ring[0][1]]);
  return [[ring]];
}

export function regularPolygon(cx, cy, r, n, rotDeg = 0) {
  const ring = [];
  for (let i = 0; i < n; i++) { const a = rotDeg * Math.PI / 180 + (i / n) * 2 * Math.PI; ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  ring.push([ring[0][0], ring[0][1]]);
  return [[ring]];
}

export function star(cx, cy, rOut, rIn, n = 5, rotDeg = 90) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = rotDeg * Math.PI / 180 + (i / (n * 2)) * 2 * Math.PI, r = (i & 1) ? rIn : rOut;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return polygon(pts);
}

/** Round every coordinate to a multiple of q (mm). Near-coincident points become coincident, which is what the
 *  sweep line in polygon-clipping copes with; points a hair apart are what make it fail. */
export function snap(mp, q = 1e-4) {
  const r = v => Math.round(v / q) * q;
  return clean(mp.map(poly => poly.map(ring => {
    const out = [];
    for (const [x, y] of ring) { const p = [r(x), r(y)]; const l = out[out.length - 1]; if (!l || l[0] !== p[0] || l[1] !== p[1]) out.push(p); }
    return out;
  }).filter(ring => ring.length >= 4)).filter(poly => poly.length), 0);
}

/**
 * union() for many small pieces that touch (pattern tiles): polygon-clipping can fail to close a ring when pieces
 * meet along nearly coincident edges ("Unable to complete output ring"). Retry on coarser coordinate grids before
 * giving up; the last grid, 0.01 mm, is still a quarter of a print raster cell.
 */
export function unionPieces(pieces) {
  let last;
  for (const q of [1e-4, 1e-3, 1e-2]) {
    try { return union(...pieces.map(p => snap(p, q))); } catch (e) { last = e; }
  }
  throw last;
}

/**
 * Run a clipping operation, and if polygon-clipping cannot close a ring (two inputs sharing an edge to within
 * rounding: an inlay and the face around it, tiles that abut), run it again on coarser coordinate grids. The last
 * grid, 0.01 mm, is still a tenth of a print raster cell.
 */
function robust(op, args) {
  try { return pc()[op](...args); } catch (first) {
    for (const q of [1e-4, 1e-3, 1e-2]) {
      try { return pc()[op](...args.map(a => snap(a, q))); } catch { /* the next grid */ }
    }
    throw first;
  }
}

export function union(...mps) {
  const list = mps.filter(m => m && m.length);
  if (!list.length) return [];
  if (list.length === 1) return list[0];
  return robust('union', list);
}

export function intersection(a, b) {
  if (isEmpty(a) || isEmpty(b)) return [];
  return robust('intersection', [a, b]);
}

export function difference(a, ...bs) {
  if (isEmpty(a)) return [];
  const list = bs.filter(b => b && b.length);
  if (!list.length) return a;
  return robust('difference', [a, ...list]);
}

export function xor(a, b) { return pc().xor(a, b); }

export function transform(mp, fn) { return mp.map(poly => poly.map(ring => ring.map(p => fn(p)))); }

export function translate(mp, dx, dy) { return transform(mp, ([x, y]) => [x + dx, y + dy]); }

export function rotate(mp, deg, cx = 0, cy = 0) {
  if (!deg) return mp;
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return transform(mp, ([x, y]) => { const dx = x - cx, dy = y - cy; return [cx + dx * c - dy * s, cy + dx * s + dy * c]; });
}

export function scale(mp, sx, sy = sx, cx = 0, cy = 0) {
  const out = transform(mp, ([x, y]) => [cx + (x - cx) * sx, cy + (y - cy) * sy]);
  return (sx * sy < 0) ? out.map(poly => poly.map(ring => ring.slice().reverse())) : out;
}

/** Mirror about the vertical line x = x0 (rings are reversed so winding stays valid). */
export function mirrorX(mp, x0 = 0) {
  return mp.map(poly => poly.map(ring => ring.map(([x, y]) => [2 * x0 - x, y]).reverse()));
}

/** Mirror about the horizontal line y = y0. */
export function mirrorY(mp, y0 = 0) {
  return mp.map(poly => poly.map(ring => ring.map(([x, y]) => [x, 2 * y0 - y]).reverse()));
}

export function bbox(mp) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of mp) for (const ring of poly) for (const [x, y] of ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/** Drop degenerate rings and polygons. */
export function clean(mp, minArea = 1e-6) {
  const out = [];
  for (const poly of mp) {
    if (!poly.length || Math.abs(ringArea(poly[0])) < minArea) continue;
    const rings = [poly[0], ...poly.slice(1).filter(r => Math.abs(ringArea(r)) >= minArea)];
    out.push(rings);
  }
  return out;
}

/** Count points (for complexity budgets). */
export function pointCount(mp) { let n = 0; for (const poly of mp) for (const ring of poly) n += ring.length; return n; }

/** SVG path data for a MultiPolygon (render with fill-rule evenodd so the holes read as holes). */
export function pathD(mp, digits = 3) {
  const f = v => +v.toFixed(digits);
  let d = '';
  for (const poly of mp) for (const ring of poly) {
    if (ring.length < 3) continue;
    d += `M${f(ring[0][0])} ${f(ring[0][1])}`;
    for (let i = 1; i < ring.length - 1; i++) d += `L${f(ring[i][0])} ${f(ring[i][1])}`;
    d += 'Z';
  }
  return d;
}

/** Point-in-multipolygon test (even-odd). */
export function contains(mp, x, y) {
  let inside = false;
  for (const poly of mp) for (const ring of poly) {
    for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
  }
  return inside;
}
