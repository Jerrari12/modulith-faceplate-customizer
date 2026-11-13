// The pen (2026-11-11, after Erie Sign Studio's): draw a shape or a line on the 2D stage, then edit its points.
//
// Drawing: click to place a corner, press and drag to pull a smooth point's handles. Click the first point to close
// the shape (it becomes a filled drawing), or click the last point again (a double-click does) or press Enter to
// finish an open line. Backspace takes the last point back, Esc stops. Points snap to a 0.25 mm grid (1 mm with
// Shift, free with Alt).
//
// Editing a selected drawing: drag a point (its handles come with it) or a handle (the opposite handle turns with
// it; Alt moves one alone). Double-click a point to make it a corner or a curve, double-click the line to add a
// point there, Delete removes the chosen point. The inspector types a point's position.
//
// Points are stored about the drawing's own centre, unrotated (path.js); the stage works in plate millimetres, so
// every point goes through the drawing's place and turn on the size shown.

import { state, emit, commit, preview, currentSize, select, selectedElement } from '../state.js';
import { newElement, elementCentre, elementTurn, flushOp } from '../geometry/face.js';
import { pointsCentre, isOpen, PATH_LIMITS } from '../geometry/path.js';
import { elementOn } from '../variants.js';

let drawing = null;   // { pts: [{ x, y, i?, o? }] in plate mm, hover: [x, y] | null }
let drag = null;      // { kind: 'new' | 'pt' | 'hd', ... }

export const penActive = () => !!drawing;

/** Start drawing a new shape (anything selected is let go, so the stage shows only the pen). */
export function startPen() {
  drawing = { pts: [], hover: null };
  select(null);
  emit('pen');
}
export function cancelPen() { if (!drawing) return; drawing = null; drag = null; emit('pen'); }

const r3 = v => Math.round(v * 1000) / 1000;
const snapTo = (v, ev) => (ev.altKey ? r3(v) : Math.round(v / (ev.shiftKey ? 1 : 0.25)) * (ev.shiftKey ? 1 : 0.25));

function finish(closed) {
  const pts = drawing.pts;
  drawing = null; drag = null;
  if (pts.length < (closed ? 3 : 2)) { emit('pen'); emit('toast', closed ? 'A shape needs three points or more.' : 'A line needs two points or more.'); return; }
  // the drawing's centre is the middle of its points: it is placed there, and its points are kept about it
  const [cx, cy] = pointsCentre(pts).map(r3);
  const local = pts.map(p => { const q = { x: r3(p.x - cx), y: r3(p.y - cy) }; if (p.i) q.i = p.i.map(r3); if (p.o) q.o = p.o.map(r3); return q; });
  const el = newElement('path', { form: closed ? 'fill' : 'line', anchor: 'c', x: cx, y: cy, pts: local, name: closed ? 'Drawing' : 'Line' });
  el.op = flushOp(state.design);
  state.design.elements.push(el);
  commit(closed ? 'Draw shape' : 'Draw line');
  select(el.id);
  emit('pen');
}

// ---- a drawing's frame on the size shown: its points (local) to plate mm and back
function frameOf(el) {
  const size = currentSize(), elm = elementOn(el, size);
  const [cx, cy] = elementCentre(elm, size.w, size.h), a = elementTurn(elm) * Math.PI / 180;
  return { cx, cy, c: Math.cos(a), s: Math.sin(a) };
}
const toPlate = (f, x, y) => [f.cx + f.c * x - f.s * y, f.cy + f.s * x + f.c * y];
const toLocal = (f, X, Y) => { const dx = X - f.cx, dy = Y - f.cy; return [f.c * dx + f.s * dy, -f.s * dx + f.c * dy]; };
const vecPlate = (f, v) => [f.c * v[0] - f.s * v[1], f.s * v[0] + f.c * v[1]];
const vecLocal = (f, v) => [f.c * v[0] + f.s * v[1], -f.s * v[0] + f.c * v[1]];

/** The drawing being edited: the selected element when it is a drawing and the Design view shows it. */
function editing() {
  const el = selectedElement();
  return el && el.kind === 'path' && Array.isArray(el.pts) && state.view === 'design' && state.stage === '2d' && !drawing ? el : null;
}
/** The chosen point of the drawing being edited, or null. */
export function chosenPoint(el) {
  const k = state.pathPoint;
  return el && Number.isInteger(k) && k >= 0 && k < (el.pts?.length || 0) ? k : null;
}
function choose(k) { if (state.pathPoint === k) return; state.pathPoint = k; emit('select'); }
// the last press on a point: a second press on it soon after is a double-click (the browser sends none, because
// choosing the point on the first press redraws the marks under the pointer)
let lastPress = null;

