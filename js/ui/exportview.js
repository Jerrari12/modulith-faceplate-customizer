// Export: per-size 3MF (PrusaSlicer or Bambu/Orca layout) or STL, oriented for the chosen print mode and
// centred on the chosen bed; or everything enabled in one zip.

import { state, on, getBuild, ensureChecks, colorHex, colorName, currentSize, prefs, noteDownload } from '../state.js';
import { loadBacker, backerTriangles } from '../geometry/backer.js';
import { extrudeMultiPolygon } from '../geometry/extrude.js';
import { faceTriangles } from '../geometry/face.js';
import { ensureFonts } from '../geometry/text.js';
import { buildPrusa3MF, buildBambu3MF } from '../export/threemf.js';
import { stlBlob } from '../export/stl.js';
import { orientForPrint, BEDS, prusaBedFor, fitsBed } from '../export/orient.js';
import { serializeDesign } from '../export/design.js';
import { SIZES, SIZE_BY_ID, sizeLabel, sizeToken } from '../data/sizes.js';
import { iconHtml } from './icons.js';
import { panelRenderer } from './controls.js';

const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
let els = {}, visible = false;
const opts = { format: 'prusa', bed: 'auto', orient: 'auto', split: 'color' };
// the export settings are this browser's: a Bambu owner sets Bambu once, not on every visit
const OPT_VALUES = { format: ['prusa', 'bambu', 'stl'], orient: ['auto', 'down', 'up'], split: ['color', 'element', 'piece'], bed: ['auto', ...Object.keys(BEDS)] };
{
  const kept = prefs.get('export', null);
  if (kept && typeof kept === 'object') for (const [k, ok] of Object.entries(OPT_VALUES)) if (ok.includes(kept[k])) opts[k] = kept[k];
}
const keepOpts = () => prefs.set('export', { ...opts });
const profileCache = new Map();

async function profileText(key) {
  if (!BEDS[key]?.profile) return null;
  if (!profileCache.has(key)) profileCache.set(key, fetch(BEDS[key].profile).then(r => r.ok ? r.text() : null).catch(() => null));
  return profileCache.get(key);
}

export function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'faceplate'; }

function extruderOf(colorId) { const i = state.design.colors.findIndex(c => c.id === colorId); return (i >= 0 ? i : 0) + 1; }

/** Bodies for one size: [{ name, tris, color }] in the design frame, before orientation. */
async function bodiesFor(sizeId, split) {
  // every font the text uses has to be here before the build, or its letters would be missing from the file
  await ensureFonts(state.design);
  const b = getBuild(sizeId);
  const built = b.built;
  const face = faceTriangles(built, (poly, z0, z1) => poly);   // placeholder, replaced below per split
  const out = [];
  const bk = await loadBacker(sizeId);
  out.push({ name: `${sizeId} Backer`, tris: backerTriangles(bk), color: 'backer' });
  const layers = built.layers;
  if (split === 'color') {
    const byColor = new Map();
    for (const L of layers) { const k = L.color; if (!byColor.has(k)) byColor.set(k, []); extrudeMultiPolygon(L.poly, L.z0, L.z1, byColor.get(k)); }
    for (const s of built.solids) { const k = s.color; if (!byColor.has(k)) byColor.set(k, []); byColor.get(k).push(...s.tris); }
    for (const [color, tris] of byColor) out.push({ name: `${sizeId} ${colorName(color)}`, tris, color });
  } else if (split === 'element') {
    const byEl = new Map();
    for (const L of layers) { const k = L.elementId || 'face'; if (!byEl.has(k)) byEl.set(k, { name: L.name, color: L.color, tris: [] }); extrudeMultiPolygon(L.poly, L.z0, L.z1, byEl.get(k).tris); }
    for (const s of built.solids) { const k = s.elementId; if (!byEl.has(k)) byEl.set(k, { name: s.name, color: s.color, tris: [] }); byEl.get(k).tris.push(...s.tris); }
    for (const e of byEl.values()) out.push({ name: `${sizeId} ${e.name}`, tris: e.tris, color: e.color });
  } else {
    let n = 0;
    for (const L of layers) for (const poly of L.poly) { n++; out.push({ name: `${sizeId} ${L.name} ${String(n).padStart(2, '0')}`, tris: extrudeMultiPolygon([poly], L.z0, L.z1), color: L.color }); }
    for (const s of built.solids) out.push({ name: `${sizeId} ${s.name}`, tris: s.tris, color: s.color });
  }
  return { bodies: out.filter(x => x.tris.length), built };
}

