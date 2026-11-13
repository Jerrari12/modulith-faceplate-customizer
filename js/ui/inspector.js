// The right inspector: THIS ELEMENT ONLY (the planner's "This unit only" card). It appears when an element is
// selected and hugs its content: the element's glyph and name, its own print checks, a generated picker for its
// type, its settings, and Hide / Copy / Remove. Whole-design settings live in the library's Style tab.

import { state, on, emit, commit, preview, currentSize, getBuild, colorHex, selectedElement, select, prefs } from '../state.js';
import { ELEMENT_DEFS, SHAPES, GRIP_STYLES, SOLID_SHAPES, meshBody, elementParts, elementCentre, flushEdge, faceOn, gripSolids, meshSolids, solidSolids, isShapedBody, OUTLINE_KINDS, combinePieces, usesElement, COMBINE_OPS, OFFSET_BANDS } from '../geometry/face.js';
import { PATTERNS, patternDefaults } from '../geometry/patterns.js';
import * as P from '../geometry/polys.js';
import { h, prow, section, paramCtl, numberCtl, segCtl, swatchCtl, selectCtl, showIf, panelRenderer } from './controls.js';
import { elementGlyph, patternGlyph, shapeGlyph, gripGlyph, solidGlyph, fillGlyph, mapGlyph, pictureOfData } from './glyphs.js';
import { HEIGHT_MAPS, TEXTURE_PARAMS, textureDefaults } from '../geometry/heightmaps.js';
import { SURFACE_GRIDS } from '../geometry/surface.js';
import { styleStart, gripShape, sturdier, GRIP_STRENGTH, HOOD_STYLES } from '../geometry/grips.js';
import { imageFromRGBA, IMAGE_LIMITS } from '../geometry/image.js';
import { FILL_OPTIONS, isFilled, fillDefaults } from '../geometry/fill.js';
import { shade } from './render2d.js';
import { mountCtl, mountHelp } from './stylepane.js';
import { openTileEditor, tileSvg } from './tileeditor.js';
import { normTiles, portSet } from '../geometry/tiles.js';
import { linkedCells } from '../geometry/patterns.js';
import { FONTS, fontDef, textStroke } from '../geometry/text.js';
import { icon } from './icons.js';
import { deleteSelected, duplicateSelected, summary } from './actions.js';
import { viewOn, canOverride, sizesOverriding, resetOn } from '../variants.js';
import { sizeToken } from '../data/sizes.js';
import { chosenPoint, pointOnPlate, setPointOnPlate, togglePoint, deletePoint } from './pen.js';
import { PATH_FORMS, pathTaper, pathEdge } from '../geometry/path.js';

let root, draw;

function source(el) {
  const kind = ELEMENT_DEFS[el.kind].label;
  if (el.kind === 'grip') return `${kind} · ${(GRIP_STYLES.find(([v]) => v === el.style) || [, el.style])[1].replace(/ \(.*/, '')}`;
  if (el.kind === 'shape') return `${kind} · ${(SHAPES.find(([v]) => v === el.shape) || [, el.shape])[1]}`;
  if (el.kind === 'mesh') return `${kind} · ${el.base === 'in' ? 'replaces the face' : 'stands on the face'}`;
  if (el.kind === 'svg') return 'SVG art';
  if (el.kind === 'solid') return `${kind} · ${(SOLID_SHAPES.find(([v]) => v === el.shape) || [, el.shape])[1]}`;
  if (el.kind === 'text') { const f = fontDef(el.font); return `${kind} · ${f.label} ${f.style}`; }
  if (el.kind === 'image') return `${kind} · ${el.data?.w ?? 0} × ${el.data?.h ?? 0} px`;
  if (el.kind === 'surface') return `${kind} · ${(HEIGHT_MAPS.find(([k]) => k === el.map) || [, el.map])[1]}`;
  if (el.kind === 'combine') { const n = combinePieces(el, state.design).length; return `${kind} · ${(COMBINE_OPS.find(([k]) => k === el.operation) || [, 'Cut away'])[1].toLowerCase()} · ${n} piece${n === 1 ? '' : 's'}`; }
  if (el.kind === 'offset') { const src = state.design.elements.find(e => e.id === el.source && e !== el); return `${kind} · ${src ? `of ${src.name}` : 'follows nothing yet'}`; }
  if (el.kind === 'path') return `${kind} · ${(PATH_FORMS.find(([k]) => k === el.form) || [, 'Filled'])[1].toLowerCase()} · ${el.pts?.length || 0} points`;
  return kind;
}

const SLOTS = [['tl', 'Top left'], ['t', 'Top'], ['tr', 'Top right'], ['l', 'Left'], ['c', 'Centre'], ['r', 'Right'], ['bl', 'Bottom left'], ['b', 'Bottom'], ['br', 'Bottom right']];
const INSET = 3;   // mm in from the plate edge for an edge or corner slot

/** The element's extent around its centre on the current size, before it is clipped to the plate. */
function extentOf(el) {
  const size = currentSize(), t = getBuild(size.id).built.t;
  const vis = { ...el, visible: true };   // measured as if shown: the build leaves a hidden element out
  const bodies = el.kind === 'grip' ? gripSolids(vis, size, t) : el.kind === 'mesh' ? meshSolids(vis, size, t) : el.kind === 'solid' ? solidSolids(vis, size, t) : null;
  let polys = [];
  try { polys = bodies ? bodies.map(s => s.footprint) : elementParts(vis, size).map(p => p.poly).filter(p => p.length); } catch { polys = []; }   // text while its font loads
  const [cx, cy] = elementCentre(el, size.w, size.h);
  const b = polys.length ? P.bbox(P.union(...polys)) : null;
  return { size, box: b ? { x0: b.x0 - cx, x1: b.x1 - cx, y0: b.y0 - cy, y1: b.y1 - cy } : { x0: 0, x1: 0, y0: 0, y1: 0 } };
}

/**
 * Put an element in a slot: its anchor becomes the slot and its offset sets it INSET mm in from the edges the slot
 * names (centred on the others), so it keeps that place on every size. 'handle' centres it on the handle line.
 */
