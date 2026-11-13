// The filament picker for a colour slot: the planner's catalogue (js/data/filament-db.js, copied verbatim) grouped by
// product line, a search box, and a custom colour for anything the list does not have. TPU is left out: the planner
// lists it for the feet only, and a faceplate is not printed in it.

import { FILAMENT_DB } from '../data/filament-db.js';
import { h } from './controls.js';

const LINES = FILAMENT_DB.filter(b => !/TPU/i.test(b.line));
export const FILAMENTS = LINES.flatMap(b => b.colors.map(c => ({ label: c.label, name: c.name, hex: c.hex, url: c.url || b.url, brand: b.brand, line: b.line, finish: c.finish || null, translucent: c.translucent || null })));
const BY_LABEL = new Map(FILAMENTS.map(f => [f.label, f]));

/** The catalogue entry a slot names, or null for a custom colour (or a filament that has left the catalogue). */
export const filamentByLabel = label => (label && BY_LABEL.get(label)) || null;

let open = null;

export function closeFilamentPicker() {
  if (!open) return;
  open.menu.remove();
  document.removeEventListener('pointerdown', open.outside, true);
  document.removeEventListener('keydown', open.key, true);
  open = null;
}

/**
 * Open the picker beside `anchor` for a colour slot ({ hex, filament }). onPick receives { filament, hex } for a
 * catalogue filament, or { hex } for a custom colour.
 */
export function openFilamentPicker(anchor, slot, onPick) {
  closeFilamentPicker();
  const menu = h('div', { class: 'fmenu glass', role: 'dialog', 'aria-label': 'Choose a filament' });
  const search = h('input', { class: 'field', type: 'search', placeholder: 'Search filaments', 'aria-label': 'Search filaments' });
  const list = h('div', { class: 'flist' });
  const custom = h('input', { type: 'color', 'aria-label': 'Custom colour' });
  custom.value = /^#[0-9a-f]{6}$/i.test(slot.hex) ? slot.hex : '#888888';
  custom.addEventListener('change', () => { const hex = custom.value; closeFilamentPicker(); onPick({ hex }); });
  const pick = c => { closeFilamentPicker(); onPick({ filament: c.label, hex: c.hex }); };

  const render = () => {
    const q = search.value.trim().toLowerCase();
    list.replaceChildren();
    for (const b of LINES) {
      const rows = b.colors.filter(c => !q || `${b.brand} ${b.line} ${c.label}`.toLowerCase().includes(q));
      if (!rows.length) continue;
      list.append(h('div', { class: 'fline', text: `${b.brand} · ${b.line.replace(/™/g, '')}` }));
      for (const c of rows) {
        const on = slot.filament === c.label;
        list.append(h('button', { class: `frow${on ? ' on' : ''}`, type: 'button', 'aria-pressed': String(on), title: c.label, onclick: () => pick(c) }, [
          h('span', { class: 'sw', style: `--c:${c.hex}` }),
          h('span', { class: 'nm', text: c.name }),
          c.finish ? h('span', { class: 'tag', text: c.finish }) : c.translucent ? h('span', { class: 'tag', text: 'translucent' }) : null,
        ]));
      }
    }
    if (!list.children.length) list.append(h('p', { class: 'empty', text: 'No filament matches. Pick a custom colour below.' }));
  };
  search.addEventListener('input', render);
  search.addEventListener('keydown', ev => { if (ev.key === 'Enter') { const first = list.querySelector('.frow'); if (first) first.click(); } });
  menu.append(search, list, h('label', { class: 'fcustom' }, [custom, h('span', { text: 'Custom colour' }), h('small', { text: 'for a filament the list does not have' })]));
  render();
  document.body.append(menu);

  // beside the panel the swatch sits in (not over it), kept inside the window
  const a = anchor.getBoundingClientRect(), m = menu.getBoundingClientRect();
  const side = (anchor.closest('aside') || anchor).getBoundingClientRect();
  const left = side.right + 10 + m.width <= innerWidth - 8 ? side.right + 10 : Math.max(8, side.left - 10 - m.width);
  const top = Math.max(8, Math.min(a.top - 12, innerHeight - m.height - 8));
  menu.style.left = `${left}px`; menu.style.top = `${top}px`;

  const outside = ev => { if (!menu.contains(ev.target) && !anchor.contains(ev.target)) closeFilamentPicker(); };
  const key = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); closeFilamentPicker(); anchor.focus?.(); } };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key, true);
  open = { menu, outside, key };
  list.querySelector('.frow.on')?.scrollIntoView({ block: 'center' });
  search.focus({ preventScroll: true });
}