/** Build the file for one size with the current options. Returns { blob, filename }. */
export async function exportSize(sizeId, o = opts) {
  const size = SIZE_BY_ID[sizeId];
  const { bodies, built } = await bodiesFor(sizeId, o.format === 'stl' ? 'color' : o.split);
  const orientation = o.orient === 'auto' ? (state.design.mode === 'up' ? 'up' : 'down') : o.orient;
  const zTop = Math.max(built.t, ...built.layers.map(L => L.z1), ...built.solids.map(s => s.z1));
  const bedKey = o.format === 'prusa' ? (o.bed === 'auto' || !BEDS[o.bed]?.profile ? prusaBedFor(size) : o.bed) : (o.bed === 'auto' ? 'bambu-256' : o.bed);
  const bed = BEDS[bedKey];
  for (const b of bodies) orientForPrint(b.tris, orientation, zTop, bed);
  const base = `${slug(state.design.name)}-${sizeId}`;
  const title = `${state.design.name} ${sizeId}`;
  if (o.format === 'stl') return { blob: stlBlob(bodies.map(b => b.tris)), filename: `${base}.stl`, bed: bedKey, orientation };
  const parts = bodies.map(b => ({ name: b.name, tris: b.tris, extruder: extruderOf(b.color) }));
  if (o.format === 'bambu') return { blob: await buildBambu3MF({ bodies: parts, name: title }), filename: `${base}-bambu.3mf`, bed: bedKey, orientation };
  const ini = await profileText(bedKey);
  return { blob: await buildPrusa3MF({ bodies: parts, name: title, profileIni: ini }), filename: `${base}.3mf`, bed: bedKey, orientation, profiled: !!ini };
}

