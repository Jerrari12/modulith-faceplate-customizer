// Filling a flat element (a shape, text, SVG art) with something other than solid material: a texture (any
// pattern that is not linked to the wall grid) or just its outline. The fill is worked out in the element's own
// frame, before it is placed, so the texture moves, turns and mirrors with the element and is anchored at its
// centre. A border keeps a solid rim of the outline round the texture, so the letters or the shape still read;
// "Outline" is that rim alone. Pieces the outline clips too small or too thin to print are dropped (or, with a
// border, join it).

import * as P from './polys.js';
import { PATTERNS, generatePattern, cleanPatternParams } from './patterns.js';
import { offsetPoly } from './offset.js';

/** The fill choices: solid, outline, and every pattern that is not tied to the wall grid. */
export const FILL_OPTIONS = [['solid', 'Solid'], ['outline', 'Outline'], ...Object.entries(PATTERNS).filter(([, d]) => !d.linked).map(([k, d]) => [k, d.label])];
export const isFilled = el => !!el.fill && el.fill !== 'solid' && FILL_OPTIONS.some(([k]) => k === el.fill);

const CRUMB_AREA = 0.3, CRUMB_THICK = 0.2;   // mm2, mm: a clipped piece smaller or thinner than this cannot print
const perimeter = poly => poly.reduce((s, r) => { for (let i = 0; i + 1 < r.length; i++) s += Math.hypot(r[i + 1][0] - r[i][0], r[i + 1][1] - r[i][1]); return s; }, 0);
const keepPiece = poly => { const a = P.area([poly]); return a >= CRUMB_AREA && 2 * a / perimeter(poly) >= CRUMB_THICK; };

const cache = new Map(), CACHE = 32;

/**
 * The element's outline `local` (a MultiPolygon in its own frame, mm) with the element's fill applied. `sig` names
 * the outline (the caller's own key for its shape, text or art layer), so the work is done once per edit.
 */
export function applyFill(local, el, sig) {
  if (!isFilled(el) || !local || !local.length) return local;
  const fill = el.fill;
  const border = Math.max(0, Math.min(20, Number(el.border) || 0));
  if (fill === 'outline' && border <= 0) return local;          // an outline with no width is the shape itself
  const params = fill === 'outline' ? null : cleanPatternParams(fill, el.fillParams);
  const key = JSON.stringify([sig, fill, params, border]);
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }

  const inner = border > 0 ? offsetPoly(local, -border) : local;
  const rim = border > 0 ? P.difference(local, inner) : [];
  let out;
  if (fill === 'outline') out = rim;
  else {
    // the texture over a box centred on the element's origin that covers the whole outline
    const b = P.bbox(local);
    const W = 2 * Math.max(Math.abs(b.x0), Math.abs(b.x1)) + 2, H = 2 * Math.max(Math.abs(b.y0), Math.abs(b.y1)) + 2;
    const texture = generatePattern(fill, { ...params, anchor: 'center' }, W, H);
    const inside = P.isEmpty(inner) ? [] : P.intersection(texture, inner);
    // crumbs the outline clips off go; the rim stays whatever its width (the checks judge a rim too thin to print)
    const pieces = inside.filter(keepPiece);
    out = rim.length ? P.union(rim, pieces) : pieces;
  }
  cache.set(key, out);
  if (cache.size > CACHE) cache.delete(cache.keys().next().value);
  return out;
}

/** A fill's settings when it is picked: the texture's own defaults (solid and outline have none). */
export function fillDefaults(fill) {
  return fill === 'solid' || fill === 'outline' || !PATTERNS[fill] ? {} : cleanPatternParams(fill, {});
}
