// The 2D stage: an SVG that fills the workspace, in plate millimetres with y up. Pan with the background,
// zoom with the wheel, drag shapes / art / grips to move them, click an element to select it.

import { state, on, emit, currentSize, getBuild, ensureChecks, select, commit, preview, colorHex } from '../state.js';
import { stageContent } from './render2d.js';
import { elementCentre, flushEdge, spansWidth, movablePieces, usesElement } from '../geometry/face.js';
import * as P from '../geometry/polys.js';
import { snapLines, snapMove } from './snapping.js';
import { elementOn, setOn, valueOn } from '../variants.js';
import { penActive, penOverlay, penDown, penMove, penUp, penDblClick } from './pen.js';

const NS = 'http://www.w3.org/2000/svg';
let host, svg, root, penLayer, view = { x: -60, y: -40, w: 120, h: 80 };   // viewBox in root coords (y down)
let fitPending = true;
let userFramed = false;   // the user panned or zoomed: a resize keeps their framing instead of refitting

function pxPerMm() { const r = host.getBoundingClientRect(); return Math.min(r.width / view.w, r.height / view.h) || 4; }

function applyView() {
  const r = host.getBoundingClientRect();
  if (!r.width || !r.height) return;   // hidden: nothing to fit to
  // keep the aspect of the host: expand the viewBox on the shorter axis
  const aspect = r.width / Math.max(1, r.height);
  let { x, y, w, h } = view;
  if (w / h < aspect) { const nw = h * aspect; x -= (nw - w) / 2; w = nw; } else { const nh = w / aspect; y -= (nh - h) / 2; h = nh; }
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) { fitPending = true; return; }   // a degenerate layout pass: fit again later
  svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
}

/**
 * The part of the stage the chrome leaves clear (the planner's rule: frame the model inside the area not covered by
 * panels). The inspector's column is always kept free on a wide window, so selecting an element never moves the view.
 */
export function safeRect(hr) {
  const box = sel => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return b.width && b.height ? b : null; };
  let left = hr.left, right = hr.right, top = hr.top, bottom = hr.bottom;
  const lib = box('#ws-lib'), tools = box('#ws-tools'), dock = box('#ws-dock'), insp = box('#ws-insp');
  if (lib && lib.right < hr.left + hr.width / 2) left = Math.max(left, lib.right + 16);
  if (insp) right = Math.min(right, insp.left - 16);
  else if (hr.width >= 1024) right = Math.min(right, hr.right - 360);   // the desktop layout: the inspector's column stays clear
  if (tools && tools.bottom < hr.top + hr.height / 2) top = Math.max(top, tools.bottom + 14);
  if (dock && dock.top > hr.top + hr.height / 2) bottom = Math.min(bottom, dock.top - 44);
  if (right - left < 200 || bottom - top < 140) return hr;
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

export function fit() {
  const size = currentSize();
  // fit the plate into the clear area between the floating panels, not the whole stage
  const W = size.w * (state.wall ? 2.4 : 1) + 24, H = size.h * (state.wall ? 2.4 : 1) + 36;
  const hr = host.getBoundingClientRect();
  if (!hr.width || !hr.height) { fitPending = true; return; }   // hidden (another tab is showing): fit when shown
  const mr = safeRect(hr);
  const availW = Math.max(100, mr.width - 24), availH = Math.max(100, mr.height - 24);
  const scale = Math.min(availW / W, availH / H);
  const mcx = mr.left + mr.width / 2 - hr.left, mcy = mr.top + mr.height / 2 - hr.top;
  view = { x: -mcx / scale, y: -mcy / scale, w: hr.width / scale, h: hr.height / scale };
  fitPending = false; userFramed = false;
  applyView();
  render();
}

/** Convert a pointer event to plate mm (y up). */
function toMm(ev) {
  const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  return [p.x, -p.y];
}

