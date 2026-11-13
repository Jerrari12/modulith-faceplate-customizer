// The version history panel (js/history.js): every kept version of the open design, newest first, grouped by day.
// Pick one to see it drawn, then bring it back (one undo step), open it as a copy, save it as a design file, keep it
// under a name, or delete it. The picker at the top reaches the history of any design this browser has held, even
// one since removed from the list, so nothing kept here is out of reach.

import { state, on, emit, lineage, restoreVersion, saveVersion } from '../state.js';
import { history, HISTORY_KINDS } from '../history.js';
import { parseDesign } from '../export/design.js';
import { buildFace } from '../geometry/face.js';
import { designOn } from '../variants.js';
import { ensureFonts } from '../geometry/text.js';
import { thumbnailSvg } from './render2d.js';
import { SIZE_BY_ID, SIZES, sizeToken } from '../data/sizes.js';
import { h } from './controls.js';
import { icon } from './icons.js';

let root = null, showing = null, picked = null, refreshTimer = 0, previewTicket = 0;

const clock = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function dayLabel(t) {
  const d = new Date(t), today = new Date(), y = new Date(today); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
const when = v => `${dayLabel(v.end)}, ${v.end - v.start > 60e3 ? `${clock(v.start)} to ${clock(v.end)}` : clock(v.end)}`;
/** What a version is called in the list: its name, the file it went out as, or the edits it holds. */
function titleOf(v) {
  if (v.kind === 'saved' && v.label) return v.label;
  if (v.kind === 'download') return v.label || 'Downloaded';
  if (v.note) return v.note;
  const a = (v.actions || []).filter(x => x && x !== 'Edit');
  if (!a.length) return v.edits > 1 ? `${v.edits} edits` : 'Autosave';
  return a.length > 3 ? `${a.slice(-3).join(', ')} and ${a.length - 3} more` : a.join(', ');
}
const metaOf = v => [`${v.elements} element${v.elements === 1 ? '' : 's'}`, v.mode === 'up' ? 'face up' : 'face down', v.edits > 1 && v.kind === 'auto' ? `${v.edits} edits` : ''].filter(Boolean).join(' · ');
const kb = n => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

/** Save a version's design file as it is (not through downloadBlob, which would note the open design instead). */
function saveFile(json, name) {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const slug = s => (String(s || 'faceplate').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'faceplate');
const stamp = t => { const d = new Date(t), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };

export function initHistoryView(el) {
  root = el;
  on('history', () => { if (!root.hidden && showing === lineage()) { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => render(false), 250); } });
}
export const historyOpen = () => !!root && !root.hidden;
export function closeHistory() { if (root) { root.hidden = true; picked = null; } }

/** Open the panel on the open design's history (or `which`, another lineage). */
export async function openHistory(which = null) {
  showing = which || lineage();
  picked = null;
  root.hidden = false;
  await render(true);
}

async function render(full) {
  const mine = lineage(), here = showing === mine;
  let versions = [], lineages = [];
  try { [versions, lineages] = await Promise.all([history.list(showing), history.lineages()]); }
  catch (e) { root.replaceChildren(h('div', { class: 'ihead' }, [h('h3', { text: 'Version history' })]), h('p', { class: 'hint', text: `This browser could not read its version history: ${e.message}` })); return; }

  // the picker: this design first, then every other design this browser holds a history for
  const pick = h('select', { class: 'field', 'aria-label': 'Whose history', 'data-k': 'which' });
  pick.append(h('option', { value: mine, text: `This design: ${state.design.name}` }));
  for (const l of lineages) if (l.lineage !== mine) pick.append(h('option', { value: l.lineage, text: `${l.name} (${l.count}, ${dayLabel(l.end)})` }));
  pick.value = showing;
  pick.addEventListener('change', () => { showing = pick.value; picked = null; render(true); });

  const head = h('div', { class: 'ihead' }, [h('h3', { id: 'hiTitle', text: 'Version history' }), pick, h('span', { class: 'spacer' }),
    h('button', { class: 'x', type: 'button', 'aria-label': 'Close', onclick: closeHistory }, [icon('x', { size: 18 })])]);

  const list = h('div', { class: 'hilist', role: 'listbox', 'aria-label': 'Versions' });
  if (!versions.length) list.append(h('p', { class: 'hint', text: here ? 'Nothing kept yet. Every change you make is kept here, folded into 10-minute steps.' : 'No versions.' }));
  let day = '';
  for (const v of versions) {
    const d = dayLabel(v.end);
    if (d !== day) { day = d; list.append(h('div', { class: 'h2', text: d })); }
    const row = h('button', { class: `hirow${picked === v.id ? ' on' : ''}`, type: 'button', role: 'option', 'aria-selected': String(picked === v.id), 'data-id': String(v.id), onclick: () => { picked = v.id; render(false); } }, [
      h('span', { class: `hikind k-${v.kind}`, text: HISTORY_KINDS[v.kind] || v.kind }),
      h('span', { class: 'hitext' }, [h('b', { text: titleOf(v) }), h('small', { text: `${v.end - v.start > 60e3 ? `${clock(v.start)} to ${clock(v.end)}` : clock(v.end)} · ${metaOf(v)}` })]),
    ]);
    list.append(row);
  }

  const view = h('div', { class: 'hiview' });
  const v = versions.find(x => x.id === picked);
  if (!v) view.append(h('p', { class: 'hint', text: versions.length ? 'Pick a version to see it and bring it back.' : '' }));
  else fillView(view, v, here);

  // keep the open design under a name, now; and what is kept, and how
  const foot = h('div', { class: 'hifoot' });
  if (here) {
    const name = h('input', { class: 'field', type: 'text', maxlength: '120', placeholder: 'Name this version (optional)', 'aria-label': 'Version name', 'data-k': 'vname' });
    const save = async () => { await saveVersion(name.value); name.value = ''; emit('toast', `Saved a version of "${state.design.name}". It is kept until you delete it.`); render(false); };
    name.addEventListener('keydown', ev => { if (ev.key === 'Enter') save(); });
    foot.append(h('div', { class: 'hisave' }, [name, h('button', { class: 'key sm', type: 'button', 'data-k': 'savever', onclick: save }, [icon('download-simple', { size: 14 }), 'Save this version'])]));
  }
  const note = h('p', { class: 'hint', text: 'Every change is kept in this browser, in 10-minute steps; after two weeks one a day, after three months one a week. Saved and downloaded versions stay until you delete them. Ctrl+S saves one.' });
  foot.append(note);
  if (history.backend === 'memory') foot.append(h('p', { class: 'hint warn', text: 'This browser would not keep the history on disk, so it lasts until the page closes. Save design files to keep versions.' }));
  else globalThis.navigator?.storage?.estimate?.().then(e => { if (e && e.usage != null) note.append(` This site uses ${kb(e.usage)} of the browser's storage.`); }).catch(() => {});

  if (full) root.replaceChildren(head, h('div', { class: 'hibody' }, [list, view]), foot);
  else {
    root.querySelector('.ihead')?.replaceWith(head);
    root.querySelector('.hilist')?.replaceWith(list);
    root.querySelector('.hiview')?.replaceWith(view);
    root.querySelector('.hifoot')?.replaceWith(foot);
  }
}

/** One version: drawn as it was (built on demand, on its own current size), what it holds, and what can be done. */
function fillView(view, v, here) {
  const pic = h('div', { class: 'hipic well' }, [h('span', { class: 'hint', text: 'Drawing it...' })]);
  const what = [h('b', { text: titleOf(v) }), h('small', { text: `${when(v)} · ${metaOf(v)}` })];
  if (v.kind === 'auto' && (v.actions || []).length > 3) what.push(h('small', { text: `Edits: ${v.actions.join(', ')}` }));
  if (v.kind === 'download') what.push(h('small', { text: 'The design exactly as it was when this file was downloaded.' }));
  const acts = h('div', { class: 'hiacts' });
  view.append(pic, h('div', { class: 'hiwhat' }, what), acts);

  const ticket = ++previewTicket;
  history.get(v.id).then(async full => {
    if (!full || ticket !== previewTicket) return;
    let design;
    try { design = parseDesign(full.json); } catch (e) { pic.replaceChildren(h('span', { class: 'hint', text: `This version could not be read: ${e.message}` })); return; }
    // the actions, once the version's file is in hand
    const restore = h('button', { class: 'key sm on', type: 'button', 'data-k': 'restore', onclick: async () => {
      const note = `Brought back the version of ${when(v)}`;
      await restoreVersion(full.json, note);
      closeHistory();
      emit('toast', `${note}. Ctrl+Z goes back to what was open.`);
    } }, [icon('arrow-counter-clockwise', { size: 14 }), 'Bring this version back']);
    const copy = h('button', { class: 'key sm', type: 'button', 'data-k': 'copy', onclick: () => {
      const d = parseDesign(full.json);
      d.name = `${d.name} (${dayLabel(v.end).toLowerCase()} ${clock(v.end)})`.slice(0, 120);
      closeHistory();
      emit('openDesign', { design: d, done: `Opened a copy of the version of ${when(v)}` });
    } }, [icon('copy', { size: 14 }), 'Open as a copy']);
    const file = h('button', { class: 'key sm', type: 'button', 'data-k': 'file', onclick: async () => {
      const name = `${slug(full.name)}-${stamp(v.end)}.faceplate.json`;
      saveFile(full.json, name);
      // like every download, the design it holds is kept until deleted (Sol 01a1cb9b)
      await history.record(showing, full.json, { kind: 'download', label: name }).catch(e => console.warn('version history: not kept', e));
      render(false);
    } }, [icon('download-simple', { size: 14 }), 'Save design file']);
    const del = h('button', { class: 'key sm danger', type: 'button', 'data-k': 'delete', onclick: async () => {
      if (v.kind !== 'auto' && !confirm(`Delete "${titleOf(v)}" from this browser's version history? This cannot be undone.`)) return;
      await history.remove(v.id); picked = null; render(false);
    } }, [icon('trash', { size: 14 }), 'Delete']);
    acts.replaceChildren(...(here ? [restore] : []), copy, file, del);
    if (v.kind === 'auto') {
      const name = h('input', { class: 'field', type: 'text', maxlength: '120', placeholder: 'Keep it as...', 'aria-label': 'Name for this version' });
      const keep = async () => { await history.keep(v.id, name.value.trim() || `Kept ${when(v)}`); render(false); };
      name.addEventListener('keydown', ev => { if (ev.key === 'Enter') keep(); });
      acts.append(h('div', { class: 'hisave' }, [name, h('button', { class: 'key sm', type: 'button', 'data-k': 'keep', onclick: keep }, ['Keep'])]));
    }
    // the drawing: the version's own current size, built once it has its fonts
    try {
      await ensureFonts(design);
      if (ticket !== previewTicket) return;
      const size = SIZE_BY_ID[design.sizes.current] || SIZES[6];
      const built = buildFace(designOn(design, size), size);
      const hex = id => (design.colors.find(c => c.id === id) || {}).hex || '#888888';
      pic.innerHTML = thumbnailSvg(built, design, hex, 360, 190);
      pic.append(h('span', { class: 'hisize', text: sizeToken(size.id) }));
    } catch (e) { pic.replaceChildren(h('span', { class: 'hint', text: `Could not draw it: ${e.message}` })); }
  }).catch(e => { pic.replaceChildren(h('span', { class: 'hint', text: `This version could not be read: ${e.message}` })); });
}