function placeAt(el, slot) {
  const { size, box } = extentOf(el);
  const midX = (box.x0 + box.x1) / 2, midY = (box.y0 + box.y1) / 2;
  if (slot === 'handle') {
    const hy = size.holes.reduce((s, q) => s + q.y, 0) / size.holes.length;
    el.anchor = 'c'; el.x = +(-midX).toFixed(2); el.y = +(hy - midY).toFixed(2);
  } else {
    el.anchor = slot;
    el.x = +(slot.includes('l') ? INSET - box.x0 : slot.includes('r') ? -INSET - box.x1 : -midX).toFixed(2);
    el.y = +(slot.includes('t') ? -INSET - box.y1 : slot.includes('b') ? INSET - box.y0 : -midY).toFixed(2);
  }
  commit('Place');
}

function slotCtl(el) {
  const grid = h('div', { class: 'slots', role: 'group', 'aria-label': 'Place on the plate', 'data-k': 'place' });
  for (const [s, label] of SLOTS) grid.append(h('button', { class: `slot${el.anchor === s ? ' on' : ''}`, type: 'button', title: label, 'aria-label': label, 'aria-pressed': String(el.anchor === s), onclick: () => placeAt(el, s) }, [h('span')]));
  const handle = h('button', { class: 'key sm', type: 'button', 'data-k': 'placeh', title: 'Centre it on the handle line, between the screw holes', onclick: () => placeAt(el, 'handle') }, [icon('target', { size: 14 }), 'Handle']);
  return h('div', { class: 'placectl' }, [grid, handle]);
}

/** What a block can sit on: the face (or the backer), or any earlier visible element with a top to stand on. */
function stackCtl(el) {
  const els = state.design.elements, idx = els.indexOf(el);
  const opts = [['', faceOn(state.design) ? 'The face' : 'The backer']];
  for (let i = idx - 1; i >= 0; i--) {
    const o = els[i];
    if (o.visible === false) continue;
    if (o.kind === 'solid' || o.kind === 'grip' || ((o.kind === 'shape' || o.kind === 'text') && o.op === 'raise') || o.kind === 'svg') opts.push([o.id, o.name]);
  }
  if (el.stackOn && !opts.some(([v]) => v === el.stackOn)) opts.push([el.stackOn, 'An element above it (stands on the face)']);
  return selectCtl(el.stackOn || '', opts, v => { el.stackOn = v; commit('Sits on'); }, 'stackOn');
}

function elementChecks(el) {
  const checks = getBuild(currentSize().id).checks?.checks || [];
  return checks.filter(c => c.elementId === el.id && (c.st === 'fail' || c.st === 'warn'));
}

/** A generated picker: one tile per option, the current one in orange (the planner's selected option). */
// which kinds of element have More settings open, remembered in this browser (a card redraws on every edit)
const moreOpen = new Set((() => { try { const v = prefs.get('moreOpen', []); return Array.isArray(v) ? v : []; } catch { return []; } })());

/** The fine-tuning settings, closed until asked for; its title says how many differ from where they start. */
function moreSection(kind, rows, changed) {
  const open = moreOpen.has(kind);
  const toggle = h('button', { class: 'more-toggle', type: 'button', 'data-k': 'more', 'aria-expanded': String(open), onclick: () => {
    if (open) moreOpen.delete(kind); else moreOpen.add(kind);
    prefs.set('moreOpen', [...moreOpen]);
    render();
  } }, [icon(open ? 'caret-up' : 'caret-down', { size: 14 }), h('span', { text: 'More settings' }), changed ? h('span', { class: 'more-count', text: `${changed} changed` }) : null]);
  return h('div', { class: `sect more${open ? ' open' : ''}` }, [toggle, ...(open ? rows : [])]);
}

