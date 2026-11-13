// SVG import: flat art becomes polygons grouped by fill colour, each group its own layer with a colour slot,
// operation and height. Strokes are ignored (a note says so); curves are flattened with three's SVGLoader.

import { SVGLoader } from '../../vendor/three/addons/loaders/SVGLoader.js';
import * as P from '../geometry/polys.js';
import { newElement } from '../geometry/face.js';

const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
function normHex(color) {
  if (!canvas) return '#888888';
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000000'; ctx.fillStyle = color;
  const v = ctx.fillStyle;
  return /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : '#888888';
}

function shapeToPoly(shape, divisions) {
  const outer = shape.getPoints(divisions).map(p => [p.x, -p.y]);
  if (outer.length < 3) return [];
  let poly = P.polygon(outer);
  for (const h of shape.holes) {
    const pts = h.getPoints(divisions).map(p => [p.x, -p.y]);
    if (pts.length >= 3) poly = P.difference(poly, P.polygon(pts));
  }
  return poly;
}

/**
 * Parse SVG text into an element. Returns { element, notes, newColors } where newColors are colour slots to add
 * to the design (fills not already present). `design` is read for existing colour slots.
 */
export function parseSvgArt(text, name, design, opts = {}) {
  const data = new SVGLoader().parse(text);
  const divisions = opts.divisions || 10;
  const byFill = new Map();
  let skippedStroke = 0, skippedNone = 0;
  for (const path of data.paths) {
    const style = path.userData?.style || {};
    const fill = style.fill;
    if (!fill || fill === 'none') { if (style.stroke && style.stroke !== 'none') skippedStroke++; else skippedNone++; continue; }
    if ((style.fillOpacity ?? 1) <= 0.01) continue;
    const hex = normHex(fill);
    const shapes = SVGLoader.createShapes(path);
    let mp = [];
    for (const sh of shapes) { const poly = shapeToPoly(sh, divisions); if (!P.isEmpty(poly)) mp = P.union(mp, poly); }
    if (P.isEmpty(mp)) continue;
    byFill.set(hex, byFill.has(hex) ? P.union(byFill.get(hex), mp) : mp);
  }
  if (!byFill.size) throw new Error('No filled shapes found in the SVG (strokes and images are not imported).');
  const all = P.union(...byFill.values());
  const bb = P.bbox(all);
  const cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
  const groups = [], newColors = [];
  const existing = design.colors.slice();
  let n = 0;
  for (const [hex, mp] of byFill) {
    n++;
    let slot = existing.find(c => c.hex.toLowerCase() === hex);
    if (!slot) {
      slot = { id: `c${Date.now().toString(36)}${n}`, name: `Art ${n}`, hex };
      existing.push(slot); newColors.push(slot);
    }
    groups.push({ name: `Fill ${hex}`, fill: hex, rings: P.clean(P.translate(mp, -cx, -cy)), color: slot.id, op: 'raise', height: 1, depth: 0.6, visible: true });
  }
  // largest group first so small details sit on top of big fills
  groups.sort((a, b) => P.area(b.rings) - P.area(a.rings));
  const element = newElement('svg', { name: name.replace(/\.svg$/i, '').slice(0, 60) || 'SVG art', groups, natural: { w: bb.w, h: bb.h } });
  const notes = [];
  if (skippedStroke) notes.push(`${skippedStroke} stroked path${skippedStroke > 1 ? 's were' : ' was'} skipped: only fills import. Outline strokes in your drawing app first.`);
  return { element, notes, newColors };
}
