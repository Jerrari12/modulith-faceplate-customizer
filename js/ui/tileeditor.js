// The tile editor: draw the tiles a "Your tiles" pattern lays across the wall. Click two edge points of a tile to join
// them, click a line to take it away. Every line leaves its edge point square to the edge, so any mix of these tiles
// joins up from cell to cell and from plate to plate; the preview proves it on four plates with four different seeds.

import { state, on, commit, colorHex } from '../state.js';
import { h, segCtl, numberCtl, boolCtl, panelRenderer } from './controls.js';
import { icon } from './icons.js';
import * as P from '../geometry/polys.js';
import { generatePattern, linkedCells } from '../geometry/patterns.js';
import { PORT_SETS, portSet, normTiles, openPorts, linkLine, bandRing, presetTiles, TILE_PRESETS, TILE_STYLES, MAX_TILES, MAX_LINKS } from '../geometry/tiles.js';
import { shade } from './render2d.js';

const NS = 'http://www.w3.org/2000/svg';
let dlg = null, body = null, draw = null, elId = null, cur = 0, pending = null, previewTimer = 0, note = '';

const elOf = () => state.design.elements.find(e => e.id === elId && e.kind === 'pattern' && e.pattern === 'tiles') || null;

function colours(el) {
  const face = colorHex(state.design.face.color);
  return { face, ink: el.op === 'cut' ? shade(face, -0.32) : colorHex(el.color) };
}

/** The set as stored, cleaned: { set, tiles }. */
function current(el) {
  const set = portSet(el.params.ports);
  return { set, tiles: normTiles(el.params.tiles, set) };
}

function save(el, tiles, label) {
  el.params.tiles = tiles;
  commit(label);
}

/** One tile drawn in its cell (cw x ch mm) as an SVG string: the bands, and optionally the ports. */
export function tileSvg(tile, set, cw, ch, px, col, opts = {}) {
  const w = Math.min(opts.width ?? 1.6, (set === 'thirds' ? 0.28 : 0.8) * Math.min(cw, ch));
  const pad = Math.min(cw, ch) * 0.12, sc = px / Math.max(cw + 2 * pad, ch + 2 * pad);
  let s = `<svg xmlns="${NS}" width="${(cw + 2 * pad) * sc}" height="${(ch + 2 * pad) * sc}" viewBox="${-pad} ${-pad} ${cw + 2 * pad} ${ch + 2 * pad}" aria-hidden="true"><g transform="translate(0 ${ch}) scale(1 -1)">`;
  s += `<rect x="0" y="0" width="${cw}" height="${ch}" fill="${col.face}" stroke="rgba(0,0,0,.28)" stroke-width="${0.6 / sc}"/>`;
  tile.links.forEach(([a, b], k) => {
    const ring = bandRing(linkLine(set, a, b, tile.style, 0, 0, cw, ch, 20, w), w, 0, 0, cw, ch, 0);
    s += `<path ${opts.interactive ? `data-link="${k}" class="te-link"` : ''} d="${P.pathD(P.polygon(ring))}" fill="${col.ink}" stroke="${shade(col.ink, -0.3)}" stroke-width="${0.5 / sc}"/>`;
  });
  if (tile.dot > 0) s += `<circle cx="${cw / 2}" cy="${ch / 2}" r="${tile.dot * Math.min(cw, ch) / 2}" fill="${col.ink}" stroke="${shade(col.ink, -0.3)}" stroke-width="${0.5 / sc}"/>`;
  if (opts.ports) {
    const open = new Set(openPorts(tile, set)), r = Math.min(cw, ch) * 0.055;
    PORT_SETS[set].forEach(([u, v], i) => {
      const cls = `te-port${open.has(i) ? ' open' : ''}${pending === i ? ' pending' : ''}`;
      s += `<circle class="${cls}" data-port="${i}" cx="${u * cw}" cy="${v * ch}" r="${r}" stroke-width="${1.6 / sc}"/>`;
    });
  }
  return `${s}</g></svg>`;
}

function renderPreview() {
  const el = elOf(), host = body?.querySelector('.te-preview');
  if (!el || !host) return;
  const col = colours(el);
  // four 1W-1H plates on the wall pitch, each with its own seed: the joins are the point
  let s = `<svg xmlns="${NS}" viewBox="-1 -1 178 114" width="100%" aria-label="Four plates side by side and stacked"><rect x="-1" y="-1" width="178" height="114" fill="${colorHex('backer')}"/>`;
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
    const cx = 44 + 88 * c, cy = 28 + 56 * r;
    let poly = [];
    try {
      const raw = generatePattern('tiles', { ...el.params, seed: (el.params.seed || 0) + 101 * c + 37 * r + 1, perSize: false }, 87, 55);
      poly = P.intersection(raw, P.rect(-43.5, -27.5, 43.5, 27.5));
      if (el.invert) poly = P.difference(P.rect(-43.5, -27.5, 43.5, 27.5), poly);
    } catch { poly = []; }
    s += `<g transform="translate(${cx} ${cy}) scale(1 -1)"><rect x="-43.5" y="-27.5" width="87" height="55" fill="${col.face}"/><path d="${P.pathD(poly)}" fill="${col.ink}" fill-rule="evenodd"/></g>`;
  }
  host.innerHTML = `${s}</svg>`;
}

