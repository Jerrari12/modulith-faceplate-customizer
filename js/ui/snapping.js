// Magnetic snapping for dragging an element on the 2D stage, with the guide lines it locks to. The obvious places on
// a faceplate are its centre lines, its quarters, its edges and a 3 mm inset from them, the handle line between the
// screw holes, and the centres and edges of the other elements. Pure arithmetic, so it is testable.

import * as P from '../geometry/polys.js';

const INSET = 3;   // mm from the plate edge: a "sits in from the edge" slot

/** Candidate lines for one drag: { x: [...], y: [...] } in plate mm. `id` is the element being dragged. */
export function snapLines(built, design, id) {
  // `id`: the dragged element's id, or a set of ids when several move together (a combine and its pieces)
  const skip = id instanceof Set ? id : new Set([id]);
  const { w: W, h: H } = built.size;
  const x = [0, -W / 4, W / 4, -W / 2, W / 2, -W / 2 + INSET, W / 2 - INSET];
  const y = [0, -H / 4, H / 4, -H / 2, H / 2, -H / 2 + INSET, H / 2 - INSET];
  for (const h of built.size.holes) { x.push(h.x); y.push(h.y); }
  // the other elements: their centres and edges (patterns cover the plate, so they offer nothing)
  const boxes = new Map();
  // keyed by element AND side, so a mirrored pair offers both centres; the dragged element's own twin moves with it
  const addBox = (eid, twin, poly) => { if (!eid || skip.has(eid) || P.isEmpty(poly)) return; const k = `${eid}|${twin ? 't' : 'o'}`; (boxes.get(k) || boxes.set(k, []).get(k)).push(poly); };
  for (const L of built.layers) if (L.kind !== 'pattern' && L.kind !== 'slab') addBox(L.elementId, L.twin, L.poly);
  for (const s of built.solids) addBox(s.elementId, s.twin, s.footprint);
  for (const polys of boxes.values()) {
    const b = P.bbox(P.union(...polys));
    if (!b) continue;
    x.push(b.x0, b.x1, (b.x0 + b.x1) / 2);
    y.push(b.y0, b.y1, (b.y0 + b.y1) / 2);
  }
  return { x, y };
}

/**
 * Snap a dragged element. `want` is where its centre would be, `box` its extent around that centre
 * ({ x0, x1, y0, y1 }), `tol` the snap distance in mm. Returns { x, y, guides }: the snapped centre on each axis
 * (null where nothing was close enough) and the lines it locked to.
 */
export function snapMove(want, box, lines, tol) {
  const guides = [];
  const axis = (c, lo, hi, list, name) => {
    let best = null;
    for (const ref of [0, lo, hi]) for (const L of list) {
      const d = L - (c + ref);
      if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d) - 1e-9)) best = { d, at: L };
    }
    if (!best) return null;
    guides.push({ axis: name, at: best.at });
    return c + best.d;
  };
  const x = axis(want[0], box.x0, box.x1, lines.x, 'x');
  const y = axis(want[1], box.y0, box.y1, lines.y, 'y');
  return { x, y, guides };
}