function tiles(options, value, glyphOf, onPick, cols = 3, key = 'pick') {
  const grid = h('div', { class: `tiles${cols === 4 ? ' four' : ''}`, 'data-k': key });
  for (const [v, label] of options) {
    const b = h('button', { class: `key${v === value ? ' on' : ''}`, type: 'button', title: label, 'aria-pressed': String(v === value), onclick: () => { if (v !== value) onPick(v); } });
    b.innerHTML = glyphOf(v);
    b.append(label.replace(/ \(.*/, ''));
    grid.append(b);
  }
  return grid;
}

/** The picture as stored, beside a colour row for each tone (raised or inlaid ones print in their own slot). */
function toneRows(el) {
  const out = [];
  const d = el.data;
  if (d) {
    const c = h('canvas', { class: 'imgsrc', width: String(d.w), height: String(d.h), 'aria-hidden': 'true' });
    try {
      const g = Uint8Array.from(atob(d.g), ch => ch.charCodeAt(0)), px = c.getContext('2d').createImageData(d.w, d.h);
      for (let i = 0; i < g.length; i++) { px.data[4 * i] = px.data[4 * i + 1] = px.data[4 * i + 2] = g[i]; px.data[4 * i + 3] = 255; }
      c.getContext('2d').putImageData(px, 0, 0);
    } catch { /* a picture that will not decode just shows blank */ }
    const mm = (el.width / d.w).toFixed(2);
    out.push(h('div', { class: 'imgrow' }, [c, h('p', { class: 'hint', text: `${d.w} × ${d.h} px, ${mm} mm a pixel. Darker is ${el.op === 'cut' ? 'deeper' : el.op === 'inlay' ? 'a later tone' : 'higher'}${el.invert ? ' (inverted: lighter is)' : ''}.` })]));
  }
  if (el.op === 'raise' || el.op === 'inlay') {
    if (!Array.isArray(el.stepColors)) el.stepColors = [];
    const steps = Math.max(1, Math.min(6, Math.round(el.steps) || 1));
    for (let i = 0; i < steps; i++) {
      const label = steps === 1 ? 'Colour' : i === 0 ? 'Tone 1 (palest)' : i === steps - 1 ? `Tone ${i + 1} (darkest)` : `Tone ${i + 1}`;
      out.push(prow(label, swatchCtl(el.stepColors[i] || 'c2', v => { el.stepColors[i] = v; commit('Tone colour'); }, `tone${i}`)));
    }
  }
  return out;
}

/**
 * How sturdy a grip is where it meets the face (printed face up, a pull parts the layers there): its base width and
 * the stress a firm pull puts on it, and when it is thin, the smallest change that makes it sturdy.
 */
function strengthBox(el) {
  let st;
  try { st = gripShape(el).strength; } catch { return h('div'); }
  const bad = st.sigma > GRIP_STRENGTH.failMPa, thin = st.sigma > GRIP_STRENGTH.warnMPa;
  const mpa = Number.isFinite(st.sigma) ? st.sigma.toFixed(1) : '∞';
  const say = bad ? 'May snap off. ' : thin ? 'Thin at the base. ' : 'Sturdy. ';
  const body = `It stands on ${st.width.toFixed(1)} mm of face; a firm pull (about 10 kg) puts about ${mpa} MPa on the layers there${thin ? ' (printed layers part at roughly 15 to 30 MPa).' : '.'}`;
  const kids = [h('b', { text: say }), body];
  const fix = thin ? sturdier(el) : {};
  if (Object.keys(fix).length) {
    const what = Object.entries(fix).map(([k, v]) => `${{ undercut: 'undercut', depth: 'depth', legs: 'legs' }[k] || k} ${v} mm`).join(', ');
    kids.push(h('button', { class: 'key sm', type: 'button', 'data-k': 'sturdy', style: 'margin-top:8px', title: `Sets ${what}`, onclick: () => { Object.assign(el, fix); commit('Make it sturdy'); } }, [`Make it sturdy (${what})`]));
  }
  return h('div', { class: thin ? 'warnbox' : 'infobox', 'data-k': 'strength' }, kids);
}

/**
 * Flush with an edge, or not. Switching keeps the element where it is on the current size: on, its place along the
 * edge becomes Offset X; off, it is anchored to that edge with the offset that holds it there.
 */
function flushCtl(el, p) {
  return selectCtl(el.flush || '', p.options, v => {
    const size = currentSize(), [cx, cy] = elementCentre(el, size.w, size.h), was = flushEdge(el);
    if (v) el.x = +cx.toFixed(2);
    else if (was) {
      el.anchor = was; el.x = +cx.toFixed(2); el.y = +(cy - (was === 't' ? size.h / 2 : -size.h / 2)).toFixed(2);
      if (el.kind === 'grip') el.rotation = was === 'b' ? 180 : 0;
    }
    el.flush = v;
    commit('Flush');
  }, 'flush');
}

/**
 * A 3D texture's cell colours: up to three filaments besides its own, each cell (a stone, a brick, a scale) taking
 * one at random or by its height. Each colour is its own body in the download, so it prints in its own filament.
 */
function cellColourRows(el) {
  if (!Array.isArray(el.cellColors)) el.cellColors = [];
  const rows = [];
  el.cellColors.slice(0, 3).forEach((c, i) => {
    const del = h('button', { class: 'key sm', type: 'button', 'data-k': `cc${i}x`, title: 'Remove this colour', 'aria-label': 'Remove this colour', onclick: () => { el.cellColors.splice(i, 1); commit('Cell colours'); } }, [icon('x', { size: 14 })]);
    rows.push(prow(`Colour ${i + 2}`, h('div', { style: 'display:flex;gap:6px;align-items:center' }, [swatchCtl(c, v => { el.cellColors[i] = v; commit('Cell colour'); }, `cc${i}`), del])));
  });
  if (el.cellColors.length < 3) {
    // the next palette colour not yet on this texture
    const used = new Set([el.color, ...el.cellColors]);
    const next = (state.design.colors.find(c => c.id !== 'backer' && !used.has(c.id)) || { id: 'c3' }).id;
    rows.push(h('button', { class: 'key sm', type: 'button', 'data-k': 'ccadd', onclick: () => { el.cellColors.push(next); commit('Cell colours'); } }, [icon('plus', { size: 14 }), el.cellColors.length ? 'Add another colour' : 'Give the cells more colours']));
  }
  if (el.cellColors.length) rows.push(prow('Colour by', segCtl(el.colorMode === 'height' ? 'height' : 'random', [['random', 'Random'], ['height', 'Height']], v => { el.colorMode = v; commit('Colour by'); }, 'colorMode'), 'Random scatters the colours over the cells; Height gives the lowest cells the first colour and the highest the last. A smooth texture is coloured in height bands.'));
  return rows;
}

/** What a 3D texture can take its outline from: any flat element but itself (and other textures). */
function targetCtl(el) {
  const opts = [['', 'Choose an element']];
  // (a tapered drawing is a body, which a texture leaves alone, so only a flat one)
  for (const o of state.design.elements) if (o !== el && (['shape', 'text', 'svg', 'image', 'pattern'].includes(o.kind) || (['path', 'combine', 'offset'].includes(o.kind) && !isShapedBody(o)))) opts.push([o.id, o.name]);
  if (el.target && !opts.some(([v]) => v === el.target)) opts.push([el.target, 'An element that is gone']);
  return selectCtl(el.target || '', opts, v => { el.target = v; commit('Texture area'); }, 'target');
}

/** The picture a picture height map uses: choose one (kept as greyscale in the design), with a small preview. */
function pictureCtl(el) {
  const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/bmp', style: 'display:none' });
  input.addEventListener('change', async () => {
    const f = input.files[0]; input.value = ''; if (!f) return;
    try {
      const bmp = await createImageBitmap(f);
      const k = Math.min(1, IMAGE_LIMITS.maxSide / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * k)), hh = Math.max(1, Math.round(bmp.height * k));
      const c = document.createElement('canvas'); c.width = w; c.height = hh;
      const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(bmp, 0, 0, w, hh); bmp.close?.();
      if (!state.design.elements.includes(el)) return;          // the element went while the picture was reading
      el.data = imageFromRGBA(ctx.getImageData(0, 0, w, hh).data, w, hh);
      commit('Texture picture');
    } catch (e) { alert(`Could not read ${f.name}: ${e.message}`); }
  });
  const btn = h('button', { class: 'key sm', type: 'button', 'data-k': 'pickpic', onclick: () => input.click() }, [icon('image', { size: 14 }), el.data ? 'Choose another picture' : 'Choose a picture']);
  const note = h('p', { class: 'hint', text: el.data ? `${el.data.w} × ${el.data.h} px, kept in the design. White is high; Invert flips it.` : 'A greyscale height map: white is high, black low. It is kept in the design file.' });
  return h('div', { class: 'sect' }, [h('div', { class: 'imgrow' }, [btn, note]), input]);
}

