// The left library (the planner's 304 px panel): Elements (add, and the stack, top prints last), Style (the whole
// design), and Sizes (the 18 faceplates drawn to scale, as the planner's size grid draws its units).

import { state, on, commit, select, getBuild, ensureChecks, colorHex, emit } from '../state.js';
import { newElement, ELEMENT_DEFS, handleMount, flushOp, patternOp, isShapedBody, OUTLINE_KINDS, combinePieces } from '../geometry/face.js';
import { PATTERNS } from '../geometry/patterns.js';
import { LIP_PRESET } from '../geometry/grips.js';
import { SIZES, SIZE_BY_ID, sizeToken } from '../data/sizes.js';
import { h, panelRenderer } from './controls.js';
import { icon } from './icons.js';
import { elementGlyph } from './glyphs.js';
import { thumbnailSvg } from './render2d.js';
import { summary, deleteSelected, duplicateSelected, moveSelected } from './actions.js';
import { initStylePane } from './stylepane.js';

let root, elList, sizeGrid, counts = {}, drawElements, drawSizes;
const PX_PER_MM = 0.16;   // the planner's size tiles: one scale for both axes, so 1W is 14 px and 1H 9 px
const ORDER = SIZES.slice().sort((a, b) => (a.hCells - b.hCells) || (a.wCells - b.wCells));   // rows by height, as the planner lists them

function elementIssue(el) {
  const checks = state.builds.get(state.design.sizes.current)?.checks?.checks || [];
  const mine = checks.filter(c => c.elementId === el.id && (c.st === 'fail' || c.st === 'warn'));
  return mine.find(c => c.st === 'fail') || mine[0] || null;
}

export function renderElements() { drawElements?.(); }

function buildElements() {
  const els = state.design.elements;
  elList.innerHTML = '';
  counts.el.textContent = els.length;
  if (!els.length) {
    elList.append(h('li', { class: 'stack-empty', text: 'An empty face. Add a pattern, a shape, text, a picture, a solid block, a grip, SVG art or a sculpted mesh above.' }));
  }
  // the pieces a combine uses print as part of it: their rows say so
  const usedBy = new Map();
  for (const c of els) if (c.kind === 'combine') for (const p of combinePieces(c, state.design)) if (!usedBy.has(p.id)) usedBy.set(p.id, c);
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i];
    const on = el.id === state.selectedId, off = el.visible === false;
    const eye = h('button', { class: 'eye', type: 'button', title: off ? 'Show' : 'Hide', 'aria-label': off ? 'Show' : 'Hide', onclick: ev => { ev.stopPropagation(); el.visible = off; commit('Visibility'); } }, [icon(off ? 'eye-slash' : 'eye', { size: 16 })]);
    const gl = h('span', { class: 'gl well' }); gl.innerHTML = elementGlyph(el, state.design, colorHex, 34, 34);
    const iss = elementIssue(el);
    const tail = iss ? h('span', { class: `issue${iss.st === 'fail' ? ' fail' : ''}`, title: iss.lbl }, [icon('warning', { size: 16, fill: true })])
      : (el.kind === 'svg' ? h('span') : h('span', { class: 'sw', style: `background:${colorHex(el.color)}`, title: 'Colour' }));
    const li = h('li', { class: `key${on ? ' on' : ''}${off ? ' off' : ''}`, 'data-k': `el:${el.id}`, 'aria-selected': String(on), tabindex: '0', title: ELEMENT_DEFS[el.kind].label },
      [eye, gl, h('div', { style: 'min-width:0' }, [h('div', { class: 'name', text: el.name }), h('div', { class: 'sub', text: usedBy.has(el.id) ? `in ${usedBy.get(el.id).name} · ${summary(el)}` : summary(el) })]), tail]);
    if (usedBy.has(el.id)) li.classList.add('used');
    li.addEventListener('click', () => select(el.id));
    li.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(el.id); } });
    elList.append(li);
  }
  const has = !!state.selectedId;
  for (const id of ['btnElUp', 'btnElDown', 'btnElDup', 'btnElDel']) root.querySelector(`#${id}`).disabled = !has;
}

