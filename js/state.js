// Application state: the design, selection, view toggles, undo history, build cache and local persistence.
// Views subscribe to events and re-render; mutations go through commit() so history and storage stay in step.

import { newDesign, parseDesign, serializeDesign } from './export/design.js';
import { buildFace } from './geometry/face.js';
import { runChecks } from './checks/checks.js';
import { SIZE_BY_ID, SIZES } from './data/sizes.js';
import { history, newLineage } from './history.js';
import { designOn } from './variants.js';

const LS_CURRENT = 'fpc:current', LS_SAVED = 'fpc:saved', LS_PREFS = 'fpc:prefs';

export const state = {
  design: null,
  selectedId: null,
  view: 'design',
  stage: '2d',
  wall: false, grid: true, dims: true, issues: true,
  version: 0,
  builds: new Map(),     // sizeId -> { built, checks|null, version }
  undo: [], redo: [],
  scope: 'all',          // 'all': edits change the master (every size); 'size': only the size shown (variants.js)
  highlight: null,       // { at: [x, y], st } from a clicked check
  pathPoint: null,       // the chosen point of the selected drawing (ui/pen.js)
};

const listeners = new Map();
export function on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); return () => listeners.get(ev).delete(fn); }
export function emit(ev, data) { for (const fn of listeners.get(ev) || []) { try { fn(data); } catch (e) { console.error(`listener for ${ev} failed`, e); } } }

function safeGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function safeSet(key, v) { try { localStorage.setItem(key, v); return true; } catch { return false; } }

export const prefs = (() => {
  let p = {};
  try { p = JSON.parse(safeGet(LS_PREFS) || '{}') || {}; } catch { p = {}; }
  return {
    get: (k, d) => (p[k] === undefined ? d : p[k]),
    set: (k, v) => { p[k] = v; safeSet(LS_PREFS, JSON.stringify(p)); },
  };
})();

let lastSnapshot = '';
// a snapshot is a design file and carries the time it was written: two snapshots hold the same design when the rest
// matches, so a commit that changed nothing adds no undo step
const SAVED_AT = /"saved": "[^"]*"/;
const sameDesign = (a, b) => a.replace(SAVED_AT, '') === b.replace(SAVED_AT, '');

export function currentSize() { return SIZE_BY_ID[state.design.sizes.current] || SIZES[6]; }
export function selectedElement() { return state.design.elements.find(e => e.id === state.selectedId) || null; }
export function colorHex(id) { const c = state.design.colors.find(c => c.id === id); return c ? c.hex : '#888888'; }
export function colorName(id) { const c = state.design.colors.find(c => c.id === id); return c ? c.name : id; }

export function setDesign(design, { resetHistory = true } = {}) {
  state.design = design;
  state.selectedId = null;
  state.scope = 'all';
  state.builds.clear();
  state.version++;
  lastSnapshot = serializeDesign(design);
  if (resetHistory) { state.undo = []; state.redo = []; }
  autosave();
  emit('design', { reason: 'load' });
  emit('select');
}

/** Call after mutating state.design in place. Records history, invalidates builds and notifies views. */
export function commit(label = 'Edit') {
  const snap = serializeDesign(state.design);
  if (sameDesign(snap, lastSnapshot)) { emit('design', { reason: label, same: true }); return; }
  state.undo.push(lastSnapshot);
  if (state.undo.length > 100) state.undo.shift();
  state.redo = [];
  lastSnapshot = snap;
  state.builds.clear();
  state.version++;
  autosave();
  remember(snap, { action: label });
  emit('design', { reason: label });
}

/** Live preview while dragging: rebuilds without touching history. */
export function preview() {
  state.builds.clear();
  state.version++;
  emit('design', { reason: 'preview', preview: true });
}