/** The fill picker (solid, outline, or a texture drawn by its own generator), then the border and the texture's
 *  own settings. Picking a texture starts it from its defaults. */
/**
 * A 3D texture's card says what its numbers come to on this size: how high the whole thing stands, and the grid it
 * is really meshed on (a big area gets a coarser one; the download is built from the same mesh as the preview).
 */
function surfaceHelp(el, p) {
  const mm = v => `${+v.toFixed(2)} mm`;
  const num = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  if (p.key === 'base') return `${p.help} It stands up to ${mm(num(el.base, 0, 10, 0.4) + num(el.depth, 0.1, 5, 0.6))} above the face: base plus texture height.`;
  if (p.key !== 'detail') return p.help;
  const bodies = getBuild(currentSize().id).built.solids.filter(s => s.elementId === el.id && s.kind === 'surface' && s.grid > 0);
  if (!bodies.length) return p.help;
  const key = el.detail in SURFACE_GRIDS ? el.detail : 'normal', asked = SURFACE_GRIDS[key], g = Math.max(...bodies.map(s => s.grid));
  const name = (p.options.find(([k]) => k === key) || [, key])[1];
  return g > asked + 1e-6
    ? `The area is big on this size, so ${name} (${mm(asked)}) becomes a ${mm(g)} grid to stay quick, in the preview and the download alike. A smaller area or plate keeps the finer grid.`
    : `${name} is a ${mm(asked)} grid, used as it is on this size, in the preview and the download alike.${key === 'fine' ? ' It makes bigger files.' : ` Fine (${mm(SURFACE_GRIDS.fine)}) is smoother and makes bigger files.`}`;
}

/** A tapered block's ratio, said in millimetres: the base and the top it makes (solids.js's own clamps). */
/**
 * A combine's pieces: every element with an outline that would not go round in a circle, the ticked ones first in
 * their order (for Cut away, the first is what the others cut into), then the rest from the top of the stack down.
 */
function pieceRows(el) {
  const d = state.design, pieces = combinePieces(el, d), ids = pieces.map(p => p.id);
  const others = d.elements.filter(o => o !== el && OUTLINE_KINDS.has(o.kind) && !pieces.includes(o) && !usesElement(o, el, d)).reverse();
  const cut = el.operation !== 'join' && el.operation !== 'common';
  const hint = cut ? 'The first piece, with every other piece cut out of it.' : el.operation === 'join' ? 'All the pieces as one.' : 'Only where all the pieces overlap.';
  const out = [h('p', { class: 'hint', text: `${hint} The pieces stop printing on their own and show dashed on the drawing: drag a piece by its dashed edge, or the combine itself to move it whole.` })];
  if (!pieces.length && !others.length) { out.push(h('p', { class: 'hint', text: 'Add shapes, text or drawings to combine first.' })); return out; }
  const list = h('ul', { class: 'pieces' });
  const row = (o, k) => {
    const on = k >= 0;
    const tick = h('button', { class: `tick${on ? ' on' : ''}`, type: 'button', role: 'checkbox', 'aria-checked': String(on), 'data-k': `piece:${o.id}`, title: on ? 'Leave it out' : 'Use it',
      onclick: () => { el.parts = on ? ids.filter(id => id !== o.id) : [...ids, o.id]; commit(on ? 'Leave out a piece' : 'Add a piece'); } }, on ? [icon('check', { size: 12 })] : []);
    const shown = pieces.filter(p => p.visible !== false), j = shown.indexOf(o);
    const role = !on ? '' : o.visible === false ? 'hidden, left out' : cut ? (j === 0 ? 'cut into' : 'cuts') : 'in';
    const first = on && cut && j > 0 ? h('button', { class: 'key sm', type: 'button', 'data-k': `first:${o.id}`, title: 'Make it the piece the others cut into', onclick: () => { el.parts = [o.id, ...ids.filter(id => id !== o.id)]; commit('First piece'); } }, ['Make first']) : null;
    return h('li', { class: on ? 'on' : '' }, [tick, h('span', { class: 'nm', text: o.name }), role ? h('span', { class: 'role', text: role }) : null, first]);
  };
  pieces.forEach((o, k) => list.append(row(o, k)));
  others.forEach(o => list.append(row(o, -1)));
  out.push(list);
  return out;
}

/** What an outline follows: any element with an outline that does not itself follow or use this one. */
function followRows(el) {
  const d = state.design, opts = [['', 'Choose an element']];
  for (const o of d.elements) if (o !== el && OUTLINE_KINDS.has(o.kind) && !usesElement(o, el, d)) opts.push([o.id, o.name]);
  if (el.source && !opts.some(([v]) => v === el.source)) opts.push([el.source, 'An element that is gone']);
  return [prow('Follows', selectCtl(el.source || '', opts, v => { el.source = v; commit('Outline follows'); }, 'source'), 'It moves and changes with that element, on every size. Hide that element to keep the outline alone.')];
}

/** A drawing's top edge, as it comes out: held under the height, and a chamfer on a side already past 45° does nothing. */
function pathEdgeHelp(el, p) {
  const { edge, size } = pathEdge(el), h = Math.max(0.2, Number(el.height) || 1), kept = Math.min(size, 0.95 * h);
  if (edge === 'chamfer' && pathTaper(el) >= 45) return `${p.help} The sides already lean past 45°, so a chamfer has nothing to cut: round the edge instead.`;
  return kept < size - 1e-9 ? `${p.help} This one is held to ${+kept.toFixed(2)} mm, under the ${+h.toFixed(2)} mm height.` : p.help;
}

/** A drawing's taper, as it comes out: how far in from the drawn edge the top is. */
function pathTaperHelp(el, p) {
  const a = pathTaper(el);
  if (!(a > 0)) return p.help;
  const h = Math.max(0.2, Number(el.height) || 1), run = h * Math.tan(a * Math.PI / 180);
  return `${p.help} This one: the top stands ${+run.toFixed(2)} mm in from the drawn edge, ${+h.toFixed(2)} mm up.`;
}

