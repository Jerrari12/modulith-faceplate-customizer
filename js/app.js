// Boot: wire the workspace shell together (the planner's: top bar, library, inspector, toolbar, dock).
// Everything else lives in js/ui/* and js/state.js.

import { state, on, emit, prefs, setDesign, commit, undo, redo, select, loadAutosave, savedDesigns, deleteLocal, keepCurrent, keptId, setKept, currentSize, selectedElement, saveVersion } from './state.js';
import { newDesign, parseDesign, serializeDesign } from './export/design.js';
import { newElement, flushOp } from './geometry/face.js';
import { onFontLoaded } from './geometry/text.js';
import { imageFromRGBA, IMAGE_LIMITS } from './geometry/image.js';
import { sizeToken } from './data/sizes.js';
import { initStage2d, fit as fit2d } from './ui/stage2d.js';
import { initStage3d, setActive3d, fit3d } from './ui/stage3d.js';
import { initLeftPanel } from './ui/leftpanel.js';
import { initInspector } from './ui/inspector.js';
import { initChecksUI, setIssuesOpen } from './ui/checksui.js';
import { initSizesView, setSizesVisible } from './ui/sizesview.js';
import { initExportView, setExportVisible, exportSize, exportAllZip, downloadBlob, slug, confirmDownload } from './ui/exportview.js';
import { deleteSelected } from './ui/actions.js';
import { initHistoryView, openHistory, closeHistory, historyOpen } from './ui/historyview.js';
import { parseSvgArt } from './ui/svgimport.js';
import { parseMeshFile, packMesh, meshBounds } from './geometry/meshio.js';
import { h } from './ui/controls.js';
import { startPen, cancelPen, penActive, penKey } from './ui/pen.js';
import { icon } from './ui/icons.js';

const $ = s => document.querySelector(s);
let toastTimer = 0;
export function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function starterDesign() {
  // a Chevron-style starter so the first screen shows what the tool does
  const d = newDesign({ name: 'My chevron faceplate' });
  d.elements.push(newElement('pattern', { name: 'Chevron grooves', pattern: 'chevron', op: 'cut', depth: 2, invert: true, color: 'c2' }));
  return d;
}

/* ---- light / dark: the planner's data-mode, dark unless light was chosen; no transitions mid-flip ---- */
function setMode(mode) {
  const root = document.documentElement, fromTheme = !!document.activeElement?.closest?.('#ws-theme');
  root.classList.add('mode-flip');
  root.dataset.mode = mode === 'light' ? 'light' : 'dark';
  prefs.set('mode', root.dataset.mode);
  document.querySelectorAll('[data-mode-theme]').forEach(b => { const on = b.dataset.modeTheme === root.dataset.mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  // on phones only the mode to switch to is shown, so the button just pressed hides: the keyboard moves to the one
  // shown now instead of falling back to the page (Terra 01a1cbae)
  if (fromTheme && !document.activeElement?.offsetParent) document.querySelector('#ws-theme button:not(.on)')?.focus();
  emit('theme');
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('mode-flip')));
}

