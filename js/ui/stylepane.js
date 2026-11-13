// The library's Style tab: everything that applies to the whole design and every size (the planner's Build style:
// "Applies to every unit"). How it prints, the face slab, how the drawer is pulled, symmetry, and the colour slots,
// each a filament from the planner's catalogue, that become extruders.

import { state, on, commit, preview } from '../state.js';
import { h, prow, numberCtl, segCtl, boolCtl, swatchCtl, panelRenderer } from './controls.js';
import { icon } from './icons.js';
import { handleMount, faceOn } from '../geometry/face.js';
import { openFilamentPicker, filamentByLabel, FILAMENTS } from './filamentpicker.js';
import { disclosureFor, relFor } from './shoplinks.js';

let root, draw;

function sect(title, kids, extra) {
  return h('section', {}, [extra ? h('div', { class: 'h2row' }, [h('span', { class: 'h2', text: title }), extra]) : h('div', { class: 'h2', text: title }), ...kids]);
}

const MOUNT_HELP = {
  pair: 'Two M3 holes, 44 mm apart, for the bolt-on handles.',
  knob: 'One hole on the handle line for a knob. The knob also needs a reworked backer that is not made yet, so the checks flag it until then.',
  none: 'No holes: the face covers them. Use it when a grip or a block is the handle.',
};

/** The handle mount switch, shared with a grip's card. */
export function mountCtl(key = 'mount') {
  const d = state.design;
  return segCtl(handleMount(d), [['pair', 'Bolt-on'], ['knob', 'Knob'], ['none', 'None']], v => { d.handles.mount = v; d.handles.holes = v === 'pair'; commit('Handle'); }, key);
}
export const mountHelp = () => MOUNT_HELP[handleMount(state.design)];

function colourRows() {
  const d = state.design;
  const list = h('div', { class: 'colors' });
  const shops = [];
  d.colors.forEach((c, i) => {
    const f = filamentByLabel(c.filament);
    const sw = h('button', { class: 'fsw', type: 'button', style: `--c:${c.hex}`, title: 'Choose a filament', 'aria-label': `Choose the filament for slot ${i + 1}`, 'data-k': `col${i}` });
    sw.addEventListener('click', () => openFilamentPicker(sw, c, pick => {
      c.hex = pick.hex;
      if (pick.filament) { c.filament = pick.filament; c.name = pick.filament; }
      else { if (c.filament) c.name = `Custom colour ${i + 1}`; delete c.filament; }
      commit('Filament');
    }));
    let label;
    if (c.filament) {
      label = h('div', { class: 'fname', title: c.filament }, [h('div', { class: 'n', text: f ? f.name : c.filament }), h('div', { class: 'l', text: f ? `${f.brand} · ${f.line.replace(/™/g, '')}${f.finish ? ` · ${f.finish}` : ''}` : 'not in the planner\'s list any more' })]);
    } else {
      label = h('input', { class: 'field', type: 'text', maxlength: '40', 'aria-label': 'Colour name', 'data-k': `cname${i}` });
      label.value = c.name;
      label.addEventListener('change', () => { c.name = label.value.trim() || `Colour ${i + 1}`; commit('Colour name'); });
    }
    const shop = f?.url ? h('a', { class: 'x shop', href: f.url, target: '_blank', rel: relFor(f.url), title: `Shop ${f.label}`, 'aria-label': `Shop ${f.label}` }, [icon('arrow-square-out', { size: 14 })]) : h('span');
    if (f?.url) shops.push(f.url);
    const del = h('button', { class: 'x', type: 'button', 'data-k': `cdel${i}`, title: c.id === 'backer' ? 'The backer always prints' : 'Remove this colour', 'aria-label': 'Remove', disabled: c.id === 'backer' || d.colors.length <= 2, onclick: () => {
      const fallback = d.colors.find(x => x.id !== c.id && x.id !== 'backer')?.id || 'backer';
      if (d.face.color === c.id) d.face.color = fallback;
      for (const el of d.elements) { if (el.color === c.id) el.color = fallback; if (el.groups) for (const g of el.groups) if (g.color === c.id) g.color = fallback; }
      d.colors = d.colors.filter(x => x !== c);
      commit('Remove colour');
    } }, [icon('x', { size: 14 })]);
    list.append(h('div', { class: 'crow key' }, [sw, label, h('span', { class: 'badge', title: `Extruder ${i + 1}`, text: `T${i + 1}` }), shop, del]));
  });
  return { list, disclosure: disclosureFor(shops) };
}