function renderBody() {
  const el = elOf();
  body.innerHTML = '';
  if (!el) return;
  const { set, tiles } = current(el);
  if (!tiles.length) tiles.push({ links: [], style: 'curve', dot: 0, weight: 1 });
  cur = Math.min(cur, tiles.length - 1);
  const tile = tiles[cur];
  const { cw, ch } = linkedCells(el.params, 87, 55);
  const col = colours(el);
  const w = el.params.width ?? 1.6;

  // ---- the tiles in the set
  const list = h('div', { class: 'te-list', role: 'listbox', 'aria-label': 'Tiles', 'data-k': 'tiles' });
  tiles.forEach((t, i) => {
    const b = h('button', { class: `key te-thumb${i === cur ? ' on' : ''}`, type: 'button', role: 'option', 'aria-selected': String(i === cur), title: `Tile ${i + 1}${t.weight === 0 ? ' (never used)' : ''}`, onclick: () => { cur = i; pending = null; draw(); } });
    b.innerHTML = tileSvg(t, set, cw, ch, 52, col, { width: w });
    if (openPorts(t, set).length) b.append(h('span', { class: 'te-flag', title: 'Has open ends' }, [icon('warning', { size: 12, fill: true })]));
    list.append(b);
  });
  const acts = h('div', { class: 'te-acts' }, [
    h('button', { class: 'key sm', type: 'button', 'data-k': 'tadd', disabled: tiles.length >= MAX_TILES, title: 'A new, empty tile', onclick: () => { tiles.push({ links: [], style: 'curve', dot: 0, weight: 1 }); cur = tiles.length - 1; save(el, tiles, 'Add tile'); } }, [icon('plus', { size: 14 }), 'Add']),
    h('button', { class: 'key sm', type: 'button', 'data-k': 'tcopy', disabled: tiles.length >= MAX_TILES, onclick: () => { tiles.splice(cur + 1, 0, JSON.parse(JSON.stringify(tile))); cur += 1; save(el, tiles, 'Copy tile'); } }, [icon('copy', { size: 14 }), 'Copy']),
    h('button', { class: 'key sm danger', type: 'button', 'data-k': 'tdel', disabled: tiles.length <= 1, onclick: () => { tiles.splice(cur, 1); cur = Math.max(0, cur - 1); save(el, tiles, 'Remove tile'); } }, [icon('trash', { size: 14 }), 'Remove']),
  ]);

  // ---- the tile being drawn
  const canvas = h('div', { class: 'te-canvas well' });
  canvas.innerHTML = tileSvg(tile, set, cw, ch, 280, col, { ports: true, interactive: true, width: w });
  canvas.addEventListener('click', ev => {
    const port = ev.target.closest?.('[data-port]'), link = ev.target.closest?.('[data-link]');
    if (port) {
      const i = +port.dataset.port;
      if (pending == null || pending === i) { pending = pending === i ? null : i; draw(); return; }
      const a = pending, b = i, at = tile.links.findIndex(([x, y]) => (x === a && y === b) || (x === b && y === a));
      pending = null;
      if (at < 0 && tile.links.length >= MAX_LINKS) { note = `A tile holds up to ${MAX_LINKS} lines. Remove one to draw another.`; draw(); return; }
      if (at >= 0) tile.links.splice(at, 1); else tile.links.push([a, b]);
      save(el, tiles, at >= 0 ? 'Remove line' : 'Draw line');
    } else if (link) {
      tile.links.splice(+link.dataset.link, 1);
      save(el, tiles, 'Remove line');
    } else if (pending != null) { pending = null; draw(); }
  });
  const open = openPorts(tile, set).length;
  const shown = note; note = '';
  const status = h('p', { class: 'te-hint' }, shown ? [h('b', { text: shown })] : pending != null
    ? ['Now click the edge point to join it to.']
    : [`Click two edge points to join them with a line; click a line to remove it. `, open ? h('b', { text: `${open} open end${open > 1 ? 's' : ''}: a neighbour's line stops there.` }) : 'Every edge point is used, so lines always carry on.']);
  const opts = h('div', { class: 'te-opts' }, [
    h('div', { class: 'prow' }, [h('div', { class: 'lbl', text: 'Lines' }), h('div', { class: 'ctl' }, [segCtl(tile.style, TILE_STYLES, v => { tile.style = v; save(el, tiles, 'Tile lines'); }, 'tstyle')])]),
    h('div', { class: 'prow' }, [h('div', { class: 'lbl', text: 'Centre dot' }), h('div', { class: 'ctl' }, [segCtl(tile.dot === 0 ? 0 : tile.dot < 0.3 ? 0.2 : 0.4, [[0, 'None'], [0.2, 'Small'], [0.4, 'Large']], v => { tile.dot = v; save(el, tiles, 'Tile dot'); }, 'tdot')])]),
    h('div', { class: 'prow' }, [h('div', { class: 'lbl', text: 'How often' }), h('div', { class: 'ctl' }, [numberCtl(tile.weight, { min: 0, max: 9, step: 0.5, default: 1, label: 'How often this tile is used' }, v => { tile.weight = v; el.params.tiles = tiles; }, v => { tile.weight = v; save(el, tiles, 'Tile weight'); }, 'tweight')]), h('small', { class: 'help', text: 'Against the other tiles: 2 shows up twice as often as 1; 0 never.' })]),
  ]);

  // ---- the whole set: ports, turning, starting points, and the preview
  const ports = segCtl(set, [['mid', 'Midpoints'], ['thirds', 'Thirds']], v => {
    if (!confirm(`Switch to ${v === 'thirds' ? 'two edge points per side (thirds)' : 'one edge point per side (midpoints)'}? The tiles start over from a preset; Undo brings them back.`)) return;
    const pre = presetTiles(v === 'thirds' ? 'braid' : 'circuit');
    el.params.ports = pre.ports; cur = 0; pending = null; save(el, pre.tiles, 'Tile points');
  }, 'tports');
  const presets = h('div', { class: 'te-presets', 'data-k': 'tpresets' }, Object.entries(TILE_PRESETS).map(([k, p]) =>
    h('button', { class: 'key sm', type: 'button', title: `Replace the tiles with the ${p.label} set (${p.ports === 'thirds' ? 'thirds' : 'midpoints'})`, onclick: () => { const pre = presetTiles(k); el.params.ports = pre.ports; cur = 0; pending = null; save(el, pre.tiles, `Tiles: ${p.label}`); } }, [p.label])));
  const side = h('div', { class: 'te-side' }, [
    h('div', { class: 'prow' }, [h('div', { class: 'lbl', text: 'Edge points' }), h('div', { class: 'ctl' }, [ports])]),
    h('div', { class: 'prow' }, [h('div', { class: 'lbl', text: 'Turn tiles' }), h('div', { class: 'ctl' }, [boolCtl(el.params.rotate !== false, v => { el.params.rotate = v; commit('Turn tiles'); }, 'trotate')])]),
    h('div', { class: 'h2', text: 'Start from' }), presets,
    h('div', { class: 'h2', text: 'Four plates, four seeds' }),
    h('div', { class: 'te-preview well' }),
    h('p', { class: 'te-hint', text: 'Each plate here draws its own random layout, and the lines still meet across every gap. Cell size, line width and seed are in the element\'s card.' }),
  ]);

  body.append(h('div', { class: 'te-col' }, [h('div', { class: 'h2', text: `Tiles · ${tiles.length}/${MAX_TILES}` }), list, acts]),
    h('div', { class: 'te-col' }, [h('div', { class: 'h2', text: `Tile ${cur + 1}` }), canvas, status, opts]), side);
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 60);
}