function includeToggle(s, enabled) {
  return h('button', { class: `inc${enabled ? ' on' : ''}`, type: 'button', title: enabled ? 'Included in Download all: click to leave out' : 'Left out of Download all: click to include', 'aria-label': `Export ${sizeToken(s.id)}`, 'aria-pressed': String(enabled), onclick: ev => {
    ev.stopPropagation();
    const d = state.design;
    d.sizes.enabled = enabled ? d.sizes.enabled.filter(id => id !== s.id) : SIZES.filter(x => x.id === s.id || d.sizes.enabled.includes(x.id)).map(x => x.id);
    commit('Sizes');
  } }, [h('span', { class: 'box' }, enabled ? [icon('check', { size: 10 })] : [])]);
}

export function renderSizes() { drawSizes?.(); }

function buildSizes() {
  const d = state.design;
  sizeGrid.innerHTML = '';
  counts.size.textContent = `${d.sizes.enabled.length}/${SIZES.length}`;
  for (const s of ORDER) {
    const enabled = d.sizes.enabled.includes(s.id), current = s.id === d.sizes.current;
    const st = state.builds.get(s.id)?.checks?.status || '';
    const holder = h('span', { class: 'holder' });
    holder.innerHTML = thumbnailSvg(getBuild(s.id).built, d, colorHex, Math.max(8, s.w * PX_PER_MM + 2), Math.max(6, s.h * PX_PER_MM + 2));
    const tile = h('button', { class: `size key${current ? ' on' : ''}${enabled ? '' : ' out'}`, type: 'button', 'data-k': `size:${s.id}`, title: `${sizeToken(s.id)} · ${s.w} × ${s.h} mm${st ? ` · print check: ${st === 'pass' ? 'OK' : st}` : ''}`, 'aria-pressed': String(current), onclick: () => {
      if (d.sizes.current !== s.id) { d.sizes.current = s.id; commit('Size'); emit('size'); }
    } }, [includeToggle(s, enabled), h('span', { class: `st ${st}` }), holder, h('span', { class: 'cap', text: sizeToken(s.id) })]);
    sizeGrid.append(tile);
  }
  const cur = SIZE_BY_ID[d.sizes.current];
  root.querySelector('#sizeReadout').textContent = `${sizeToken(cur.id)} · ${cur.w} × ${cur.h} mm · ${d.sizes.enabled.length} of ${SIZES.length} in Download all`;
}

/** Run the checks for every enabled size, one after another, updating the dots as they land. */
export function checkAllSizes() {
  const ids = state.design.sizes.enabled.slice();
  const step = () => { const id = ids.shift(); if (!id) return; if (!ensureChecks(id, 0)) { const off = on('checks', e => { if (e.sizeId === id) { off(); step(); } }); } else step(); };
  step();
}