// ---- the overlay, in plate mm (the stage's root group flips y)
const seg = (a, b) => (a.o || b.i
  ? `C${a.x + (a.o?.[0] || 0)} ${a.y + (a.o?.[1] || 0)} ${b.x + (b.i?.[0] || 0)} ${b.y + (b.i?.[1] || 0)} ${b.x} ${b.y}`
  : `L${b.x} ${b.y}`);
function pathD(pts, closed) {
  if (!pts.length) return '';
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let k = 1; k < pts.length; k++) d += seg(pts[k - 1], pts[k]);
  if (closed && pts.length > 2) d += `${seg(pts[pts.length - 1], pts[0])}Z`;
  return d;
}

/** The pen's marks over the plate: the drawing in progress, or the points of the drawing being edited. */
export function penOverlay(pxPerMm) {
  const px = 1 / (pxPerMm || 4), box = 7 * px, ink = 'var(--orange)';
  const square = (x, y, attrs, on) => `<rect ${attrs} x="${x - box / 2}" y="${y - box / 2}" width="${box}" height="${box}" fill="${on ? ink : '#fff'}" stroke="${ink}" stroke-width="${1.5 * px}"/>`;
  const handle = (p, h, attrs) => `<line x1="${p.x}" y1="${p.y}" x2="${p.x + h[0]}" y2="${p.y + h[1]}" stroke="${ink}" stroke-width="${1 * px}" pointer-events="none"/><circle ${attrs} cx="${p.x + h[0]}" cy="${p.y + h[1]}" r="${3.5 * px}" fill="#fff" stroke="${ink}" stroke-width="${1.2 * px}"/>`;
  if (drawing) {
    const pts = drawing.pts;
    let s = `<g class="pen drawing">`;
    if (pts.length) s += `<path d="${pathD(pts, false)}" fill="none" stroke="${ink}" stroke-width="${1.6 * px}" pointer-events="none"/>`;
    if (pts.length && drawing.hover && !drag) { const l = pts[pts.length - 1]; s += `<line x1="${l.x}" y1="${l.y}" x2="${drawing.hover[0]}" y2="${drawing.hover[1]}" stroke="${ink}" stroke-width="${1 * px}" stroke-dasharray="${4 * px} ${3 * px}" pointer-events="none"/>`; }
    const last = pts[pts.length - 1];
    if (last && (last.i || last.o)) { if (last.i) s += handle(last, last.i, 'pointer-events="none"'); if (last.o) s += handle(last, last.o, 'pointer-events="none"'); }
    pts.forEach((p, k) => { s += k === 0 && pts.length >= 3 ? `<circle cx="${p.x}" cy="${p.y}" r="${5.5 * px}" fill="#fff" stroke="${ink}" stroke-width="${2 * px}" pointer-events="none"/>` : square(p.x, p.y, 'pointer-events="none"', k === pts.length - 1); });
    return `${s}</g>`;
  }
  const el = editing();
  if (!el) return '';
  const f = frameOf(el), open = isOpen(el), chosen = chosenPoint(el);
  const Q = el.pts.map(p => { const [x, y] = toPlate(f, p.x, p.y), q = { x, y }; if (p.i) q.i = vecPlate(f, p.i); if (p.o) q.o = vecPlate(f, p.o); return q; });
  let s = `<g class="pen editing">`;
  // the line itself, and a wide clear stroke over each segment to double-click a point into (a press there still
  // moves the drawing, as a press on the drawing does)
  s += `<path d="${pathD(Q, !open)}" fill="none" stroke="${ink}" stroke-width="${1.2 * px}" stroke-dasharray="${5 * px} ${3 * px}" pointer-events="none"/>`;
  const n = Q.length, segs = open ? n - 1 : n;
  for (let k = 0; k < segs; k++) s += `<path class="pen-seg" data-el="${el.id}" data-seg="${k}" d="M${Q[k].x} ${Q[k].y}${seg(Q[k], Q[(k + 1) % n])}" fill="none" stroke="transparent" stroke-width="${10 * px}"/>`;
  // handles: the chosen point's, and the ones its neighbours turn toward it
  if (chosen !== null) {
    const at = (k, side) => { const p = Q[k]; if (p?.[side]) s += handle(p, p[side], `class="pen-hd" data-hd="${k}" data-side="${side}"`); };
    at(chosen, 'i'); at(chosen, 'o');
    if (!open || chosen > 0) at((chosen - 1 + n) % n, 'o');
    if (!open || chosen < n - 1) at((chosen + 1) % n, 'i');
  }
  Q.forEach((p, k) => { s += square(p.x, p.y, `class="pen-pt" data-pt="${k}"`, k === chosen); });
  return `${s}</g>`;
}

// ---- pointer events from the stage (mm: the pointer in plate mm; ppm: screen pixels per mm)