export function downloadBlob(blob, filename) {
  noteDownload(filename);   // the version history keeps the exact design every download was made from
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function exportAllZip(ids, onProgress) {
  const zip = new JSZip();
  let i = 0;
  for (const id of ids) {
    onProgress?.(i++, ids.length, id);
    const r = await exportSize(id);
    zip.file(r.filename, r.blob);
  }
  zip.file(`${slug(state.design.name)}.faceplate.json`, serializeDesign(state.design));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { blob, filename: `${slug(state.design.name)}-faceplates.zip` };
}

/** Fill a printer select for the current format (Export's and the first download's), and the line under it. */
function fillBeds(sel, noteEl) {
  const list = opts.format === 'prusa'
    ? [['auto', 'Automatic: Core One for 1W/2W, XL for 3W/4W'], ['prusa-coreone-mmu3', BEDS['prusa-coreone-mmu3'].label], ['prusa-xl-5t', BEDS['prusa-xl-5t'].label]]
    : Object.entries(BEDS).filter(([, b]) => !b.profile).map(([k, b]) => [k, b.label]);
  sel.innerHTML = '';
  for (const [v, l] of list) { const o = document.createElement('option'); o.value = v; o.textContent = l; sel.appendChild(o); }
  sel.value = list.some(([v]) => v === opts.bed) ? opts.bed : list[0][0];
  if (opts.bed !== sel.value) { opts.bed = sel.value; keepOpts(); }
  noteEl.textContent = opts.format === 'prusa' ? 'The PrusaSlicer files carry the same print, filament and printer profiles as the Chevron series (0.20 mm SPEED, MMU).' : opts.format === 'bambu' ? 'The plate is centred on the bed; pick your own print profile in the slicer.' : 'A single body with every colour merged; the plate is centred on the bed.';
}
function renderBedOptions() { fillBeds(els.bed, els.bedNote); }

/** Each colour slot and the extruder it prints on (the Style tab's order). */
function mapHtml() {
  const rows = state.design.colors.map((c, i) => `<div class="m"><span class="sw" style="background:${esc(c.hex)}"></span><span>${esc(c.name)}</span><span class="ext">extruder ${i + 1}</span></div>`).join('');
  return rows + (opts.format === 'stl' ? '<div class="m muted"><span></span><span>STL has no colours: everything merges into one body.</span><span></span></div>' : '');
}
function renderMap() { els.map.innerHTML = mapHtml(); }

/**
 * What to do once the file is in the slicer, for the chosen format: open it, check the profiles, match the
 * filaments to the colour list, and look at the layers where the decorated face prints before printing.
 */
function stepsHtml(where = 'export') {
  const list = where === 'card' ? 'listed above' : 'listed under Colour to extruder';
  const side = opts.orient === 'auto' ? (state.design.mode === 'up' ? 'up' : 'down') : opts.orient;
  const look = side === 'down'
    ? '<b>Slice, then check the first layers.</b> Face down, the decorated face is the first few layers on the bed. Drag the layer slider through them and make sure thin grooves and small letters are there before you print.'
    : '<b>Slice, then check the top layers.</b> Face up, the decorated face is the last few layers. Drag the layer slider through them and make sure thin grooves and small letters are there before you print.';
  const steps = opts.format === 'prusa' ? [
    '<b>Open it as a project.</b> In PrusaSlicer use File › Open project, or drag the 3MF in and choose Open as project, so the settings inside come with it. It opens as one object made of parts, each already on its extruder.',
    '<b>Check the profiles.</b> The file brings the print, filament and printer settings of the Chevron series (0.20 mm SPEED, Generic PLA). Change them if you print differently.',
    `<b>Load the filaments.</b> Put each colour on the extruder ${list}. The parts already know their extruders, so only the spools have to match.`,
    look,
  ] : opts.format === 'bambu' ? [
    '<b>Open it.</b> Drag the 3MF into Bambu Studio or OrcaSlicer. It opens as one object made of parts, each already on its filament number.',
    '<b>Pick your profiles.</b> The file carries no print settings: choose your printer, filament and process. The Chevron plates print with 0.20 mm layers.',
    `<b>Match the filaments.</b> Set filament 1, 2 and so on to the colours ${list}, on the slots that hold those spools.`,
    look,
  ] : [
    '<b>Import it.</b> The STL is one body with every colour merged, so it prints in one filament.',
    '<b>Pick your profiles.</b> Choose your printer, filament and print settings.',
    '<b>Want the colours?</b> Download a 3MF instead: it keeps each colour as its own part.',
    look,
  ];
  return steps.map(t => `<li>${t}</li>`).join('');
}
function renderSteps() { if (els.steps) els.steps.innerHTML = stepsHtml(); }

/**
 * The first download from the dock says how the files will be made: slicer, printer, which side prints down, the
 * colour slots and what is in the download, changeable right there. Once confirmed with "Don't ask again" it never
 * shows again in this browser (Export keeps every setting). Resolves true to download, false to cancel.
 */
export function confirmDownload(what) {
  if (prefs.get('exportConfirmed', false)) return Promise.resolve(true);
  const $ = s => document.querySelector(s);
  const cf = { card: $('#ws-confirm'), format: $('#cfFormat'), bed: $('#cfBed'), bedNote: $('#cfBedNote'), orient: $('#cfOrient'), map: $('#cfMap'), what: $('#cfWhat'), steps: $('#cfSteps'), again: $('#cfAgain'), go: $('#cfGo'), cancel: $('#cfCancel'), close: $('#cfClose') };
  if (!cf.card) return Promise.resolve(true);
  const fill = () => {
    cf.format.value = opts.format;
    fillBeds(cf.bed, cf.bedNote);
    const side = opts.orient === 'auto' ? (state.design.mode === 'up' ? 'up' : 'down') : opts.orient;
    cf.orient.textContent = `Face ${side}${opts.orient === 'auto' ? ', as the top bar says' : ' (set in Export)'}`;
    cf.map.innerHTML = mapHtml();
    cf.what.textContent = what;
    if (cf.steps) cf.steps.innerHTML = stepsHtml('card');
  };
  fill();
  cf.card.hidden = false;
  cf.go.focus();
  return new Promise(resolve => {
    const onFormat = () => { opts.format = cf.format.value; opts.bed = 'auto'; keepOpts(); fill(); renderExport(); };
    const onBed = () => { opts.bed = cf.bed.value; keepOpts(); renderExport(); };
    const onKey = ev => { if (ev.key === 'Escape') { ev.preventDefault(); done(false); } };
    const done = ok => {
      cf.card.hidden = true;
      cf.format.removeEventListener('change', onFormat); cf.bed.removeEventListener('change', onBed); document.removeEventListener('keydown', onKey, true);
      cf.go.onclick = cf.cancel.onclick = cf.close.onclick = null;
      if (ok && cf.again.checked) prefs.set('exportConfirmed', true);
      resolve(ok);
    };
    cf.format.addEventListener('change', onFormat); cf.bed.addEventListener('change', onBed); document.addEventListener('keydown', onKey, true);
    cf.go.onclick = () => done(true);
    cf.cancel.onclick = cf.close.onclick = () => done(false);
  });
}

const busy = new Set();   // sizes whose Download is running: a redraw must not hand back an enabled button

export function renderExport() {
  if (!visible) return;
  els.format.value = opts.format; els.orient.value = opts.orient; els.split.value = opts.split;
  renderBedOptions(); renderMap(); renderSteps();
  renderRows();
}

let drawRows;
function renderRows() { if (visible) drawRows?.(); }

function buildRows() {
  const d = state.design;
  els.rows.innerHTML = '';
  const ids = SIZES.filter(s => d.sizes.enabled.includes(s.id)).sort((a, b) => (a.hCells - b.hCells) || (a.wCells - b.wCells)).map(s => s.id);
  for (const id of ids) {
    const s = SIZE_BY_ID[id];
    const b = getBuild(id);
    const st = b.checks?.status;
    if (!st) ensureChecks(id, 50);
    const bedKey = opts.format === 'prusa' ? (opts.bed === 'auto' ? prusaBedFor(s) : opts.bed) : opts.bed;
    const fits = BEDS[bedKey] ? fitsBed(s, BEDS[bedKey]) : true;
    const li = document.createElement('li');
    li.className = 'exrow';
    li.dataset.k = `ex:${id}`;
    li.innerHTML = `<span class="tok">${esc(sizeToken(id))}</span><span class="info">${s.w} × ${s.h} mm · ${esc(BEDS[bedKey]?.label || '')}${fits ? '' : ' · <span class="bad">does not fit this bed</span>'}</span>` +
      `<span class="pill ${st || 'wait'}">${st === 'pass' ? 'Checks pass' : st === 'warn' ? 'Warning' : st === 'fail' ? 'Problem' : 'Checking'}</span>` +
      `<button class="key" type="button">${iconHtml('download-simple', 15)}Download</button>`;
    const btn = li.querySelector('button');
    btn.disabled = busy.has(id);
    btn.addEventListener('click', async () => {
      if (busy.has(id)) return;
      busy.add(id); renderRows();
      try { const r = await exportSize(id); downloadBlob(r.blob, r.filename); }
      catch (e) { console.error(e); alert(`Export failed: ${e.message}`); }
      busy.delete(id); renderRows();
    });
    els.rows.appendChild(li);
  }
  if (!ids.length) els.rows.innerHTML = '<li class="stack-empty">No sizes are ticked. Tick them in the Sizes tab or on All sizes.</li>';
  els.note.textContent = ids.length ? `${ids.length} of ${SIZES.length} sizes · problems still export` : '';
}

export function setExportVisible(v) { visible = v; if (v) renderExport(); }

export function initExportView(root) {
  els = { format: root.querySelector('#exFormat'), bed: root.querySelector('#exBed'), bedNote: root.querySelector('#exBedNote'), orient: root.querySelector('#exOrient'), split: root.querySelector('#exSplit'), map: root.querySelector('#exMap'), rows: root.querySelector('#exRows'), steps: root.querySelector('#exSteps'), note: root.querySelector('#exNote'), all: root.querySelector('#btnExportAll') };
  drawRows = panelRenderer(els.rows, buildRows);
  els.format.addEventListener('change', () => { opts.format = els.format.value; opts.bed = 'auto'; keepOpts(); renderExport(); });
  els.bed.addEventListener('change', () => { opts.bed = els.bed.value; keepOpts(); renderExport(); });
  els.orient.addEventListener('change', () => { opts.orient = els.orient.value; keepOpts(); renderSteps(); });
  els.split.addEventListener('change', () => { opts.split = els.split.value; keepOpts(); });
  els.all?.addEventListener('click', async () => {
    const ids = state.design.sizes.enabled;
    if (!ids.length) return;
    els.all.disabled = true;
    try {
      const r = await exportAllZip(ids, (i, n, id) => { els.all.textContent = `Building ${sizeToken(id)} (${i + 1}/${n})`; });
      downloadBlob(r.blob, r.filename);
    } catch (e) { console.error(e); alert(`Export failed: ${e.message}`); }
    els.all.disabled = false; els.all.textContent = 'Download all (zip)';
  });
  on('design', () => renderExport());
  on('checks', () => renderRows());
}

export const exportOptions = opts;