function build() {
  const d = state.design;
  root.innerHTML = '';
  root.append(h('p', { class: 'intro', text: 'Applies to the whole design, on every size.' }));

  const modeHint = d.mode === 'down'
    ? 'The decorated face prints on the bed for the cleanest finish, like the Essential and Chevron plates. Cuts and grooves only; recesses are bridged.'
    : 'The backer prints on the bed. Raised relief, grips, blocks and meshes are fine; overhangs and unsupported features are flagged.';
  root.append(sect('Prints', [
    segCtl(d.mode, [['down', 'Face down', 'arrow-line-down'], ['up', 'Face up', 'arrow-line-up']], v => { d.mode = v; commit('Mode'); }, 'mode'),
    h('p', { class: 'hint', text: modeHint }),
  ]));

  const on = faceOn(d);
  root.append(sect('Face', [
    prow('Essential face', boolCtl(on, v => { d.face.enabled = v; commit(v ? 'Face on' : 'Face off'); }, 'faceon'), on ? 'The face slab the Essential plate wears. Switch it off to design straight on the backer.' : 'Off: the bare backer is the clean slate. Everything stands on it, nothing can be cut, and the two screw holes in the backer stay open.'),
    on ? prow('Thickness', numberCtl(d.face.thickness, { min: 0.4, max: 4, step: 0.1, default: 2, unit: 'mm', label: 'Face thickness' }, v => { d.face.thickness = v; preview(); }, v => { d.face.thickness = v; commit('Face thickness'); }, 'thick'), 'Essential 0.8 · Chevron 2. Cuts go this deep, never into the backer.') : null,
    on ? prow('Colour', swatchCtl(d.face.color, v => { d.face.color = v; commit('Face colour'); }, 'facecol')) : null,
  ]));

  const mount = handleMount(d);
  root.append(sect('Handle', [
    prow('Mount', mountCtl(), mountHelp()),
    mount === 'knob' ? prow('Knob hole', numberCtl(d.handles.knobD ?? 3.2, { min: 2, max: 10, step: 0.1, default: 3.2, unit: 'mm', label: 'Knob hole diameter' }, v => { d.handles.knobD = v; preview(); }, v => { d.handles.knobD = v; commit('Knob hole'); }, 'knobd')) : null,
  ]));

  root.append(sect('Symmetry', [
    prow('Mirror left to right', boolCtl(d.symmetry === 'x', v => { d.symmetry = v ? 'x' : 'off'; commit('Symmetry'); }, 'sym'), 'Every shape, block, grip, mesh and piece of art gets a twin across the centre line. Patterns already cover the plate.'),
  ]));

  const add = h('button', { class: 'key sm', type: 'button', 'data-k': 'addcol', disabled: d.colors.length >= 8, onclick: () => {
    const used = new Set(d.colors.map(c => c.filament));
    const next = ['Panchroma Aqua Blue', 'Panchroma Red', 'Panchroma Silk Silver', 'Panchroma Green', 'Panchroma Purple', 'Printed Solid Mystery Orange', 'Panchroma Yellow']
      .map(filamentByLabel).find(f => f && !used.has(f.label)) || FILAMENTS.find(f => !used.has(f.label));
    d.colors.push({ id: `c${Date.now().toString(36)}`, name: next.label, hex: next.hex, filament: next.label });
    commit('Add colour');
  } }, [icon('plus', { size: 14 }), 'Add colour']);
  const { list, disclosure } = colourRows();
  root.append(sect('Colours', [list, h('div', { style: 'display:flex;justify-content:flex-start;margin-top:8px' }, [add]),
    h('p', { class: 'hint', text: 'Each colour is a filament from the planner\'s list and an extruder, in this order. The backer is always T1. Up to 8. Click a swatch to change it.' }),
    disclosure ? h('p', { class: 'hint disclose', text: disclosure }) : null,
  ], h('span', { class: 'badge', text: `${d.colors.length}/8` })));
}

export function render() { draw?.(); }

export function initStylePane(el) {
  root = el;
  draw = panelRenderer(root, build);
  on('design', ({ preview: live } = {}) => { if (!live) render(); });
  render();
}
