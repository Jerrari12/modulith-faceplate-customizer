// The "hidden or lost" check (2026-11-08 workflow review): an element half or more covered by another, or half or
// more off a plate, warns on that size; stacking, a texture on an element's outline, nested image tones and an
// element's own symmetry twin never count against it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;

const T = await import('../js/geometry/text.js');
await T.loadFont('archivo');
const { buildFace, newElement } = await import('../js/geometry/face.js');
const { styleStart, LIP_PRESET } = await import('../js/geometry/grips.js');
const { runChecks } = await import('../js/checks/checks.js');
const { newDesign } = await import('../js/export/design.js');
const { SIZES, SIZE_BY_ID } = await import('../js/data/sizes.js');

const up = (...els) => { const d = newDesign({ mode: 'up', elements: els }); d.handles.mount = 'none'; d.handles.holes = false; return d; };
const hidden = (d, id) => { const s = SIZE_BY_ID[id]; return runChecks(buildFace(d, s), d, s).checks.filter(c => c.id === 'hidden'); };
const hood = () => { const g = newElement('grip', { style: 'classicpro' }); return Object.assign(g, styleStart(g, 'classicpro')); };

test('a label under the Classic Pro hood warns on the 0.5H sizes only, naming the hood', () => {
  const g = hood(), label = newElement('text', { op: 'inlay' });
  const d = up(g, label);
  for (const s of SIZES) {
    const h = hidden(d, s.id), warn = h.find(c => c.st === 'warn');
    if (s.id.endsWith('05H')) {
      assert.ok(warn, `${s.id}: warns`);
      assert.equal(warn.lbl, 'Text is hidden');
      assert.equal(warn.elementId, label.id);
      assert.match(warn.det, /Text “Label” is under Grip/);
    } else assert.deepEqual(h.map(c => c.st), ['pass'], `${s.id}: ${h.map(c => c.det).join(' / ')}`);
  }
  // the same holds when the label comes first in the stack: a body keeps its footprint either way
  assert.ok(hidden(up(label, g), '2W-05H').some(c => c.st === 'warn' && c.elementId === label.id));
});

test('a grip buried in a taller one warns, whichever comes first; side by side they do not', () => {
  const g = hood(), lip = Object.assign(newElement('grip'), LIP_PRESET);
  for (const d of [up(g, lip), up(lip, g)]) {
    const w = hidden(d, '2W-1H').filter(c => c.st === 'warn');
    assert.deepEqual(w.map(c => c.elementId), [lip.id], 'only the lip pull, inside the hood');
    assert.equal(w[0].lbl, 'Lip pull is hidden');
    assert.match(w[0].det, /move one of them\.$/, 'a body cannot be fixed by the stack order');
  }
  lip.flush = 'b';
  assert.deepEqual(hidden(up(g, lip), '2W-1H').map(c => c.st), ['pass'], 'lip pull on the bottom edge');
});

test('a flat element covered by a later one says how the stack can fix it', () => {
  const small = newElement('shape', { name: 'Dot', shape: 'circle', w: 10, op: 'raise', height: 1 });
  const big = newElement('shape', { name: 'Panel', w: 60, h: 40, op: 'raise', height: 2 });
  const w = hidden(up(small, big), '2W-1H').filter(c => c.st === 'warn');
  assert.equal(w.length, 1);
  assert.equal(w[0].elementId, small.id);
  assert.match(w[0].det, /put it above Panel in the stack/);
  assert.deepEqual(hidden(up(big, small), '2W-1H').map(c => c.st), ['pass'], 'on top of the panel it shows');
});

test('a label too big for the small plates runs off them, and fits the big ones', () => {
  const d = newDesign({ mode: 'down', elements: [newElement('text', { op: 'inlay', size: 40, text: 'MODULITH' })] });
  const w = hidden(d, '1W-05H').find(c => c.st === 'warn');
  assert.equal(w.lbl, 'Text runs off this size');
  assert.match(w.det, /About \d+% of Text “MODULITH” falls outside this 87 × 27\.15 mm plate/);
  assert.deepEqual(hidden(d, '4W-2H').map(c => c.st), ['pass']);
});

test('no false alarms: stacked blocks, a texture on the letters, symmetry twins', () => {
  const base = newElement('solid', { name: 'Base', w: 40, h: 12, out: 4 });
  const cap = newElement('solid', { name: 'Cap', w: 40, h: 12, out: 3, stackOn: base.id });
  assert.deepEqual(hidden(up(base, cap), '2W-1H').map(c => c.st), ['pass'], 'a block stacked on a block');
  const label = newElement('text', { op: 'raise' });
  const tex = newElement('surface', { region: 'element', target: label.id });
  assert.deepEqual(hidden(up(label, tex), '2W-1H').map(c => c.st), ['pass'], 'the texture dresses the letters');
  const near = newElement('shape', { w: 30, h: 10, x: 8, op: 'raise' });
  const d = up(near); d.symmetry = 'x';
  assert.deepEqual(hidden(d, '2W-1H').map(c => c.st), ['pass'], 'its own twin overlaps it');
});

test('Sol 01a1bcee: each loss is told as its own share', () => {
  // 35 % of the small shape hangs off the right edge of 2W-1H and another 25 % is under a later panel
  const small = newElement('shape', { name: 'Tab', w: 20, h: 10, x: 84.5, op: 'raise' });
  const panel = newElement('shape', { name: 'Panel', w: 18, h: 20, x: 70.5, op: 'raise', height: 2 });
  const w = hidden(up(small, panel), '2W-1H').filter(c => c.st === 'warn');
  assert.equal(w.length, 1);
  assert.equal(w[0].lbl, 'Tab runs off this size');
  assert.match(w[0].det, /About 35% of Tab falls outside this 175 × 55 mm plate, and about 25% is under Panel\./);
});