function ensureDialog() {
  if (dlg) return;
  dlg = h('section', { id: 'tileEditor', class: 'glass', role: 'dialog', 'aria-label': 'Tile editor', hidden: true });
  const head = h('div', { class: 'te-head' }, [
    h('div', {}, [h('h2', { text: 'Tile editor' }), h('p', { text: 'Draw how lines cross a tile. Every line meets the cell edge square at the same points, so any mix of tiles joins up across plates.' })]),
    h('button', { class: 'x', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close', onclick: closeTileEditor }, [icon('x', { size: 18 })]),
  ]);
  body = h('div', { class: 'te-body' });
  dlg.append(head, body);
  document.querySelector('#ws').append(dlg);
  draw = panelRenderer(body, renderBody);
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape' || !dlg || dlg.hidden) return;
    ev.stopPropagation(); ev.preventDefault();
    if (pending != null) { pending = null; draw(); } else closeTileEditor();
  }, true);
  on('design', ({ preview: live } = {}) => { if (dlg.hidden) return; if (!elOf()) closeTileEditor(); else if (!live) draw(); });
  on('select', () => { if (!dlg.hidden && state.selectedId !== elId) closeTileEditor(); });
  on('workspace', name => { if (!dlg.hidden && name !== 'design') closeTileEditor(); });
}

export function openTileEditor(el) {
  ensureDialog();
  elId = el.id; cur = 0; pending = null;
  if (!Array.isArray(el.params.tiles) || !el.params.tiles.length) { const pre = presetTiles('circuit'); el.params.ports = pre.ports; el.params.tiles = pre.tiles; commit('Tiles'); }
  dlg.hidden = false;
  draw();
}

export function closeTileEditor() {
  if (!dlg) return;
  dlg.hidden = true; elId = null; pending = null;
}