/* ---- workspaces: Design, All sizes, Export ---- */
function showView(name) {
  state.view = name;
  document.querySelectorAll('#ws-tabs .tab').forEach(b => { const on = b.dataset.tab === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
  // the active tab's icon goes Fill, the planner's rule for an active state
  document.querySelectorAll('#ws-tabs .tab use').forEach(u => { const tab = u.closest('.tab').dataset.tab; const base = { design: 'pencil-simple', sizes: 'squares-four', export: 'printer-3d' }[tab]; const fill = tab === name && tab !== 'export'; u.setAttribute('href', `icons/phosphor.svg#ph-${base}${fill ? '-fill' : ''}`); });
  $('#ws-sizes').hidden = name !== 'sizes';
  $('#ws-export').hidden = name !== 'export';
  const design = name === 'design';
  $('#ws-lib').hidden = !design; $('#ws-tools').hidden = !design;
  if (!design) setIssuesOpen(false);
  setSizesVisible(name === 'sizes');
  setExportVisible(name === 'export');
  if (design) setStage(state.stage);
  else setActive3d(false);
  emit('workspace', name);
  updateDock(); updateHint();
}

function setStage(mode) {
  if (mode !== '2d') cancelPen();   // the pen draws on the 2D stage only
  state.stage = mode;
  document.querySelectorAll('[data-stage]').forEach(b => { const on = b.dataset.stage === mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  $('#stage2d').hidden = mode !== '2d';
  $('#stage3d').hidden = mode !== '3d';
  setActive3d(mode === '3d' && state.view === 'design');
  prefs.set('stage', mode);
  updateHint();
}

function updateHint() {
  const el = $('#ws-hint');
  el.hidden = state.view !== 'design' || !$('#ws-issues').hidden;
  const selKind = selectedElement()?.kind, drawingSel = selKind === 'path';
  el.textContent = state.stage === '3d'
    ? 'Drag to orbit · wheel to zoom · right-drag to pan · click to select'
    : penActive() ? 'Click for a corner, drag for a curve · click the first point to close a shape, the last to end a line · Esc stops'
      : drawingSel ? 'Drag a point or a handle · double-click a point: corner or curve · double-click the line: add a point · Delete removes a point'
        : selKind === 'combine' ? 'Drag it to move it with all its pieces · drag a dashed edge to move one piece · Alt skips snapping'
          : selKind === 'offset' ? 'Drag it to move it with the element it follows · Alt skips snapping'
        : 'Drag to move, Alt to skip snapping · wheel to zoom';
}

/* ---- the dock's primary action: this size in Design, every ticked size elsewhere (the planner's CTA follows the tab) ---- */
function updateDock() {
  const n = state.design.sizes.enabled.length;
  $('#ctaLabel').textContent = state.view === 'design' ? `Download ${sizeToken(currentSize().id)}` : `Download ${n} size${n === 1 ? '' : 's'}`;
  $('#btnDownload').disabled = state.view !== 'design' && !n;
}

async function primaryAction() {
  const btn = $('#btnDownload'), label = $('#ctaLabel');
  if (btn.disabled) return;
  btn.disabled = true;
  // the first download in this browser says how the files are made before it makes them; what it makes is fixed
  // now, so a size or tab changed while the card is open cannot swap the download
  const one = state.view === 'design', sizeId = currentSize().id, ids = [...state.design.sizes.enabled];
  setIssuesOpen(false);
  const go = await confirmDownload(one ? `${sizeToken(sizeId)}, one file` : `${ids.length} size${ids.length === 1 ? '' : 's'} in one zip, with the design file`);
  if (!go) { btn.disabled = false; updateDock(); return; }
  try {
    if (one) {
      const r = await exportSize(sizeId);
      downloadBlob(r.blob, r.filename);
      toast(`${r.filename} · printed ${r.orientation === 'down' ? 'face down' : 'face up'}`);
    } else {
      const r = await exportAllZip(ids, (i, n, id) => { label.textContent = `Building ${sizeToken(id)} (${i + 1}/${n})`; });
      downloadBlob(r.blob, r.filename);
      toast(`${r.filename} · ${ids.length} sizes and the design file`);
    }
  } catch (e) { console.error(e); alert(`Export failed: ${e.message}`); }
  btn.disabled = false; updateDock();
}

/* ---- menus: the design switcher and the print chip ---- */
const menus = [];
function wireMenu(btnSel, menuSel, onOpen) {
  const btn = $(btnSel), menu = $(menuSel);
  const set = open => { menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); if (open) { menus.forEach(m => m !== entry && m.set(false)); onOpen?.(); } };
  const entry = { btn, menu, set };
  menus.push(entry);
  btn.addEventListener('click', () => set(menu.hidden));
  return entry;
}
document.addEventListener('pointerdown', ev => { for (const m of menus) if (!m.menu.hidden && !m.menu.contains(ev.target) && !m.btn.contains(ev.target)) m.set(false); });
const closeMenus = () => menus.forEach(m => m.set(false));

/* ---- switching designs: the one open is kept in this browser's list first, so nothing is lost by starting or opening another ---- */
let fromStarter = false;   // the open design is the chevron sample, as it came: nothing of the user's to keep
function switchDesign(next, { kept = null, done = '' } = {}) {
  const pristine = fromStarter && !state.undo.length;
  const name = pristine ? '' : keepCurrent();
  if (name === null && !confirm(`This browser could not keep "${state.design.name}": its storage is full. Switch anyway and lose it? Cancel, then Save design file, to keep it.`)) return false;
  setDesign(next); setKept(kept); fromStarter = false;
  const said = [done, name ? `"${name}" is in this browser's list` : ''].filter(Boolean);
  if (said.length) toast(said.join(' · '), 3600);
  return true;
}

function openStart(first) {
  const has = state.design.elements.length && !(fromStarter && !state.undo.length);
  $('#stNote').textContent = has ? `"${state.design.name}" stays in this browser's list.` : '';
  $('#stClose').setAttribute('aria-label', first ? 'Keep the sample' : 'Cancel');
  $('#ws-start').hidden = false;
  $('#ws-start .stc').focus();
}
const closeStart = () => { $('#ws-start').hidden = true; };

function renderSaved() {
  const list = $('#savedList'); list.innerHTML = '';
  const mine = keptId(), saved = savedDesigns().filter(d => d.id !== mine);
  if (!saved.length) { list.append(h('div', { class: 'empty', text: 'Nothing here yet. A design comes here when you start or open another one.' })); return; }
  // two designs may share a name, so each says when it was last kept, how it prints and how much is on it
  const when = iso => { const t = new Date(iso); return Number.isFinite(+t) ? t.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; };
  const what = json => { try { const x = JSON.parse(json); const dd = x.design || x, n = (dd.elements || []).length; return `face ${dd.mode === 'up' ? 'up' : 'down'} · ${n} element${n === 1 ? '' : 's'}`; } catch { return ''; } };
  for (const d of saved) {
    const meta = [when(d.saved), what(d.json)].filter(Boolean).join(' · ');
    list.append(h('div', { class: 'recent' }, [
      h('button', { class: 'open', type: 'button', onclick: () => { let next; try { next = parseDesign(d.json); } catch (e) { alert(`Could not open "${d.name}": ${e.message}`); return; } closeMenus(); switchDesign(next, { kept: d.id, done: `Opened ${d.name}` }); } }, [h('span', { text: d.name }), h('span', { text: meta })]),
      h('button', { class: 'x', type: 'button', title: 'Remove from this list', 'aria-label': `Remove ${d.name}`, onclick: () => { if (confirm(`Remove "${d.name}" from this browser's list?`)) deleteLocal(d.id); } }, [icon('x', { size: 14 })]),
    ]));
  }
}

function wireTopbar() {
  document.querySelectorAll('#ws-tabs .tab').forEach(b => b.addEventListener('click', () => showView(b.dataset.tab)));
  document.querySelectorAll('[data-mode-theme]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.modeTheme)));
  wireMenu('#designBtn', '#designMenu', () => { $('#designName').value = state.design.name; renderSaved(); });
  const printMenu = wireMenu('#printBtn', '#printMenu');
  document.querySelectorAll('[data-mode-set]').forEach(b => b.addEventListener('click', () => { state.design.mode = b.dataset.modeSet; commit('Mode'); printMenu.set(false); }));
  $('#designName').addEventListener('change', ev => { state.design.name = ev.target.value.trim().slice(0, 120) || 'Untitled faceplate'; commit('Rename design'); });
  $('#designName').addEventListener('keydown', ev => { if (ev.key === 'Enter') ev.target.blur(); });
  $('#btnNew').addEventListener('click', () => { closeMenus(); openStart(false); });
  $('#btnHistory').addEventListener('click', () => { closeMenus(); openHistory(); });
  on('openDesign', ({ design, done }) => switchDesign(design, { done }));
  document.querySelectorAll('[data-start]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.start;
    closeStart();
    if (k === 'sample' && fromStarter && !state.undo.length) return;   // the sample is open already, as it came
    if (switchDesign(k === 'sample' ? starterDesign() : newDesign({ mode: k === 'up' ? 'up' : 'down' })) && k === 'sample') fromStarter = true;
  }));
  $('#stClose').addEventListener('click', closeStart);
  $('#btnSaveFile').addEventListener('click', () => { downloadBlob(new Blob([serializeDesign(state.design)], { type: 'application/json' }), `${slug(state.design.name)}.faceplate.json`); toast('Design file saved'); });
  $('#fileDesign').addEventListener('change', async ev => {
    const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
    let next;
    try { next = parseDesign(await f.text()); } catch (e) { alert(`Could not open that file: ${e.message}`); return; }
    closeMenus(); closeStart();
    switchDesign(next, { done: `Opened ${f.name}` });
  });
  $('#btnDownload').addEventListener('click', primaryAction);
  on('design', () => {
    const d = state.design;
    $('#designBtnLabel').textContent = d.name;
    const sym = d.symmetry === 'x', sb = $('#tglSym');
    sb.classList.toggle('on', sym); sb.setAttribute('aria-pressed', String(sym));
    sb.querySelector('use').setAttribute('href', `icons/phosphor.svg#ph-flip-horizontal${sym ? '-fill' : ''}`);
    $('#btnUndo').disabled = !state.undo.length; $('#btnRedo').disabled = !state.redo.length;
    $('#cntSizes').textContent = d.sizes.enabled.length;
    $('#printLabel').textContent = d.mode === 'up' ? 'Face up' : 'Face down';
    $('#printIcon').setAttribute('href', `icons/phosphor.svg#ph-${d.mode === 'up' ? 'arrow-line-up' : 'arrow-line-down'}`);
    document.querySelectorAll('[data-mode-set]').forEach(b => b.classList.toggle('on', b.dataset.modeSet === d.mode));
    updateDock();
  });
  on('size', updateDock);
  on('toast', msg => toast(msg, 4200));
  on('saved', renderSaved);
  on('goto', showView);
  on('issues', updateHint);
  on('pen', updateHint);
  on('select', updateHint);
  $('#addDraw').addEventListener('click', () => { if (state.view !== 'design') return; setStage('2d'); startPen(); });
}

/* ---- the toolbar over the stage ---- */
function wireTools() {
  document.querySelectorAll('[data-stage]').forEach(b => b.addEventListener('click', () => setStage(b.dataset.stage)));
  state.wall = !!prefs.get('wall', false); state.grid = prefs.get('grid', true) !== false; state.dims = prefs.get('dims', true) !== false; state.issues = prefs.get('issues', true) !== false;
  const tgl = (id, key) => {
    const b = $(id);
    const sync = () => { b.classList.toggle('on', !!state[key]); b.setAttribute('aria-pressed', String(!!state[key])); };
    sync();
    b.addEventListener('click', () => { state[key] = !state[key]; prefs.set(key, state[key]); sync(); emit('view'); if (key === 'wall') fit2d(); });
  };
  tgl('#tglWall', 'wall'); tgl('#tglGrid', 'grid'); tgl('#tglDims', 'dims'); tgl('#tglIssues', 'issues');
  $('#btnFit').addEventListener('click', () => { if (state.stage === '3d') fit3d(); else fit2d(); });
  $('#tglSym').addEventListener('click', () => { state.design.symmetry = state.design.symmetry === 'x' ? 'off' : 'x'; commit(state.design.symmetry === 'x' ? 'Symmetry on' : 'Symmetry off'); });
  $('#btnUndo').addEventListener('click', undo);
  $('#btnRedo').addEventListener('click', redo);
}

/* ---- imports: SVG art and sculpted meshes ---- */
/** An import lands a moment after it starts: select what it added, unless the keyboard is in a field by then (the
 *  inspector would be rebuilt under the typing; the toast says what was added, and the stack shows it). */
function selectUnlessTyping(id) {
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'file' && !a.closest('.menu')) return;
  select(id);
}
function wireImports() {
  $('#fileImage').addEventListener('change', async ev => {
    const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
    try {
      // scaled down to at most 256 px on its long side and kept in the design as greyscale, so the file carries it
      const into = state.design;
      const bmp = await createImageBitmap(f);
      if (state.design !== into) { bmp.close?.(); toast(`${f.name} was not added: the design changed while it was reading.`, 4000); return; }
      const k = Math.min(1, IMAGE_LIMITS.maxSide / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, w, h);
      bmp.close?.();
      const d = state.design, size = currentSize();
      const el = newElement('image', { name: (f.name.replace(/\.[^.]+$/, '') || 'Image').slice(0, 40), data: imageFromRGBA(ctx.getImageData(0, 0, w, h).data, w, h), op: flushOp(d) });
      // half the plate wide, and no taller than three quarters of it
      el.width = Math.max(IMAGE_LIMITS.minWidth, +Math.min(40, size.w * 0.5, size.h * 0.75 * w / h).toFixed(2));
      // each tone its own colour slot (not the backer, not the face), cycling when there are more tones than slots
      const slots = d.colors.filter(s => s.id !== 'backer' && s.id !== d.face.color).map(s => s.id);
      el.stepColors = Array.from({ length: IMAGE_LIMITS.maxSteps }, (_, i) => slots.length ? slots[i % slots.length] : 'c2');
      d.elements.push(el);
      commit('Import image'); selectUnlessTyping(el.id);
      toast(`${f.name}: ${w} × ${h} px in ${el.steps} tones. Tones, Balance and Smoothing shape it.`, 3600);
    } catch (e) { console.error(e); alert(`Could not import ${f.name}: ${e.message}`); }
  });
  $('#fileSvg').addEventListener('change', async ev => {
    const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
    try {
      const into = state.design, text = await f.text();
      if (state.design !== into) { toast(`${f.name} was not added: the design changed while it was reading.`, 4000); return; }
      const { element, notes, newColors } = parseSvgArt(text, f.name, state.design);
      if (state.design.colors.length + newColors.length > 8) { newColors.splice(8 - state.design.colors.length); for (const g of element.groups) if (!state.design.colors.some(c => c.id === g.color) && !newColors.some(c => c.id === g.color)) g.color = state.design.face.color; }
      state.design.colors.push(...newColors);
      element.width = Math.min(40, currentSize().w * 0.5);
      // each colour layer inlays on a face-down design (flush, its own filament) and stands proud on a face-up one
      for (const g of element.groups) g.op = flushOp(state.design);
      state.design.elements.push(element);
      commit('Import SVG'); selectUnlessTyping(element.id);
      toast(notes.length ? notes[0] : `${f.name}: ${element.groups.length} colour layer${element.groups.length === 1 ? '' : 's'}`, notes.length ? 5000 : 2600);
    } catch (e) { console.error(e); alert(`Could not import ${f.name}: ${e.message}`); }
  });
  $('#fileMesh').addEventListener('change', async ev => {
    const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
    try {
      const into = state.design, buf = await f.arrayBuffer();
      if (state.design !== into) { toast(`${f.name} was not added: the design changed while it was reading.`, 4000); return; }
      const mesh = parseMeshFile(f.name, buf);
      const nt = mesh.indices.length / 3;
      if (nt > 400000) throw new Error(`${nt.toLocaleString()} triangles is too many for a design file; decimate it to under 150,000 first`);
      const b = meshBounds(mesh);
      const ext = [b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0];
      // a relief sculpt is thinnest along its up axis; guess that (sculpting apps export Y up)
      const thin = ext.indexOf(Math.min(...ext));
      const up = thin === 2 ? 'z' : thin === 1 ? 'y' : 'x';
      const el = newElement('mesh', { name: f.name.replace(/\.(stl|obj)$/i, '').slice(0, 60) || 'Mesh', data: packMesh(mesh), natural: { w: ext[0], h: ext[1], d: ext[2], tris: nt }, up, width: Math.min(40, currentSize().w * 0.5) });
      state.design.mode = 'up';
      state.design.elements.push(el);
      commit('Import mesh'); selectUnlessTyping(el.id);
      toast(`${f.name}: ${nt.toLocaleString()} triangles${nt > 150000 ? ' · large, saves and checks will be slow' : ''}`, 5000);
    } catch (e) { console.error(e); alert(`Could not import ${f.name}: ${e.message}`); }
  });
}

function wireKeys() {
  document.addEventListener('keydown', ev => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName);
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && !ev.shiftKey) { if (!inField) { ev.preventDefault(); undo(); } return; }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key.toLowerCase() === 'y' || (ev.key.toLowerCase() === 'z' && ev.shiftKey))) { if (!inField) { ev.preventDefault(); redo(); } return; }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's' && !ev.shiftKey && !ev.altKey) {
      ev.preventDefault();
      if (inField) ev.target.blur();   // a value being typed is committed first, so the version holds it
      saveVersion('').then(v => { if (v) toast(`Saved a version: ${v.label}. Version history is in the design menu.`, 3600); });
      return;
    }
    if (!inField && penKey(ev)) { ev.preventDefault(); return; }
    if (ev.key === 'Escape') { if (historyOpen()) { closeHistory(); return; } if (!$('#ws-start').hidden) { closeStart(); return; } if (menus.some(m => !m.menu.hidden)) { closeMenus(); return; } if (!$('#ws-issues').hidden) { setIssuesOpen(false); return; } select(null); return; }
    if (inField) return;
    if (ev.key === 'Delete' || ev.key === 'Backspace') { if (selectedElement()) { ev.preventDefault(); deleteSelected(); } }
    if (state.view !== 'design') return;
    if (ev.key === 'f' || ev.key === 'F') { state.stage === '3d' ? fit3d() : fit2d(); }
    if (ev.key === '2') setStage('2d');
    if (ev.key === '3') setStage('3d');
  });
}