/** A press on the stage. True when the pen takes it (the stage then sends the moves and the release here). */
export function penDown(ev, mm, ppm) {
  if (ev.button !== 0) return false;
  if (drawing) {
    const pts = drawing.pts, near = (p, r) => Math.hypot(p.x - mm[0], p.y - mm[1]) * ppm <= r;
    if (pts.length >= 3 && near(pts[0], 9)) { finish(true); return true; }
    if (pts.length >= 2 && near(pts[pts.length - 1], 5)) { finish(false); return true; }
    if (pts.length >= PATH_LIMITS.maxPoints) { emit('toast', `A drawing can have at most ${PATH_LIMITS.maxPoints} points.`); return true; }
    const p = { x: snapTo(mm[0], ev), y: snapTo(mm[1], ev) };
    pts.push(p);
    drag = { kind: 'new', p, at: [p.x, p.y] };
    emit('pen');
    return true;
  }
  const el = editing();
  if (!el) return false;
  const t = ev.target;
  if (t?.dataset?.pt !== undefined) {
    const k = +t.dataset.pt, f = frameOf(el), p = el.pts[k], now = performance.now();
    if (!p) return false;
    if (lastPress && lastPress.id === el.id && lastPress.k === k && now - lastPress.t < 450) { lastPress = null; togglePoint(el, k); return true; }
    lastPress = { id: el.id, k, t: now };
    choose(k);
    drag = { kind: 'pt', el, k, f, from: toPlate(f, p.x, p.y), mm0: mm, moved: false };
    return true;
  }
  if (t?.dataset?.hd !== undefined) {
    const k = +t.dataset.hd, side = t.dataset.side === 'i' ? 'i' : 'o';
    if (!el.pts[k]) return false;
    drag = { kind: 'hd', el, k, side, f: frameOf(el), moved: false };
    return true;
  }
  return false;
}

/** A move over the stage: the rubber band while drawing, or a drag the pen took. True when the pen used it. */
export function penMove(ev, mm, ppm) {
  if (drawing && !drag) { drawing.hover = mm; emit('pen'); return true; }
  if (!drag) return false;
  if (drag.kind === 'new') {
    // pulling away from a new point makes it smooth: its handles point along the drag, and back the other way
    const v = [mm[0] - drag.at[0], mm[1] - drag.at[1]];
    if (Math.hypot(v[0], v[1]) * ppm < 4) { delete drag.p.i; delete drag.p.o; }
    else { drag.p.o = v.map(r3); drag.p.i = [r3(-v[0]), r3(-v[1])]; }
    emit('pen');
    return true;
  }
  const { el, k, f } = drag, p = el.pts[k];
  if (!p) return true;
  if (drag.kind === 'pt') {
    const want = [drag.from[0] + mm[0] - drag.mm0[0], drag.from[1] + mm[1] - drag.mm0[1]];
    const [x, y] = toLocal(f, snapTo(want[0], ev), snapTo(want[1], ev));
    if (!drag.moved && Math.hypot(mm[0] - drag.mm0[0], mm[1] - drag.mm0[1]) * ppm < 2) return true;
    drag.moved = true;
    p.x = r3(x); p.y = r3(y);
  } else {
    const [px0, py0] = toPlate(f, p.x, p.y);
    const v = vecLocal(f, [mm[0] - px0, mm[1] - py0]).map(r3);
    if (Math.hypot(v[0], v[1]) < 1e-3) return true;
    drag.moved = true;
    p[drag.side] = v;
    // the opposite handle keeps its length and turns to stay in line, unless Alt breaks the curve into a cusp
    const other = drag.side === 'i' ? 'o' : 'i';
    if (!ev.altKey && p[other]) { const L = Math.hypot(...p[other]), m = Math.hypot(...v); p[other] = [r3(-v[0] / m * L), r3(-v[1] / m * L)]; }
  }
  preview();
  return true;
}

/** The release. True when the pen had the drag. */
export function penUp() {
  if (!drag) return false;
  const d = drag;
  drag = null;
  if (d.kind === 'new') { emit('pen'); return true; }
  if (d.moved) commit(d.kind === 'pt' ? 'Move point' : 'Curve');
  return true;
}

/** A double-click on `t` (the element under the pointer): a point turns corner or curve, the line gets a point. */
export function penDblClick(t, mm) {
  const el = editing();
  if (!el) return false;
  if (t?.dataset?.pt !== undefined) { togglePoint(el, +t.dataset.pt); return true; }
  if (t?.dataset?.seg !== undefined) { insertPoint(el, +t.dataset.seg, toLocal(frameOf(el), mm[0], mm[1])); return true; }
  return false;
}