/**
 * A drawing's points: what the pen does on the stage, and the chosen point's place typed in plate millimetres (on
 * the size shown), whether it is a corner or a curve, and removing it.
 */
function pointRows(el) {
  const n = el.pts?.length || 0, k = chosenPoint(el);
  const out = [h('p', { class: 'hint', text: `${n} point${n === 1 ? '' : 's'}. Drag a point or a handle on the drawing. Double-click a point to make it a corner or a curve, double-click the line to add a point.${k === null ? ' Click a point to type where it goes.' : ''}` })];
  if (k === null) return out;
  const p = el.pts[k], [X, Y] = pointOnPlate(el, k);
  const field = (v, label, key, set) => numberCtl(v, { min: -400, max: 400, step: 0.25, default: v, unit: 'mm', label }, x => { set(x); preview(); }, x => { set(x); commit('Point'); }, key);
  out.push(prow(`Point ${k + 1} X`, field(X, 'Point X', 'ptx', x => setPointOnPlate(el, k, x, pointOnPlate(el, k)[1])), "From the plate's centre, on the size shown."));
  out.push(prow(`Point ${k + 1} Y`, field(Y, 'Point Y', 'pty', y => setPointOnPlate(el, k, pointOnPlate(el, k)[0], y))));
  out.push(prow('Point is', segCtl(p.i || p.o ? 'curve' : 'corner', [['corner', 'Corner'], ['curve', 'Curve']], () => togglePoint(el, k), 'ptkind')));
  out.push(h('div', { class: 'actions' }, [h('button', { class: 'key', type: 'button', 'data-k': 'ptdel', onclick: () => deletePoint(el, k) }, [icon('trash', { size: 16 }), 'Remove point'])]));
  return out;
}

function taperHelp(el, p) {
  const t = Math.max(0.05, Math.min(1.5, el.taper ?? 0.6)), w = Math.max(0.5, el.w || 30), h = Math.max(0.5, el.h || 12);
  const f = v => +v.toFixed(1);
  return `${p.help} This one: base ${f(w)} × ${f(h)} mm, top ${f(w * t)} × ${f(h * t)} mm.`;
}

function fillRows(el, def, face, accent) {
  const out = [tiles(FILL_OPTIONS, isFilled(el) ? el.fill : 'solid', k => fillGlyph(k, face, accent, fillDefaults(k)), v => { el.fill = v; el.fillParams = fillDefaults(v); commit('Fill'); }, 4, 'fill')];
  if (!isFilled(el)) return out;
  const border = def.params.find(p => p.key === 'border');
  // an outline is the rim alone, so it says what the number measures for the fill picked
  const rim = el.fill === 'outline' ? ['Outline width', 'How thick the outline is. Two perimeters need 0.8 mm.'] : ['Border width', 'A solid rim round the texture, so the shape still reads.'];
  out.push(prow(rim[0], paramCtl(el, border), rim[1]));
  if (el.fill !== 'outline' && PATTERNS[el.fill]) {
    if (!el.fillParams || typeof el.fillParams !== 'object') el.fillParams = fillDefaults(el.fill);
    // the texture is anchored at the element's own centre, so the plate-anchor choice does not apply
    for (const p of PATTERNS[el.fill].params) if (p.key !== 'anchor' && showIf(p, el.fillParams)) out.push(prow(p.label, paramCtl(el.fillParams, p, 'fp.'), p.help));
  }
  return out;
}

function artLayers(el) {
  const list = h('div', { class: 'groups' });
  el.groups.forEach((g, i) => {
    const vis = g.visible !== false, op = g.op || 'raise';
    const eye = h('button', { class: 'key sm', type: 'button', 'data-k': `g${i}eye`, title: vis ? 'Hide this layer' : 'Show this layer', 'aria-label': vis ? 'Hide' : 'Show', onclick: () => { g.visible = !vis; commit('Art layer'); } }, [icon(vis ? 'eye' : 'eye-slash', { size: 14 })]);
    const top = h('div', { class: 'top' }, [eye, h('span', { class: 'fillsw', style: `background:${g.fill}` }), h('span', { class: 'gname', title: g.name, text: g.fill })]);
    const ctl = h('div', { class: 'ctl' }, [segCtl(op, [['raise', 'Raise'], ['cut', 'Cut'], ['inlay', 'Inlay']], v => { g.op = v; commit('Art layer'); }, `g${i}op`)]);
    if (op === 'raise') ctl.append(numberCtl(g.height ?? 1, { min: 0.2, max: 30, step: 0.1, default: 1, unit: 'mm', label: 'Stands out' }, v => { g.height = v; preview(); }, v => { g.height = v; commit('Art layer'); }, `g${i}h`));
    else ctl.append(numberCtl(g.depth ?? 0.6, { min: 0.2, max: 4, step: 0.1, default: 0.6, unit: 'mm', label: op === 'inlay' ? 'Inlay depth' : 'Cut depth' }, v => { g.depth = v; preview(); }, v => { g.depth = v; commit('Art layer'); }, `g${i}d`));
    // a raised or inlaid layer prints in a colour slot; a cut shows the face's own colour
    if (op !== 'cut') ctl.append(swatchCtl(g.color, v => { g.color = v; commit('Art colour'); }, `g${i}c`));
    list.append(h('div', { class: 'grow well' }, [top, ctl]));
  });
  return list;
}

/** The element's own failing and warning checks. Check text carries element names, which come from design files
 *  other people send: text nodes, never innerHTML. */
function fillChecks(box, el) {
  box.replaceChildren(...elementChecks(el).map(c => h('div', { class: c.st === 'fail' ? 'failbox' : 'warnbox' }, [h('b', { text: `${c.lbl}. ` }), c.det])));
}

function identUpdate() {
  const el = selectedElement();
  if (!el || root.hidden) return;
  const well = root.querySelector('.wellbox'), dims = root.querySelector('.dims');
  if (well) well.innerHTML = elementGlyph(el, state.design, colorHex, 88, 64);
  if (dims) dims.textContent = summary(el);
}