export function render() {
  if (!svg) return;
  const size = currentSize();
  const b = getBuild(size.id);
  const checks = b.checks || ensureChecks(size.id);
  const issues = (checks?.checks || []).filter(c => (c.st === 'fail' || c.st === 'warn') && c.geo?.at);
  root.innerHTML = stageContent(b.built, state.design, colorHex, {
    selectedId: state.selectedId, interactive: true, wall: state.wall, grid: state.grid, dims: state.dims,
    issues: state.issues ? issues : [], highlight: state.highlight, pxPerMm: pxPerMm(), guides: state.guides,
  });
  root.__issues = issues;
  drawPen();
  if (fitPending) fit();
}

/** The pen's marks only (a drawing in progress follows the pointer without redrawing the plate). */
function drawPen() {
  if (!penLayer) return;
  penLayer.innerHTML = penOverlay(pxPerMm());
  svg.classList.toggle('pen-on', penActive());
}

export function initStage2d(el) {
  host = el;
  svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('xmlns', NS);
  root = document.createElementNS(NS, 'g');
  root.setAttribute('transform', 'scale(1,-1)');
  svg.appendChild(root);
  penLayer = document.createElementNS(NS, 'g');
  penLayer.setAttribute('transform', 'scale(1,-1)');
  svg.appendChild(penLayer);
  host.appendChild(svg);

  let drag = null;
  svg.addEventListener('pointerdown', ev => {
    if (ev.button !== 0 && ev.button !== 1) return;
    // the pen first: while drawing it takes every press; on a selected drawing, its points and handles
    if (penDown(ev, toMm(ev), pxPerMm())) { drag = { kind: 'pen' }; svg.setPointerCapture(ev.pointerId); return; }
    const target = ev.target.closest?.('[data-el], .iss');
    const [mx, my] = toMm(ev);
    if (target?.classList.contains('iss')) {
      const c = root.__issues?.[+target.dataset.check];
      if (c) emit('open-check', c);
      return;
    }
    if (ev.button === 0 && target?.dataset.el) {
      const id = target.dataset.el;
      const master = state.design.elements.find(e => e.id === id), size = currentSize();
      // the element as this size has it (its own values, formulas worked out): where it is, what it spans
      const elm = master ? elementOn(master, size) : null;
      select(id);
      // a combine or an outline moves whole: everything it is built from moves by the same amount
      if (elm && (elm.kind === 'combine' || elm.kind === 'offset')) {
        const movers = movablePieces(master, state.design).map(m => {
          const mm = elementOn(m, size);
          return { el: m, x0: mm.x || 0, y0: mm.y || 0, fixedX: spansWidth(mm), flush: !!flushEdge(mm) };
        });
        if (movers.length) {
          const built = getBuild(size.id).built;
          const own = [...built.layers.filter(L => L.elementId === id && !L.twin).map(L => L.poly), ...built.solids.filter(s => s.elementId === id && !s.twin).map(s => s.footprint)];
          const bb = own.length ? P.bbox(P.union(...own)) : null;
          const ref = bb ? [(bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2] : [mx, my];
          const box = bb ? { x0: bb.x0 - ref[0], x1: bb.x1 - ref[0], y0: bb.y0 - ref[1], y1: bb.y1 - ref[1] } : { x0: 0, x1: 0, y0: 0, y1: 0 };
          // nothing that moves with it offers a line to snap to: the pieces, and anything built from them (an outline
          // of a piece, another combine sharing one), whose edges are where they were when the drag began
          const skip = new Set([id, ...movers.map(m => m.el.id)]);
          for (const e of state.design.elements) if (movers.some(m => usesElement(e, m.el, state.design))) skip.add(e.id);
          drag = { kind: 'group', size, movers, ref, box, mx, my, moved: false, lines: snapLines(built, state.design, skip) };
          svg.setPointerCapture(ev.pointerId);
        }
        return;
      }
      // (a full-width grip only moves up and down, and not at all when it is flush with an edge)
      if (elm && elm.kind !== 'pattern' && !(elm.kind === 'surface' && elm.region !== 'shape') && !(spansWidth(elm) && flushEdge(elm))) {
        // dragging a symmetry twin moves the original the other way, so the twin follows the pointer
        const sign = target.dataset.twin ? -1 : 1;
        const built = getBuild(size.id).built;
        const own = [...built.layers.filter(L => L.elementId === id && !L.twin).map(L => L.poly), ...built.solids.filter(s => s.elementId === id && !s.twin).map(s => s.footprint), ...(built.ghosts || []).filter(g => g.elementId === id && !g.twin).map(g => g.poly)];
        const bb = own.length ? P.bbox(P.union(...own)) : null;
        // (an element flush with an edge slides along it only: its offset across the edge is worked out per size)
        const [cx, cy] = elementCentre(elm, size.w, size.h);
        const ax = cx - (elm.x || 0), ay = cy - (elm.y || 0);
        const box = bb ? { x0: bb.x0 - cx, x1: bb.x1 - cx, y0: bb.y0 - cy, y1: bb.y1 - cy } : { x0: 0, x1: 0, y0: 0, y1: 0 };
        drag = { kind: 'move', el: master, size, x0: elm.x || 0, y0: elm.y || 0, mx, my, moved: false, sign, ax, ay, box, flush: !!flushEdge(elm), fixedX: spansWidth(elm), lines: snapLines(built, state.design, id) };
        svg.setPointerCapture(ev.pointerId);
      }
      return;
    }
    if (!target) {
      if (ev.button === 0 && !ev.shiftKey && ev.target === svg) select(null);
      drag = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, view: { ...view } };
      svg.classList.add('panning');
      svg.setPointerCapture(ev.pointerId);
    }
  });
  svg.addEventListener('pointermove', ev => {
    if (!drag) { if (penActive()) penMove(ev, toMm(ev), pxPerMm()); return; }
    if (drag.kind === 'pen') { penMove(ev, toMm(ev), pxPerMm()); return; }
    if (drag.kind === 'pan') {
      const r = host.getBoundingClientRect();
      const vb = svg.viewBox.baseVal;
      const sc = vb.width / r.width;
      userFramed = true;
      view.x = drag.view.x - (ev.clientX - drag.sx) * sc;
      view.y = drag.view.y - (ev.clientY - drag.sy) * sc;
      applyView();
    } else if (drag.kind === 'move') {
      const [mx, my] = toMm(ev);
      const dx = mx - drag.mx, dy = my - drag.my;
      if (!drag.moved && Math.hypot(dx, dy) < 0.3) return;
      drag.moved = true;
      const grid = ev.shiftKey ? 1 : 0.25;
      // the element's centre if it followed the pointer exactly, then magnetic snapping to the plate's obvious
      // lines and the other elements (Alt holds it off), then the grid on any axis that did not snap
      const want = [drag.ax + drag.x0 + (drag.fixedX ? 0 : dx * drag.sign), drag.ay + drag.y0 + (drag.flush ? 0 : dy)];
      const tol = 7 / pxPerMm();
      let res;
      if (ev.altKey) res = { x: null, y: null, guides: [] };
      else if (drag.sign < 0) {
        // the twin is what is under the pointer: snap it in its own mirrored place, then reflect back to the original
        const r = snapMove([-want[0], want[1]], { x0: -drag.box.x1, x1: -drag.box.x0, y0: drag.box.y0, y1: drag.box.y1 }, drag.lines, tol);
        res = { x: r.x == null ? null : -r.x, y: r.y, guides: r.guides };
      } else res = snapMove(want, drag.box, drag.lines, tol);
      // for every size, or for this one only, as the inspector's switch says (a dragged formula becomes a number). An
      // axis the pointer has not moved along and nothing snapped is left as it was: not rounded to the grid, and a
      // formula or a size's own value on it stays
      const nx = res.x != null ? +(res.x - drag.ax).toFixed(3) : dx === 0 ? drag.x0 : Math.round((drag.x0 + dx * drag.sign) / grid) * grid;
      const ny = res.y != null ? +(res.y - drag.ay).toFixed(3) : dy === 0 ? drag.y0 : Math.round((drag.y0 + dy) / grid) * grid;
      if (!drag.fixedX && nx !== (valueOn(drag.el, 'x', drag.size) || 0)) setOn(drag.el, 'x', nx, drag.size, state.scope);
      if (!drag.flush && ny !== (valueOn(drag.el, 'y', drag.size) || 0)) setOn(drag.el, 'y', ny, drag.size, state.scope);
      state.guides = res.guides;
      preview();
    } else if (drag.kind === 'group') {
      const [mx, my] = toMm(ev);
      const dx = mx - drag.mx, dy = my - drag.my;
      if (!drag.moved && Math.hypot(dx, dy) < 0.3) return;
      drag.moved = true;
      const grid = ev.shiftKey ? 1 : 0.25, tol = 7 / pxPerMm();
      // the whole thing snaps by its box, as one element does; an axis that did not snap moves by whole grid steps
      // (so each piece keeps its own place on the grid relative to the rest), and one the pointer has not moved along
      // stays put
      const res = ev.altKey ? { x: null, y: null, guides: [] } : snapMove([drag.ref[0] + dx, drag.ref[1] + dy], drag.box, drag.lines, tol);
      const ddx = res.x != null ? res.x - drag.ref[0] : dx === 0 ? 0 : Math.round(dx / grid) * grid;
      const ddy = res.y != null ? res.y - drag.ref[1] : dy === 0 ? 0 : Math.round(dy / grid) * grid;
      for (const m of drag.movers) {
        const nx = +(m.x0 + ddx).toFixed(3), ny = +(m.y0 + ddy).toFixed(3);
        if (!m.fixedX && nx !== (valueOn(m.el, 'x', drag.size) || 0)) setOn(m.el, 'x', nx, drag.size, state.scope);
        if (!m.flush && ny !== (valueOn(m.el, 'y', drag.size) || 0)) setOn(m.el, 'y', ny, drag.size, state.scope);
      }
      state.guides = res.guides;
      preview();
    }
  });
  const endDrag = ev => {
    if (!drag) return;
    if (drag.kind === 'pen') { drag = null; penUp(); return; }
    if ((drag.kind === 'move' || drag.kind === 'group') && drag.moved) { state.guides = []; commit('Move'); }
    drag = null;
    svg.classList.remove('panning');
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('wheel', ev => {
    ev.preventDefault();
    const r = host.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const k = Math.exp(ev.deltaY * 0.0015);
    const fx = (ev.clientX - r.left) / r.width, fy = (ev.clientY - r.top) / r.height;
    const nx = vb.x + fx * vb.width * (1 - k), ny = vb.y + fy * vb.height * (1 - k);
    view = { x: nx, y: ny, w: vb.width * k, h: vb.height * k };
    userFramed = true;
    applyView();
    render();   // text and markers are sized in screen pixels
  }, { passive: false });
  // (a press captures the pointer, so the double-click arrives at the svg itself: what is under the pointer is
  // looked up, so a point or the line of a drawing can be double-clicked)
  svg.addEventListener('dblclick', ev => {
    const hit = document.elementFromPoint(ev.clientX, ev.clientY) || ev.target;
    if (penDblClick(hit, toMm(ev))) return;
    if (hit === svg && !penActive()) fit();
  });
  new ResizeObserver(() => { if (userFramed) applyView(); else fit(); }).observe(host);

  on('design', () => render());
  on('select', () => render());
  on('checks', ({ sizeId }) => { if (sizeId === currentSize().id) render(); });
  on('size', () => { fitPending = true; render(); });
  on('view', () => { render(); });
  on('highlight', () => render());
  on('pen', () => drawPen());
  render();
}