/** A point between corner (no handles) and curve (handles along its neighbours, a third of the way to each). */
export function togglePoint(el, k) {
  const pts = el.pts, p = pts[k];
  if (!p) return;
  if (p.i || p.o) { delete p.i; delete p.o; }
  else {
    const n = pts.length, open = isOpen(el);
    const prev = k > 0 || !open ? pts[(k - 1 + n) % n] : null, next = k < n - 1 || !open ? pts[(k + 1) % n] : null;
    const a = prev || p, b = next || p, dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
    if (L < 1e-6) return;
    const lp = prev ? Math.hypot(p.x - prev.x, p.y - prev.y) : Infinity, ln = next ? Math.hypot(next.x - p.x, next.y - p.y) : Infinity;
    const len = Math.min(lp, ln) / 3;
    if (!Number.isFinite(len) || len < 1e-3) return;
    p.o = [r3(dx / L * len), r3(dy / L * len)]; p.i = [r3(-dx / L * len), r3(-dy / L * len)];
  }
  choose(k);
  commit('Corner or curve');
}

/** Add a point on segment k (from point k to the next) where it passes nearest `at` (local mm), keeping its shape. */
export function insertPoint(el, k, at) {
  const pts = el.pts, n = pts.length;
  if (n >= PATH_LIMITS.maxPoints) { emit('toast', `A drawing can have at most ${PATH_LIMITS.maxPoints} points.`); return; }
  const a = pts[k], b = pts[(k + 1) % n];
  if (!a || !b) return;
  const P0 = [a.x, a.y], P1 = [a.x + (a.o?.[0] || 0), a.y + (a.o?.[1] || 0)], P2 = [b.x + (b.i?.[0] || 0), b.y + (b.i?.[1] || 0)], P3 = [b.x, b.y];
  const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  const curve = !!(a.o || b.i);
  // the nearest place on the segment, sampled finely, then de Casteljau's split there
  let best = 0.5, bd = Infinity;
  for (let s = 1; s < 128; s++) {
    const t = s / 128, q = curve ? lerp(lerp(lerp(P0, P1, t), lerp(P1, P2, t), t), lerp(lerp(P1, P2, t), lerp(P2, P3, t), t), t) : lerp(P0, P3, t);
    const d = Math.hypot(q[0] - at[0], q[1] - at[1]);
    if (d < bd) { bd = d; best = t; }
  }
  let p;
  if (!curve) { const q = lerp(P0, P3, best); p = { x: r3(q[0]), y: r3(q[1]) }; }
  else {
    const t = best, A = lerp(P0, P1, t), B = lerp(P1, P2, t), C = lerp(P2, P3, t), D = lerp(A, B, t), E = lerp(B, C, t), M = lerp(D, E, t);
    p = { x: r3(M[0]), y: r3(M[1]), i: [r3(D[0] - M[0]), r3(D[1] - M[1])], o: [r3(E[0] - M[0]), r3(E[1] - M[1])] };
    a.o = [r3(A[0] - P0[0]), r3(A[1] - P0[1])];
    b.i = [r3(C[0] - P3[0]), r3(C[1] - P3[1])];
  }
  pts.splice(k + 1, 0, p);
  choose(k + 1);
  commit('Add point');
}

/** Take point k away, if the drawing keeps enough to stay a line or a shape. */
export function deletePoint(el, k) {
  const need = isOpen(el) ? 2 : 3;
  if (!el.pts[k]) return;
  if (el.pts.length <= need) { emit('toast', `A ${isOpen(el) ? 'line' : 'shape'} needs at least ${need} points: remove the drawing instead.`); return; }
  el.pts.splice(k, 1);
  choose(el.pts.length ? Math.min(k, el.pts.length - 1) : null);
  commit('Remove point');
}

/** A point's place on the plate (mm, on the size shown), for the inspector's X and Y. */
export function pointOnPlate(el, k) { const p = el.pts[k], f = frameOf(el); return toPlate(f, p.x, p.y).map(r3); }
/** Move point k to a place on the plate. */
export function setPointOnPlate(el, k, X, Y) { const p = el.pts[k]; if (!p) return; const [x, y] = toLocal(frameOf(el), X, Y); p.x = r3(x); p.y = r3(y); }

/** Keys while the pen draws or a point is chosen. True when the pen used the key. */
export function penKey(ev) {
  if (drawing) {
    if (ev.key === 'Escape') { cancelPen(); return true; }
    if (ev.key === 'Enter') { finish(false); return true; }
    if (ev.key === 'Backspace' || ev.key === 'Delete') { drawing.pts.pop(); emit('pen'); return true; }
    return false;
  }
  const el = editing(), k = chosenPoint(el);
  if (k === null) return false;
  if (ev.key === 'Escape') { choose(null); return true; }
  if (ev.key === 'Backspace' || ev.key === 'Delete') { deletePoint(el, k); return true; }
  return false;
}