export function undo() {
  if (!state.undo.length) return;
  state.redo.push(lastSnapshot);
  lastSnapshot = state.undo.pop();
  state.design = parseDesign(lastSnapshot);
  if (!state.design.elements.some(e => e.id === state.selectedId)) state.selectedId = null;
  state.builds.clear(); state.version++; autosave();
  remember(lastSnapshot, { action: 'Undo' });
  emit('design', { reason: 'undo' }); emit('select');
}

export function redo() {
  if (!state.redo.length) return;
  state.undo.push(lastSnapshot);
  lastSnapshot = state.redo.pop();
  state.design = parseDesign(lastSnapshot);
  if (!state.design.elements.some(e => e.id === state.selectedId)) state.selectedId = null;
  state.builds.clear(); state.version++; autosave();
  remember(lastSnapshot, { action: 'Redo' });
  emit('design', { reason: 'redo' }); emit('select');
}

export function select(id) {
  if (state.selectedId === id) return;
  state.selectedId = id;
  state.highlight = null;
  state.pathPoint = null;
  emit('select');
}

/** Build (synchronously) and cache the face for a size; checks run later via ensureChecks. */
export function getBuild(sizeId) {
  const size = SIZE_BY_ID[sizeId];
  let b = state.builds.get(sizeId);
  if (b && b.version === state.version) return b;
  // each size is built (and checked, below) from what it really uses: its own overrides and formulas worked out
  const design = designOn(state.design, size);
  const built = buildFace(design, size);
  b = { built, checks: null, version: state.version, size, design };
  state.builds.set(sizeId, b);
  return b;
}

const pendingChecks = new Map();
/** Run the checks for a size off the current frame; emits 'checks' with { sizeId } when done. */
export function ensureChecks(sizeId, delay = 120) {
  const b = getBuild(sizeId);
  if (b.checks) return b.checks;
  if (pendingChecks.has(sizeId)) clearTimeout(pendingChecks.get(sizeId));
  pendingChecks.set(sizeId, setTimeout(() => {
    pendingChecks.delete(sizeId);
    const cur = getBuild(sizeId);
    if (cur.checks) return;
    try { cur.checks = runChecks(cur.built, cur.design, cur.size); }
    catch (e) { console.error(e); cur.checks = { checks: [{ id: 'err', st: 'fail', lbl: 'Checks failed', det: String(e.message || e), short: 'checks failed' }], status: 'fail', counts: { fail: 1 } }; }
    emit('checks', { sizeId });
  }, delay));
  return null;
}

export function enabledSizes() { return SIZES.filter(s => state.design.sizes.enabled.includes(s.id)); }

// ---- persistence
export function autosave() { safeSet(LS_CURRENT, serializeDesign(state.design)); }

export function loadAutosave() {
  const raw = safeGet(LS_CURRENT);
  if (!raw) return null;
  try { return parseDesign(raw); } catch { return null; }
}

export function savedDesigns() {
  try { return JSON.parse(safeGet(LS_SAVED) || '[]') || []; } catch { return []; }
}

// The open design's entry in this browser's list (null until it has one), remembered across visits, so a design is
// kept as itself and never over another design that happens to share its name.
export function keptId() { const id = prefs.get('keptId', null); return typeof id === 'string' ? id : null; }
/**
 * Name the open design's entry (null: it has none yet). Its version history follows: an entry carries its lineage
 * (an older entry, its own id); a design with no entry starts a lineage of its own. The design as it opens is kept
 * as a version, unless it is empty.
 */
export function setKept(id) {
  prefs.set('keptId', id || null);
  const entry = id ? savedDesigns().find(d => d.id === id) : null;
  prefs.set('histId', entry ? entry.hist || entry.id : id || newLineage());
  if (state.design && state.design.elements.length) remember(serializeDesign(state.design), { action: 'Opened' });
}

// ---- version history (history.js): every state of the open design, folded into 10-minute steps

