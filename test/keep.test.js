// Nothing is lost by starting or opening another design (2026-11-08 workflow review): the open design is kept in this
// browser's list first, entries are told apart by identity rather than name, an unchanged or empty design is not
// kept twice, and a full browser storage says so instead of dropping the design.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;

// this browser's storage, with a switch to make it full
const store = new Map();
let full = false;
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { if (full) throw new Error('QuotaExceededError'); store.set(k, String(v)); },
  removeItem: k => store.delete(k),
};

const S = await import('../js/state.js');
const { newDesign, serializeDesign, parseDesign } = await import('../js/export/design.js');
const { newElement } = await import('../js/geometry/face.js');

const open = d => { S.setDesign(d); S.setKept(null); };
const withShape = (name, w) => newDesign({ name, elements: [newElement('shape', { w })] });

test('an empty design is not kept; one with something on it is, once', () => {
  store.clear();
  open(newDesign());
  assert.equal(S.keepCurrent(), '', 'nothing to keep');
  assert.equal(S.savedDesigns().length, 0);
  open(withShape('Hall', 30));
  assert.equal(S.keepCurrent(), 'Hall');
  assert.equal(S.keepCurrent(), '', 'already kept as it is');
  S.state.design.elements[0].w = 40;
  assert.equal(S.keepCurrent(), 'Hall', 'changed since');
  assert.equal(S.savedDesigns().length, 1, 'the same entry, updated');
  assert.equal(JSON.parse(S.savedDesigns()[0].json).design.elements[0].w, 40);
});

test('two designs that share a name are both kept', () => {
  store.clear();
  open(withShape('Untitled faceplate', 20)); S.keepCurrent();
  open(withShape('Untitled faceplate', 50)); S.keepCurrent();
  const list = S.savedDesigns();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map(e => JSON.parse(e.json).design.elements[0].w).sort(), [20, 50]);
  assert.notEqual(list[0].id, list[1].id);
});

test('an entry kept before entries had identities is found again, not copied', () => {
  store.clear();
  const d = withShape('Kitchen', 25);
  store.set('fpc:saved', JSON.stringify([{ id: 'd_old', name: 'Kitchen', saved: '2026-11-01T00:00:00.000Z', json: serializeDesign(d) }]));
  open(d);
  S.state.design.elements[0].w = 26;
  // a changed design with no entry of its own gets one; the old entry is left as it was
  assert.equal(S.keepCurrent(), 'Kitchen');
  assert.equal(S.savedDesigns().length, 2);
  store.clear();
  store.set('fpc:saved', JSON.stringify([{ id: 'd_old', name: 'Kitchen', saved: '2026-11-01T00:00:00.000Z', json: serializeDesign(d) }]));
  open(parseDesign(serializeDesign(d)));
  S.saveLocal();
  assert.deepEqual(S.savedDesigns().map(e => e.id), ['d_old'], 'the same name and design is that entry');
  assert.equal(S.keptId(), 'd_old');
});

test('a full browser storage says so instead of dropping the design', () => {
  store.clear();
  open(withShape('Garage', 30));
  full = true;
  try { assert.equal(S.keepCurrent(), null); } finally { full = false; }
  assert.equal(S.savedDesigns().length, 0);
});
