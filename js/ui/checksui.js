// The dock (the planner's Build Dock): the print-check status, the size and its dimensions, and the primary action.
// The status opens the check card above the dock, the planner's issue card: each check, the problems first, and a
// click points at the place on the plate.

import { state, on, emit, currentSize, getBuild, ensureChecks, select, commit } from '../state.js';
import { SIZES, sizeToken } from '../data/sizes.js';
import { h } from './controls.js';
import { icon } from './icons.js';

let els = {};

function statusOf(res) {
  if (!res) return { cls: 'loading', label: 'Checking' };
  const c = res.counts;
  if (res.status === 'fail') return { cls: 'fail', label: `${c.fail} problem${c.fail === 1 ? '' : 's'}` };
  if (res.status === 'warn') return { cls: 'warn', label: `${c.warn} warning${c.warn === 1 ? '' : 's'}` };
  return { cls: '', label: 'Checks pass' };
}

/** A size's checks if they have run for this version of the design, without building it. */
function readyChecks(id) { const b = state.builds.get(id); return b && b.version === state.version ? b.checks : null; }

/**
 * All sizes and Export download every ticked size, so the dock speaks for all of them: how many are checked, how
 * many need a look, and a card listing those sizes with what is wrong; a click opens that size in Design. Sizes are
 * only read here, never built: those views run the checks themselves.
 */
function renderBatch() {
  const ids = SIZES.filter(s => state.design.sizes.enabled.includes(s.id)).map(s => s.id), n = ids.length;
  const done = ids.map(id => [id, readyChecks(id)]).filter(([, r]) => r);
  const fail = done.filter(([, r]) => r.status === 'fail'), warn = done.filter(([, r]) => r.status === 'warn');
  const st = !n ? { cls: 'loading', label: 'No sizes ticked' }
    : done.length < n ? { cls: 'loading', label: `Checking ${done.length} of ${n}` }
      : fail.length ? { cls: 'fail', label: `${fail.length} of ${n} with problems` }
        : warn.length ? { cls: 'warn', label: `${warn.length} of ${n} with warnings` }
          : { cls: '', label: n === 1 ? 'Checks pass' : `All ${n} pass the checks` };
  els.status.className = `status ${st.cls}`.trim();
  els.label.textContent = st.label;
  els.size.textContent = n === 1 ? sizeToken(ids[0]) : `${n} sizes`;
  els.dims.parentElement.hidden = true;
  els.sub.textContent = `${n} ticked size${n === 1 ? '' : 's'}${done.length < n ? ` · ${done.length} checked` : ''}`;
  els.list.innerHTML = '';
  const flagged = [...fail, ...warn];
  if (!flagged.length) els.list.append(h('p', { class: 'hint', text: !n ? 'No sizes are ticked for download.' : done.length < n ? 'Checking the ticked sizes…' : 'Every ticked size passes the checks.' }));
  const many = (k, word) => (k ? `${k} ${word}${k === 1 ? '' : 's'}` : '');
  for (const [id, r] of flagged) {
    // problems first, then warnings: a size with both shows both
    const fails = r.checks.filter(c => c.st === 'fail'), warns = r.checks.filter(c => c.st === 'warn');
    const open = () => { if (state.design.sizes.current !== id) { state.design.sizes.current = id; commit('Size'); emit('size'); } emit('goto', 'design'); setIssuesOpen(true); render(); };
    els.list.append(h('button', { class: `chk ${r.status}`, type: 'button', title: `Open ${sizeToken(id)} in Design`, onclick: open },
      [h('span', { class: 'ic' }, [icon(r.status === 'fail' ? 'x-circle' : 'warning', { size: 18, fill: true })]),
        h('span', {}, [h('div', { class: 'lbl', text: `${sizeToken(id)} · ${[many(fails.length, 'problem'), many(warns.length, 'warning')].filter(Boolean).join(', ')}` }), h('div', { class: 'det', text: [...new Set([...fails, ...warns].map(c => c.lbl))].join(' · ') })])]));
  }
}

export function render() {
  if (state.view && state.view !== 'design') return renderBatch();
  const size = currentSize();
  const res = getBuild(size.id).checks || ensureChecks(size.id);
  const st = statusOf(res);
  els.status.className = `status ${st.cls}`.trim();
  els.label.textContent = st.label;
  els.size.textContent = sizeToken(size.id);
  els.dims.parentElement.hidden = false;
  els.dims.textContent = `${size.w} × ${size.h}`;
  els.sub.textContent = `${sizeToken(size.id)} · ${res ? `${res.checks.length} checks` : 'checking'}`;
  els.list.innerHTML = '';
  if (!res) { els.list.append(h('p', { class: 'hint', text: 'Checking this size…' })); return; }
  const pinned = res.checks.filter(c => (c.st === 'fail' || c.st === 'warn') && c.geo?.at);
  for (const c of res.checks) {
    const n = pinned.indexOf(c);
    const ic = n >= 0 ? h('span', { class: 'num-badge', text: String(n + 1) })
      : icon(c.st === 'fail' ? 'x-circle' : c.st === 'warn' ? 'warning' : c.st === 'info' ? 'info' : 'check', { size: 18, fill: c.st === 'fail' || c.st === 'warn' });
    const row = h('button', { class: `chk ${c.st}`, type: 'button', onclick: () => focusCheck(c, row) },
      [h('span', { class: 'ic' }, [ic]), h('span', {}, [h('div', { class: 'lbl', text: c.lbl }), h('div', { class: 'det', text: c.det })])]);
    els.list.append(row);
  }
}

function focusCheck(c, row) {
  if (c.elementId) select(c.elementId);
  state.highlight = c.geo?.at ? { at: c.geo.at, st: c.st } : null;
  emit('highlight');
  els.list.querySelectorAll('.chk').forEach(r => r.classList.remove('hl'));
  if (row) { row.classList.add('hl'); row.scrollIntoView({ block: 'nearest' }); }
}

export function setIssuesOpen(open) {
  els.card.hidden = !open;
  els.status.setAttribute('aria-expanded', String(open));
  emit('issues', open);
}

export function initChecksUI(doc) {
  const $ = s => doc.querySelector(s);
  els = { status: $('#dockStatus'), label: $('#stLabel'), size: $('#dockSize'), dims: $('#dockDims'), card: $('#ws-issues'), list: $('#checkList'), sub: $('#issuesSub') };
  els.status.addEventListener('click', () => setIssuesOpen(els.card.hidden));
  $('#btnIssuesClose').addEventListener('click', () => setIssuesOpen(false));
  on('design', ({ preview: live } = {}) => { if (!live) render(); });
  on('checks', ({ sizeId }) => { if (sizeId === currentSize().id || state.view !== 'design') render(); });
  on('size', () => render());
  on('workspace', () => render());
  on('open-check', c => {
    setIssuesOpen(true); render();
    const i = (getBuild(currentSize().id).checks?.checks || []).indexOf(c);
    focusCheck(c, i >= 0 ? els.list.children[i] : null);
  });
  render();
}
