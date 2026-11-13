// All sizes: one card per faceplate with the design drawn on it, its print check, and whether Download all takes it.

import { state, on, commit, emit, getBuild, ensureChecks, colorHex } from '../state.js';
import { thumbnailSvg } from './render2d.js';
import { SIZES, sizeLabel, sizeToken } from '../data/sizes.js';
import { checkAllSizes } from './leftpanel.js';
import { h, panelRenderer } from './controls.js';
import { icon } from './icons.js';

let grid, draw, visible = false, dirty = true;
const ORDER = SIZES.slice().sort((a, b) => (a.hCells - b.hCells) || (a.wCells - b.wCells));

/** A mark on a size that changes settings for itself (variants.js): how many, and on which elements. */
function ownChanges(d, s) {
  const by = d.elements.map(e => [e, Object.keys(e.bySize?.[s.id] || {}).length]).filter(([, n]) => n);
  if (!by.length) return null;
  const n = by.reduce((a, [, k]) => a + k, 0);
  return h('span', { class: 'own', title: `Its own ${n === 1 ? 'value' : 'values'} for ${by.map(([e]) => e.name).join(', ')}`, text: `${n} own` });
}

function pill(st) {
  return st ? h('span', { class: `pill ${st}`, text: st === 'pass' ? 'Checks pass' : st === 'warn' ? 'Warning' : 'Problem' }) : h('span', { class: 'pill wait', text: 'Checking' });
}

export function renderSizesView() {
  if (!visible) { dirty = true; return; }
  dirty = false;
  draw();
}

function buildCards() {
  const d = state.design;
  grid.innerHTML = '';
  for (const s of ORDER) {
    const enabled = d.sizes.enabled.includes(s.id);
    const b = getBuild(s.id);
    const st = b.checks?.status;
    const img = h('button', { class: 'img well', type: 'button', title: `Open ${sizeToken(s.id)} in Design`, onclick: () => { d.sizes.current = s.id; commit('Size'); emit('size'); emit('goto', 'design'); } });
    img.innerHTML = thumbnailSvg(b.built, d, colorHex, 220, 108);
    const inc = h('button', { class: 'key sm inc', type: 'button', 'aria-pressed': String(enabled), title: enabled ? 'In Download all' : 'Left out of Download all', onclick: () => {
      d.sizes.enabled = enabled ? d.sizes.enabled.filter(id => id !== s.id) : SIZES.filter(x => x.id === s.id || d.sizes.enabled.includes(x.id)).map(x => x.id);
      commit('Sizes');
    } }, [icon(enabled ? 'check' : 'plus', { size: 14 }), enabled ? 'Exporting' : 'Add']);
    const first = st ? (b.checks.checks.find(c => c.st === 'fail' || c.st === 'warn')?.short || 'all checks pass') : '';
    grid.append(h('div', { class: `card key${enabled ? '' : ' out'}`, 'data-k': `card:${s.id}` }, [img, h('div', { class: 'cbody' }, [
      h('div', { class: 'ctop' }, [h('span', { class: 'tok', text: sizeToken(s.id) }), ownChanges(d, s), inc]),
      h('div', { class: 'cdim', text: `${sizeLabel(s)} · ${s.w} × ${s.h} mm` }),
      h('div', { class: 'cst' }, [pill(st), h('span', { text: first })]),
    ])]));
    if (enabled && !st) ensureChecks(s.id, 50);
  }
}

export function setSizesVisible(v) { visible = v; if (v && dirty) renderSizesView(); if (v) checkAllSizes(); }

export function initSizesView(root) {
  grid = root.querySelector('#sizeCards');
  draw = panelRenderer(grid, buildCards);
  root.querySelector('#btnSizesRefresh').addEventListener('click', () => { state.builds.clear(); state.version++; renderSizesView(); checkAllSizes(); });
  on('design', ({ preview: live } = {}) => { if (!live) renderSizesView(); else dirty = true; });
  on('checks', () => renderSizesView());
}