/** The open design's history lineage, made on first use. */
export function lineage() {
  let id = prefs.get('histId', null);
  if (typeof id !== 'string' || !id) {
    // the open design's entry decides, even when no setKept ran this visit (an autosave restored at boot): an entry
    // kept before histories existed is its own lineage, as setKept would make it (Sol 01a1cb9b)
    const k = keptId(), entry = k ? savedDesigns().find(d => d.id === k) : null;
    id = entry ? entry.hist || entry.id : newLineage();
    prefs.set('histId', id);
  }
  return id;
}
function remember(json, opts) {
  return history.record(lineage(), json, opts).then(v => { emit('history', v); return v; }, e => { console.warn('version history: not kept', e); return null; });
}
/** A version of the open design under a name, kept until it is deleted. Asks the browser to keep its storage. */
export function saveVersion(name) {
  globalThis.navigator?.storage?.persist?.().catch(() => {});
  return remember(serializeDesign(state.design), { kind: 'saved', label: String(name || '').trim() || `Saved ${new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` });
}
/** A download of the open design (a faceplate file, a zip, the design file): its exact state is kept with the file's name. */
export function noteDownload(filename) {
  return remember(serializeDesign(state.design), { kind: 'download', label: String(filename || 'download') });
}
/**
 * Bring an earlier version back as the open design: one undo step, so Ctrl+Z returns to what was open, and a step of
 * its own in the history saying where it came from.
 */
export function restoreVersion(json, note = '') {
  const d = parseDesign(json);
  state.undo.push(lastSnapshot);
  if (state.undo.length > 100) state.undo.shift();
  state.redo = [];
  state.design = d;
  lastSnapshot = serializeDesign(d);
  if (!d.elements.some(e => e.id === state.selectedId)) state.selectedId = null;
  state.builds.clear(); state.version++; autosave();
  const done = history.record(lineage(), lastSnapshot, { action: 'Restore', note, newStep: true }).then(v => { emit('history', v); return v; }, e => { console.warn('version history: not kept', e); return null; });
  emit('design', { reason: 'Restore version' }); emit('select');
  return done;
}

/** Put the open design in this browser's list, most recent first. False when the browser's storage refuses it. */
export function saveLocal() {
  const list = savedDesigns();
  const name = state.design.name || 'Untitled faceplate', json = serializeDesign(state.design), mine = keptId();
  let i = mine ? list.findIndex(d => d.id === mine) : -1;
  // a design kept before entries were told apart: the same name holding the same design is its entry
  if (i < 0) i = list.findIndex(d => d.name === name && sameDesign(d.json, json));
  const entry = { id: i >= 0 ? list[i].id : `d_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, saved: new Date().toISOString(), json, hist: lineage() };
  if (i >= 0) list.splice(i, 1);
  list.unshift(entry);
  // no cap on the count: dropping the oldest would lose a design; the browser's storage is the limit, and says so
  if (!safeSet(LS_SAVED, JSON.stringify(list))) return false;
  setKept(entry.id);
  emit('saved');
  return true;
}

/**
 * Keep the open design in this browser's list before another takes its place, unless it is empty or its entry
 * already holds it as it is. Returns its name when it was kept, '' when there was nothing to keep, and null when
 * the browser's storage refused it (the caller must not drop the design then).
 */
export function keepCurrent() {
  const d = state.design;
  if (!d || !d.elements.length) return '';
  const mine = savedDesigns().find(e => e.id === keptId());
  if (mine && sameDesign(mine.json, serializeDesign(d))) return '';
  return saveLocal() ? d.name : null;
}

export function deleteLocal(id) {
  const list = savedDesigns().filter(d => d.id !== id);
  safeSet(LS_SAVED, JSON.stringify(list));
  emit('saved');
}

export function loadLocal(id) {
  const d = savedDesigns().find(d => d.id === id);
  if (!d) return false;
  setDesign(parseDesign(d.json));
  setKept(id);
  return true;
}

export function fresh() { setDesign(newDesign()); setKept(null); }
