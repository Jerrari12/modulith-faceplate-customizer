// Raster analysis for the printability checks: polygon rasterisation, an exact Euclidean distance transform
// (Felzenszwalb & Huttenlocher) and connected components. The distance transform gives, for every inside
// cell, the distance to the nearest outside cell; twice the largest distance inside a region is the width of
// the biggest circle that fits in it, which is how "how wide is this bridge" and "how thin is this strip"
// are answered. Everything works on Uint8Array masks (1 = material / region, 0 = empty).

export function rasterize(mp, x0, y0, w, h, res) {
  const mask = new Uint8Array(w * h);
  const rows = new Array(h);
  for (const poly of mp) for (const ring of poly) {
    for (let i = 0; i < ring.length - 1; i++) {
      let [ax, ay] = ring[i], [bx, by] = ring[i + 1];
      if (ay === by) continue;
      if (ay > by) { [ax, ay, bx, by] = [bx, by, ax, ay]; }
      // sample rows whose centre y lies in [ay, by)
      const j0 = Math.max(0, Math.ceil((ay - y0) / res - 0.5)), j1 = Math.min(h - 1, Math.ceil((by - y0) / res - 0.5) - 1);
      const slope = (bx - ax) / (by - ay);
      for (let j = j0; j <= j1; j++) {
        const yc = y0 + (j + 0.5) * res;
        const x = ax + (yc - ay) * slope;
        (rows[j] || (rows[j] = [])).push((x - x0) / res - 0.5);
      }
    }
  }
  for (let j = 0; j < h; j++) {
    const xs = rows[j];
    if (!xs || xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(xs[k])), i1 = Math.min(w - 1, Math.floor(xs[k + 1]));
      if (i1 < i0) continue;
      mask.fill(1, j * w + i0, j * w + i1 + 1);
    }
  }
  return mask;
}

const INF = 1e20;

function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Distance (in cells) from each inside cell to the nearest outside cell; the border counts as outside unless
 *  borderOutside is false (then only real outside cells count, as when measuring how far a cell is FROM a shape). */
export function distanceTransform(mask, w, h, borderOutside = true) {
  const W = w + 2, H = h + 2;                      // pad with an outside border
  const g = new Float64Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const inside = (i > 0 && j > 0 && i < W - 1 && j < H - 1) ? mask[(j - 1) * w + (i - 1)] : (borderOutside ? 0 : 1);
    g[j * W + i] = inside ? INF : 0;
  }
  const n = Math.max(W, H);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let i = 0; i < W; i++) {                    // columns
    for (let j = 0; j < H; j++) f[j] = g[j * W + i];
    edt1d(f, H, d, v, z);
    for (let j = 0; j < H; j++) g[j * W + i] = d[j];
  }
  for (let j = 0; j < H; j++) {                    // rows
    for (let i = 0; i < W; i++) f[i] = g[j * W + i];
    edt1d(f, W, d, v, z);
    for (let i = 0; i < W; i++) g[j * W + i] = d[i];
  }
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out[j * w + i] = Math.sqrt(g[(j + 1) * W + (i + 1)]);
  return out;
}

/** 4-connected components. Returns { labels: Int32Array (0 = empty), count }. */
export function components(mask, w, h) {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let count = 0;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || labels[s]) continue;
    count++;
    let sp = 0; stack[sp++] = s; labels[s] = count;
    while (sp) {
      const p = stack[--sp];
      const i = p % w, j = (p - i) / w;
      if (i > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = count; stack[sp++] = p - 1; }
      if (i < w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = count; stack[sp++] = p + 1; }
      if (j > 0 && mask[p - w] && !labels[p - w]) { labels[p - w] = count; stack[sp++] = p - w; }
      if (j < h - 1 && mask[p + w] && !labels[p + w]) { labels[p + w] = count; stack[sp++] = p + w; }
    }
  }
  return { labels, count };
}

/**
 * Per-region statistics of a mask: width of the largest inscribed circle, area and where the widest point is.
 * Returns [{ label, areaMm2, maxWidth, at: [xMm, yMm], bbox: {x0,y0,x1,y1} }].
 */
export function regionStats(mask, w, h, res, originX, originY) {
  const { labels, count } = components(mask, w, h);
  if (!count) return [];
  const dist = distanceTransform(mask, w, h);
  const best = new Float32Array(count + 1), bestAt = new Int32Array(count + 1), cells = new Int32Array(count + 1);
  const bx0 = new Int32Array(count + 1).fill(w), by0 = new Int32Array(count + 1).fill(h), bx1 = new Int32Array(count + 1).fill(-1), by1 = new Int32Array(count + 1).fill(-1);
  for (let p = 0; p < w * h; p++) {
    const l = labels[p];
    if (!l) continue;
    cells[l]++;
    const i = p % w, j = (p - i) / w;
    if (i < bx0[l]) bx0[l] = i; if (i > bx1[l]) bx1[l] = i; if (j < by0[l]) by0[l] = j; if (j > by1[l]) by1[l] = j;
    if (dist[p] > best[l]) { best[l] = dist[p]; bestAt[l] = p; }
  }
  const out = [];
  for (let l = 1; l <= count; l++) {
    const p = bestAt[l], i = p % w, j = (p - i) / w;
    out.push({
      label: l, areaMm2: cells[l] * res * res,
      // a cell centre with distance d to the nearest empty cell centre spans about (2d - 1) cells of material
      maxWidth: Math.max(res, (2 * best[l] - 1) * res),
      at: [originX + (i + 0.5) * res, originY + (j + 0.5) * res],
      bbox: { x0: originX + bx0[l] * res, y0: originY + by0[l] * res, x1: originX + (bx1[l] + 1) * res, y1: originY + (by1[l] + 1) * res },
    });
  }
  return out;
}

/** A raster frame covering a bounding box with a margin, at a resolution that keeps the cell count sane. */
export function frameFor(bbox, res = 0.1, maxCells = 6e6) {
  const margin = 2 * res;
  let r = res;
  const cells = () => Math.ceil((bbox.x1 - bbox.x0 + 2 * margin) / r) * Math.ceil((bbox.y1 - bbox.y0 + 2 * margin) / r);
  while (cells() > maxCells) r *= 1.5;
  const x0 = bbox.x0 - margin, y0 = bbox.y0 - margin;
  return { x0, y0, res: r, w: Math.ceil((bbox.x1 - bbox.x0 + 2 * margin) / r), h: Math.ceil((bbox.y1 - bbox.y0 + 2 * margin) / r) };
}