function showPane(name) {
  root.querySelectorAll('[data-ltab]').forEach(b => { const on = b.dataset.ltab === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
  root.querySelectorAll('[data-lpane]').forEach(p => p.hidden = p.dataset.lpane !== name);
  if (name === 'sizes') { renderSizes(); checkAllSizes(); }
}

export function initLeftPanel(el) {
  root = el;
  elList = root.querySelector('#elList'); sizeGrid = root.querySelector('#sizeGrid');
  drawElements = panelRenderer(elList, buildElements); drawSizes = panelRenderer(sizeGrid, buildSizes);
  counts = { el: root.querySelector('#elCount'), size: root.querySelector('#sizeCount') };
  root.querySelectorAll('[data-ltab]').forEach(b => b.addEventListener('click', () => showPane(b.dataset.ltab)));
  root.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => {
    const kind = b.dataset.add;
    const elm = newElement(kind);
    if (kind === 'grip' && b.dataset.preset === 'lip') Object.assign(elm, LIP_PRESET);
    if (kind === 'pattern') elm.name = PATTERNS[elm.pattern].label;
    if (kind === 'grip') {
      elm.y = -Math.min(10, state.design.sizes.current.endsWith('05H') ? 4 : 10);
      state.design.mode = 'up';
      // a built-in grip replaces the bolt-on handle (the series' rule), so its two screw holes close
      if (handleMount(state.design) === 'pair') { state.design.handles.mount = 'none'; state.design.handles.holes = false; emit('toast', 'Screw holes closed: the grip is the handle now. Handle in its card turns them back on.'); }
    }
    if (kind === 'solid') state.design.mode = 'up';
    if (kind === 'surface') {
      // it textures the selected flat element if there is one, the whole face otherwise; and it prints face up
      const sel = state.design.elements.find(e => e.id === state.selectedId);
      if (sel && (['shape', 'text', 'svg', 'image'].includes(sel.kind) || (sel.kind === 'path' && !isShapedBody(sel)))) { elm.region = 'element'; elm.target = sel.id; elm.name = `${sel.name} texture`; }
      if (state.design.mode !== 'up') { state.design.mode = 'up'; emit('toast', 'Switched to Face Up: a 3D texture cannot lie flat on the bed.'); }
    }
    // text and shapes inlay on a face-down design (a raise would leave the face hanging off the bed) and stand proud
    // on a face-up one; patterns cut grooves there instead, in one filament like the series' face-down plates
    if (kind === 'text' || kind === 'shape') elm.op = flushOp(state.design);
    if (kind === 'pattern') elm.op = patternOp(state.design);
    // a combine starts from the selected element (it takes that one's place, and how it is built); an outline
    // follows the selected element, under it in the stack so that one prints over it, in another colour
    const sel = state.design.elements.find(e => e.id === state.selectedId);
    const from = sel && OUTLINE_KINDS.has(sel.kind) ? sel : null;
    let at = state.design.elements.length;
    if (kind === 'combine' || kind === 'offset') {
      elm.op = from?.op === 'cut' || from?.op === 'inlay' || from?.op === 'raise' ? from.op : flushOp(state.design);
      if (from) for (const k of ['height', 'depth']) if (typeof from[k] === 'number') elm[k] = from[k];
    }
    if (kind === 'combine') {
      if (from) { elm.parts = [from.id]; elm.color = from.color || elm.color; elm.name = `${from.name} combined`; at = state.design.elements.indexOf(from) + 1; }
      emit('toast', from ? `Combining ${from.name}: tick the other pieces in its card.` : 'Tick the pieces to combine in its card.');
    }
    if (kind === 'offset') {
      if (from) {
        elm.source = from.id; elm.name = `Outline of ${from.name}`; at = state.design.elements.indexOf(from);
        // a colour that shows: neither the backer's, the face's nor the one it follows (the face's as a last resort)
        const other = state.design.colors.find(c => c.id !== 'backer' && c.id !== from.color && c.id !== state.design.face.color) || state.design.colors.find(c => c.id !== 'backer' && c.id !== from.color);
        if (other) elm.color = other.id;
      } else emit('toast', 'Pick what it follows in its card.');
    }
    state.design.elements.splice(at, 0, elm);
    commit(`Add ${b.dataset.preset === 'lip' ? 'lip pull' : ELEMENT_DEFS[kind].label}`);
    select(elm.id);
  }));
  root.querySelector('#btnElUp').addEventListener('click', () => moveSelected(1));
  root.querySelector('#btnElDown').addEventListener('click', () => moveSelected(-1));
  root.querySelector('#btnElDup').addEventListener('click', duplicateSelected);
  root.querySelector('#btnElDel').addEventListener('click', deleteSelected);
  root.querySelector('#btnSizesAll').addEventListener('click', () => { state.design.sizes.enabled = SIZES.map(s => s.id); commit('Sizes'); });
  root.querySelector('#btnSizesOne').addEventListener('click', () => { state.design.sizes.enabled = [state.design.sizes.current]; commit('Sizes'); });
  root.querySelector('#btnCheckAll').addEventListener('click', checkAllSizes);
  initStylePane(root.querySelector('#stylePane'));
  const sizesShown = () => !root.querySelector('[data-lpane="sizes"]').hidden;
  on('design', ({ preview: live } = {}) => { renderElements(); if (sizesShown() && !live) renderSizes(); });
  on('select', () => renderElements());
  on('checks', () => { renderElements(); if (sizesShown()) renderSizes(); });
  on('size', () => { if (sizesShown()) renderSizes(); });
  renderElements();
}

export { deleteSelected };