function build() {
  const el = selectedElement();
  root.hidden = !el || state.view !== 'design';
  if (root.hidden) { root.innerHTML = ''; return; }
  root.innerHTML = '';
  const els = state.design.elements, idx = els.length - els.indexOf(el);
  const def = ELEMENT_DEFS[el.kind];
  const face = colorHex(state.design.face.color), accent = colorHex(el.color);

  root.append(h('div', { class: 'head' }, [
    h('div', { class: 'h2', text: 'This element only' }),
    h('span', { class: 'idx', text: `${idx} of ${els.length}` }),
    h('button', { class: 'x', type: 'button', title: 'Deselect (Esc)', 'aria-label': 'Deselect', onclick: () => select(null) }, [icon('x', { size: 16 })]),
  ]));
  const title = h('input', { class: 'title', type: 'text', maxlength: '80', 'aria-label': 'Element name', 'data-k': 'name' });
  title.value = el.name;
  title.addEventListener('change', () => { el.name = title.value.trim() || def.label; commit('Rename'); });
  title.addEventListener('keydown', ev => { if (ev.key === 'Enter') title.blur(); });
  const well = h('div', { class: 'wellbox well' }); well.innerHTML = elementGlyph(el, state.design, colorHex, 88, 64);
  root.append(h('div', { class: 'ident' }, [well, h('div', { class: 'col' }, [title, h('div', { class: 'dims', text: summary(el) }), h('div', { class: 'src', text: source(el) })])]));

  if (el.visible === false) root.append(h('div', { class: 'infobox', html: '<b>Hidden.</b> It is left out of the plate, the checks and the export until you show it again.' }));
  const checksBox = h('div', { class: 'echecks' });
  fillChecks(checksBox, el);
  // a combine's piece: it prints as part of that combine
  const user = state.design.elements.find(c => c.kind === 'combine' && combinePieces(c, state.design).includes(el));
  root.append(checksBox);
  if (user) {
    root.append(h('div', { class: 'infobox' }, [h('b', { text: `Part of ${user.name}. ` }),
      'It prints as part of that combine, not on its own, so its operation, height and colour here are not used. It shows dashed on the drawing, where you drag it by its dashed edge. ',
      h('button', { class: 'key sm', type: 'button', 'data-k': 'opencombine', style: 'margin-top:8px', onclick: () => select(user.id) }, [`Open ${user.name}`])]));
  }
  if ((el.kind === 'grip' || el.kind === 'mesh') && state.design.mode !== 'up') {
    root.append(h('div', { class: 'warnbox' }, [h('b', { text: `${el.kind === 'mesh' ? 'Meshes' : 'Grips'} print face up. ` }), 'This design is set to print face down. ',
      h('button', { class: 'key sm', type: 'button', style: 'margin-top:8px', onclick: () => { state.design.mode = 'up'; commit('Mode'); } }, ['Print face up'])]));
  }
  if (isShapedBody(el) && state.design.mode !== 'up') {
    root.append(h('div', { class: 'warnbox' }, [h('b', { text: 'A drawing with a taper or a shaped top edge prints face up. ' }), 'This design is set to print face down. ',
      h('button', { class: 'key sm', type: 'button', style: 'margin-top:8px', onclick: () => { state.design.mode = 'up'; commit('Mode'); } }, ['Print face up'])]));
  }
  if (el.kind === 'mesh') {
    const b = meshBody(el);
    root.append(h('div', { class: 'infobox', html: b ? `<b>${b.triCount.toLocaleString()} triangles.</b> ${b.width.toFixed(1)} × ${b.depth.toFixed(1)} mm, ${b.height.toFixed(1)} mm tall; steepest underside ${b.overhang.toFixed(0)}°, ${b.area60.toFixed(0)} mm² past 60°. Flattened or on its side? Change the up axis.` : 'No mesh data.' }));
  }

  // the type picker, drawn from the real generators
  if (el.kind === 'pattern') {
    root.append(section('Pattern', [tiles(Object.entries(PATTERNS).map(([k, v]) => [k, v.label]), el.pattern, k => patternGlyph(k, face, accent, el.op, 52, 32), v => { el.pattern = v; el.params = patternDefaults(v); el.name = PATTERNS[v].label; commit('Pattern'); })]));
  } else if (el.kind === 'shape') {
    root.append(section('Shape', [tiles(SHAPES, el.shape, k => shapeGlyph(k, face, accent, el.op, 52, 32), v => { el.shape = v; commit('Shape'); })]));
  } else if (el.kind === 'grip') {
    root.append(section('Style', [tiles(GRIP_STYLES, el.style, k => gripGlyph(k, face, accent, 52, 32), v => { Object.assign(el, styleStart(el, v)); el.style = v; commit('Grip style'); }, 4)]));
    root.append(strengthBox(el));
    // the series' grips keep their shipped shape: say so, and what is still yours to set
    const fixed = el.style === 'edgelabel'
      ? ['EdgeLabel\'s hood keeps its shipped shape: 27 mm down the face, 17.6 mm tall. ', 'Its corner, the second hood on 3W and 4W, and its colour are yours.']
      : HOOD_STYLES.includes(el.style) ? [`${el.style === 'classicpro' ? 'Classic Pro' : 'Classic'} keeps the series' shipped section: 27 mm deep, 23 mm tall, with its finger pocket and leaning ends. `, 'Its length (or full width), the edge it sits on, its colour and the accent strip are yours.'] : null;
    if (fixed) root.append(h('div', { class: 'infobox' }, [h('b', { text: fixed[0] }), fixed[1]]));
  } else if (el.kind === 'combine') {
    root.append(section('Pieces', pieceRows(el)));
  } else if (el.kind === 'offset') {
    root.append(section('Follows', followRows(el)));
  } else if (el.kind === 'path') {
    root.append(section('Points', pointRows(el)));
  } else if (el.kind === 'solid') {
    root.append(section('Shape', [tiles(SOLID_SHAPES, el.shape, k => solidGlyph(k, face, accent, 52, 32), v => { el.shape = v; commit('Block shape'); })]));
  } else if (el.kind === 'surface') {
    const pic = el.map === 'picture' ? pictureOfData(el.data) : null;
    // Shuffle whenever there is a random layout to deal again: a seeded texture, or cell colours scattered at random
    const seedParam = def.params.find(p => p.key === 'seed'), seeded = (!!seedParam && showIf(seedParam, el)) || (Array.isArray(el.cellColors) && el.cellColors.length > 0 && el.colorMode !== 'height');
    const reseed = seeded ? h('button', { class: 'key sm', type: 'button', 'data-k': 'shuffle', title: 'A new random layout of the same texture.', onclick: () => { el.seed = Math.floor(Math.random() * 10000); commit('Shuffle'); } }, [icon('shuffle', { size: 14 }), 'Shuffle']) : null;
    // a texture's own settings start from its defaults whenever another texture is picked; its tile shows them
    root.append(section('Texture', [tiles(HEIGHT_MAPS, el.map, k => mapGlyph(k, accent, 52, 32, { seed: el.seed, picture: k === 'picture' ? pic : null, params: k === el.map ? el.texParams : null }), v => { el.map = v; el.texParams = textureDefaults(v); commit('Texture'); }, 4, 'map')], reseed));
    if (el.map === 'picture') root.append(pictureCtl(el));
    const tparams = TEXTURE_PARAMS[el.map] || [];
    if (tparams.length) {
      if (!el.texParams || typeof el.texParams !== 'object') el.texParams = textureDefaults(el.map);
      root.append(section('Shape', tparams.filter(p => showIf(p, el.texParams)).map(p => prow(p.label, paramCtl(el.texParams, p, 'tp.'), p.help))));
    }
    if (state.design.mode !== 'up') root.append(h('div', { class: 'warnbox' }, [h('b', { text: '3D textures print face up. ' }), 'This design is set to print face down. ', h('button', { class: 'key sm', type: 'button', style: 'margin-top:8px', onclick: () => { state.design.mode = 'up'; commit('Mode'); } }, ['Print face up'])]));
  } else if (el.kind === 'text') {
    // each font shown in itself (the same TrueType files, declared in css/app.css)
    const fontTile = id => `<span class="fontglyph" style="font-family:'${fontDef(id).css}'">Ag</span>`;
    root.append(section('Font', [tiles(FONTS.map(f => [f.id, f.label.replace(/^IBM /, '')]), fontDef(el.font).id, fontTile, v => { el.font = v; commit('Font'); })]));
    const st = textStroke(el);
    if (st && Number.isFinite(st.mm)) root.append(h('div', { class: 'infobox' }, [h('b', { text: `Thinnest stroke about ${st.mm < 1 ? st.mm.toFixed(2) : st.mm.toFixed(1)} mm` }), `${st.char ? ` (in “${st.char}”)` : ''} at this height. Two perimeters need 0.8 mm; strokes under the 0.4 mm nozzle do not print.`]));
  }
  const artOp = op => el.kind === 'svg' && el.groups?.some(g => g.visible !== false && g.op === op);
  const inlayHere = el.op === 'inlay' || artOp('inlay'), cutsHere = el.op === 'cut' || inlayHere || artOp('cut');
  if (cutsHere && !faceOn(state.design)) root.append(h('div', { class: 'infobox' }, [h('b', { text: inlayHere ? 'Inlays and cuts need the face. ' : 'Cuts need the face. ' }), inlayHere ? 'The face is switched off in Style, so an inlay has no face to sit in and a cut has nothing to cut into. Raise it instead, or turn the face on.' : 'The face is switched off in Style, so a cut has nothing to cut into and leaves the backer as it is.']));

  const skip = new Set(['pattern', 'style', 'anchor', 'stackOn', 'font', 'stepColors', 'fill', 'border', 'map', 'target', 'cellColors', 'colorMode', 'source']);
  if (el.kind !== 'surface') skip.add('shape');
  // the everyday settings first; the fine-tuning ones (adv) wait under More settings, which says how many differ
  // from where they start, so a changed one is never out of sight unannounced
  const differs = (v, d) => d !== undefined && JSON.stringify(v ?? d) !== JSON.stringify(d);
  // the element as the size shown has it: its own values where it changed them, formulas worked out; edits go to
  // every size or to this one, as the switch says (variants.js)
  const size = currentSize(), tok = sizeToken(size.id);
  const view = viewOn(el, size, () => state.scope, e => emit('toast', `That formula was not used: ${e.message}`));
  const shown = def.params.filter(p => !skip.has(p.key) && showIf(p, view));
  const own = key => Object.prototype.hasOwnProperty.call(el.bySize?.[size.id] || {}, key);
  const mark = (row, p) => {
    const lbl = row.querySelector('.lbl');
    if (!lbl || !canOverride(el, p.key)) return row;
    if (own(p.key)) lbl.append(h('button', { class: 'ovr', type: 'button', 'data-k': `ovr.${p.key}`, title: `${tok} has its own value here. Click to make it follow every size again.`, onclick: () => { resetOn(el, p.key, size); commit('Follow every size'); } }, [`${tok} only`, icon('x', { size: 11 })]));
    const others = sizesOverriding(el, p.key).filter(id => id !== size.id);
    if (others.length) lbl.append(h('span', { class: 'ovr-n', title: `Its own value on ${others.map(sizeToken).join(', ')}`, text: `+${others.length} size${others.length === 1 ? '' : 's'}` }));
    return row;
  };
  const rowOf = p => mark(prow(p.label, p.key === 'flush' ? flushCtl(el, p) : paramCtl(view, p), el.kind === 'surface' ? surfaceHelp(el, p) : el.kind === 'solid' && p.key === 'taper' ? taperHelp(el, p) : el.kind === 'path' && p.key === 'taper' ? pathTaperHelp(view, p) : el.kind === 'path' && p.key === 'edgeSize' ? pathEdgeHelp(view, p) : p.help), p);
  const rows = shown.filter(p => !p.adv).map(rowOf), more = shown.filter(p => p.adv).map(rowOf);
  let changed = shown.filter(p => p.adv && differs(view[p.key], p.default)).length;
  if (shown.some(p => canOverride(el, p.key))) {
    const mine = Object.keys(el.bySize?.[size.id] || {}).length;
    rows.unshift(prow('Change for', segCtl(state.scope, [['all', 'Every size'], ['size', `Only ${tok}`]], v => { state.scope = v; render(); }, 'scope'),
      state.scope === 'size'
        ? `Changes now go to ${tok} only, and it keeps them when the others change. Colours, fills, fonts, the slot or edge it is placed on, a drawing's points and form, and a texture's own settings are the same on every size.`
        : `Every size follows these, except a setting a size has changed for itself${mine ? ` (${tok} has ${mine}, marked)` : ''}. A number can be a formula, like =W-12: W and H are the plate in mm.`));
  }
  if (el.kind === 'surface' && el.region === 'element') {
    const at = rows.findIndex(r => r.querySelector('[data-k="region"]'));
    rows.splice(at < 0 ? 0 : at + 1, 0, prow('Element', targetCtl(el), 'The texture takes this element\'s outline, and stands in place of any raised relief there.'));
  }
  if (def.params.some(p => p.key === 'anchor' && showIf(p, el))) {
    const at = rows.findIndex(r => r.querySelector('[data-k="x"]'));
    rows.splice(at < 0 ? rows.length : at, 0, prow('Place', slotCtl(el), 'A slot 3 mm in from the edges it names. It keeps that place on every size; Offset X and Y fine-tune it.'));
  }
  if (el.kind === 'solid') {
    const at = rows.findIndex(r => r.querySelector('[data-k="lift"]'));
    rows.splice(at < 0 ? rows.length : at, 0, prow('Sits on', stackCtl(el), 'Stack it on a block, a grip or raised relief that comes before it in the stack.'));
  }
  if (rows.length) root.append(section('Settings', rows));
  if (el.kind === 'surface') root.append(section('Cell colours', cellColourRows(el)));
  if (def.params.some(p => p.key === 'fill')) root.append(section('Fill', fillRows(el, def, face, accent)));
  if (el.kind === 'pattern') {
    const linked = PATTERNS[el.pattern].linked;
    // any pattern with a seed gets Shuffle beside its title (its Seed number waits under More settings)
    const shuffle = 'seed' in (el.params || {}) ? h('button', { class: 'key sm', type: 'button', 'data-k': 'shuffle', title: linked ? 'A new random layout. Every layout still joins its neighbours.' : 'A new random layout.', onclick: () => { el.params.seed = Math.floor(Math.random() * 10000); commit('Shuffle'); } }, [icon('shuffle', { size: 14 }), 'Shuffle']) : null;
    const pshown = PATTERNS[el.pattern].params.filter(p => showIf(p, el.params || {}));
    const prowOf = p => prow(p.label, paramCtl(el.params, p, 'pp.'), p.help);
    const prows = pshown.filter(p => !p.adv).map(prowOf);
    more.push(...pshown.filter(p => p.adv).map(prowOf));
    changed += pshown.filter(p => p.adv && differs(el.params?.[p.key], p.default)).length;
    if (PATTERNS[el.pattern].editor) {
      // the drawn tiles: a strip of them and the way into the editor
      const set = portSet(el.params?.ports), tl = normTiles(el.params?.tiles, set), { cw, ch } = linkedCells(el.params || {}, 87, 55);
      const strip = h('div', { class: 'te-strip', 'aria-hidden': 'true' });
      strip.innerHTML = tl.map(x => tileSvg(x, set, cw, ch, 30, { face, ink: el.op === 'cut' ? shade(face, -0.32) : accent }, { width: el.params?.width })).join('');
      prows.unshift(h('div', { class: 'te-open' }, [strip, h('button', { class: 'key', type: 'button', 'data-k': 'edittiles', onclick: () => openTileEditor(el) }, [icon('pencil-simple', { size: 15 }), 'Edit tiles'])]));
    }
    if (linked) prows.unshift(h('div', { class: 'infobox' }, [h('b', { text: 'Linked to the neighbours. ' }), 'Its lines leave every edge where the plate beside, above or below picks them up, on any size, so a wall of plates reads as one piece. Turn on Wall in the toolbar to see it.']));
    root.append(section(`${PATTERNS[el.pattern].label} settings`, prows, shuffle));
  }
  if (more.length) root.append(moreSection(el.kind, more, changed));
  if (el.kind === 'grip' || el.kind === 'solid') {
    // the mount belongs to the whole design (it is also in Style), shown here because a grip usually replaces it
    root.append(section('Handle · whole design', [prow('Mount', mountCtl('emount'), el.kind === 'grip' ? `${mountHelp()} A grip is usually the handle itself, so None is the usual choice. This is for the whole design, not just this grip.` : `${mountHelp()} This is for the whole design, not just this block.`)]));
  }
  if (el.kind === 'image') root.append(section('Tones', toneRows(el)));
  if (el.kind === 'svg') {
    root.append(section('Art layers', [artLayers(el), el.natural ? h('p', { class: 'hint', text: `${el.natural.w.toFixed(1)} × ${el.natural.h.toFixed(1)} mm in the file; Art width scales the whole drawing.` }) : null]));
  }

  root.append(h('div', { class: 'actions' }, [
    h('button', { class: 'key', type: 'button', 'data-k': 'vis', onclick: () => { el.visible = el.visible === false; commit('Visibility'); } }, [icon(el.visible === false ? 'eye' : 'eye-slash', { size: 16 }), el.visible === false ? 'Show' : 'Hide']),
    h('button', { class: 'key', type: 'button', 'data-k': 'dup', onclick: duplicateSelected }, [icon('copy', { size: 16 }), 'Copy']),
    h('button', { class: 'key danger', type: 'button', 'data-k': 'del', onclick: deleteSelected }, [icon('trash', { size: 16 }), 'Remove']),
  ]));
}

export function render() { draw?.(); }

export function initInspector(el) {
  root = el;
  draw = panelRenderer(root, build);
  on('design', ({ preview: live } = {}) => { if (live) identUpdate(); else render(); });
  on('select', () => render());
  // checks land in the background, often while the user is typing here: refresh only the check boxes, in place
  on('checks', ({ sizeId } = {}) => {
    if (sizeId !== currentSize().id || root.hidden) return;
    const el = selectedElement(), box = root.querySelector('.echecks');
    if (el && box) fillChecks(box, el);
  });
  on('size', () => render());
  on('workspace', () => render());
  render();
}

