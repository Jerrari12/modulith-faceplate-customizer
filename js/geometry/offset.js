// Growing or shrinking any outline by a distance (an offset), for borders and outlines. polygon-clipping has no
// offsetting, so this goes through a raster: the shape at a fine resolution, the exact distance from every cell to
// the outline (a Euclidean distance transform), and the contour of that distance at the offset, traced with
// interpolation (the same marching squares the picture tones use). The error is about half a cell, 0.02 mm at the
// default resolution; corners come out rounded, as a nozzle would draw them.

import * as P from './polys.js';
import { rasterize, distanceTransform } from '../checks/raster.js';
import { isoRings, nestRings } from './image.js';

/**
 * The outline `mp` moved outward by d mm (d > 0) or inward by -d mm (d < 0): a MultiPolygon, empty when an inset
 * swallows the shape. `res` is the raster cell in mm, coarsened when the shape is so big the grid would pass
 * `maxCells`; pieces smaller than `minArea` mm2 are dropped.
 */
export function offsetPoly(mp, d, { res = 0.04, maxCells = 3e6, minArea = 1e-3 } = {}) {
  if (!mp || !mp.length || !d) return mp || [];
  const b = P.bbox(mp);
  if (!b) return [];
  const margin = () => Math.max(0, d) + 4 * res;
  const size = () => [Math.ceil((b.w + 2 * margin()) / res), Math.ceil((b.h + 2 * margin()) / res)];
  while (size()[0] * size()[1] > maxCells) res *= 1.25;
  const [w, h] = size(), m = margin(), x0 = b.x0 - m, y0 = b.y0 - m;
  const inside = rasterize(mp, x0, y0, w, h, res), n = w * h;
  const f = new Float32Array(n);
  let T;
  if (d < 0) {
    // inside: how far in from the outline each cell's centre is (a cell next to the outside is half a cell in)
    const dt = distanceTransform(inside, w, h);
    for (let i = 0; i < n; i++) f[i] = inside[i] ? dt[i] - 0.5 : -0.5;
    T = -d / res;
  } else {
    // outside: how far out; the shape plus everything within d of it is where f >= 0
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = inside[i] ? 0 : 1;
    const dt = distanceTransform(out, w, h, false);   // the frame is not the shape: measure to the shape only
    for (let i = 0; i < n; i++) f[i] = inside[i] ? d / res + 0.5 : d / res - (dt[i] - 0.5);
    T = 0;
  }
  // a hair off the level, so no cell centre lies exactly on it (two contours would pinch at a point)
  const rings = isoRings(f, w, h, T + 1e-4);
  const toMm = ([x, y]) => [x0 + (x - 0.5) * res, y0 + (y - 0.5) * res];
  return nestRings(rings, minArea / (res * res)).map(poly => poly.map(r => r.map(toMm)));
}