function boot() {
  if (!globalThis.polygonClipping?.union || !globalThis.JSZip) {
    document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif">The geometry libraries did not load. Serve the folder over http (python serve.py) and reload.</div>';
    return;
  }
  setMode(prefs.get('mode', 'dark'));
  const restored = loadAutosave();
  state.design = restored || starterDesign();
  fromStarter = !restored;
  // the sample is nobody's entry: an id left from a design whose autosave is gone must not be kept over
  if (!restored) setKept(null);
  setDesign(state.design);
  initStage2d($('#stage2d'));
  initStage3d($('#stage3d'));
  initLeftPanel($('#ws-lib'));
  initInspector($('#ws-insp'));
  initChecksUI(document);
  initSizesView($('#ws-sizes'));
  initExportView($('#ws-export'));
  initHistoryView($('#ws-history'));
  wireTopbar(); wireTools(); wireImports(); wireKeys();
  // a text element's font arrives after the first build: rebuild everything once it has (no undo step, no autosave)
  onFontLoaded(() => { state.builds.clear(); state.version++; emit('design', { reason: 'font' }); });
  state.stage = prefs.get('stage', '2d') === '3d' ? '3d' : '2d';
  showView('design');
  emit('design', { reason: 'boot' });
  emit('size');
  // a first visit starts with the choice (the sample shows behind it, and stays if the card is closed)
  if (!restored) openStart(true);
}

boot();
