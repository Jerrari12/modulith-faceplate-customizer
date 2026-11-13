// Pins per-size overrides and formulas (2026-11-11): a size builds from the master unless it changes a setting for
// itself, a formula is worked out on every size inside the setting's range, writes go to the master (this size then
// follows it) or to this size only, and a size is built and checked from what it really uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;

const V = await import('../js/variants.js');
const { newElement, buildFace } = await import('../js/geometry/face.js');
const { newDesign } = await import('../js/export/design.js');
const { SIZE_BY_ID } = await import('../js/data/sizes.js');
const P = await import('../js/geometry/polys.js');

const small = SIZE_BY_ID['1W-1H'], wide = SIZE_BY_ID['4W-1H'], mid = SIZE_BY_ID['2W-1H'];

test('the master, an override for one size, and a formula on every size', () => {
  const el = newElement('shape', { shape: 'rect', w: 40, h: 10 });
  assert.equal(V.elementOn(el, mid), el, 'nothing differs: the same object');
  V.setOn(el, 'w', 20, small, 'size');
  assert.equal(V.valueOn(el, 'w', small), 20); assert.equal(V.valueOn(el, 'w', mid), 40, 'other sizes keep the master');
  assert.deepEqual(V.overridesOn(el, small), ['w']); assert.deepEqual(V.sizesOverriding(el, 'w'), ['1W-1H']);
  // a formula on the master: worked out per size, inside the setting's range (shape width 2..400)
  V.setOn(el, 'w', '=W-20', mid, 'all');
  assert.equal(el.expr.w, '=W-20'); assert.equal(el.w, mid.w - 20, 'the stored value is what it came to here');
  assert.equal(V.valueOn(el, 'w', wide), wide.w - 20);
  assert.equal(V.valueOn(el, 'w', small), 20, 'the override still wins on its size');
  V.setOn(el, 'h', '=H*10', mid, 'all');
  assert.equal(V.valueOn(el, 'h', mid), 200, 'clamped to the height range (max 200)');
  // a plain value on the master clears the formula; resetting brings a size back to the master
  V.setOn(el, 'h', 12, mid, 'all');
  assert.equal(el.expr?.h, undefined); assert.equal(V.valueOn(el, 'h', wide), 12);
  V.resetOn(el, 'w', small);
  assert.equal(V.valueOn(el, 'w', small), small.w - 20); assert.equal(el.bySize, undefined, 'no empty records left behind');
});

test('writing for every size makes the shown size follow the master again; this-size writes stay put', () => {
  const el = newElement('text', { text: 'KITCHEN', size: 12 });
  V.setOn(el, 'size', 8, small, 'size'); V.setOn(el, 'text', 'K', small, 'size'); V.setOn(el, 'size', 16, wide, 'size');
  V.setOn(el, 'size', 10, small, 'all');
  assert.equal(V.valueOn(el, 'size', small), 10, 'the small plate shows the new master');
  assert.equal(V.valueOn(el, 'size', wide), 16, 'the wide plate keeps its own');
  assert.equal(V.valueOn(el, 'text', small), 'K', 'and other settings it changed stay changed');
  // a formula typed while only this size is being changed is worked out here and kept as its value
  assert.equal(V.setOn(el, 'size', '=H/5', small, 'size'), small.h / 5);
  assert.equal(el.bySize['1W-1H'].size, small.h / 5);
  // what cannot change per size, or take a formula
  assert.throws(() => V.setOn(el, 'text', '=W', small, 'all'), /only a number setting/);
  assert.throws(() => V.setOn(el, 'size', '=W-', small, 'all'), /stops/);
  V.setOn(el, 'color', 'c3', small, 'size');
  assert.equal(el.color, 'c3', 'a colour has no per-size value: it changes for every size');
  // a broken formula in a file falls back to the stored value
  const bad = { ...newElement('shape', { w: 33 }), expr: { w: '=Q+1' } };
  assert.equal(V.valueOn(bad, 'w', mid), 33);
});

test('a size is built from what it uses', () => {
  const bar = newElement('shape', { shape: 'rect', w: 30, h: 8, op: 'raise' });
  V.setOn(bar, 'w', '=W-20', mid, 'all');
  V.setOn(bar, 'h', 4, small, 'size');
  const d = newDesign({ elements: [bar] }); d.handles.mount = 'none'; d.handles.holes = false;
  const widthOn = size => { const b = P.bbox(buildFace(V.designOn(d, size), size).layers.find(L => L.elementId === bar.id).poly); return [+(b.x1 - b.x0).toFixed(3), +(b.y1 - b.y0).toFixed(3)]; };
  assert.deepEqual(widthOn(mid), [mid.w - 20, 8]);
  assert.deepEqual(widthOn(wide), [wide.w - 20, 8]);
  assert.deepEqual(widthOn(small), [small.w - 20, 4], 'the override on its own size');
  assert.equal(V.designOn(newDesign({ elements: [newElement('shape')] }), mid).elements.length, 1);
  const plain = newDesign({ elements: [newElement('shape')] });
  assert.equal(V.designOn(plain, mid), plain, 'a design with no overrides or formulas is used as it is');
});

test('the design file keeps formulas and per-size values, and drops what does not belong', async () => {
  const { serializeDesign, parseDesign } = await import('../js/export/design.js');
  const t = newElement('text', { text: 'PANTRY', size: 12 });
  V.setOn(t, 'size', '=H/5', mid, 'all'); V.setOn(t, 'text', 'P', small, 'size'); V.setOn(t, 'x', -12.5, wide, 'size');
  const back = parseDesign(serializeDesign(newDesign({ elements: [t] }))).elements[0];
  assert.deepEqual(back.expr, { size: '=H/5' }); assert.deepEqual(back.bySize, { '1W-1H': { text: 'P' }, '4W-1H': { x: -12.5 } });
  assert.equal(V.valueOn(back, 'size', wide), wide.h / 5);
  // junk from a file: formulas that do not parse or sit on a non-number, unknown sizes and settings, wrong kinds
  const junk = parseDesign({ elements: [{ kind: 'shape', w: 30, expr: { w: '=W-', h: '=H/2', color: '=W', op: 'raise', nope: '=1' },
    bySize: { '9W-9H': { w: 10 }, '2W-1H': { w: '15', h: 'tall', op: 'melt', color: 'c3', visible: false, constructor: 1 }, '1W-1H': { w: 99999 }, '4W-1H': 'x' } }] }).elements[0];
  assert.deepEqual(junk.expr, { h: '=H/2' }, 'only the formula that parses, on a number setting');
  assert.deepEqual(junk.bySize, { '2W-1H': { w: 15 }, '1W-1H': { w: 400 } }, 'known sizes, settings a size can change, values of their kind (clamped)');
  assert.equal(junk.w, 30);
  // a formula that cannot be worked out on one plate is kept for the others (Sol 01a1cc22)
  const odd = parseDesign({ elements: [{ kind: 'shape', w: 30, expr: { w: '=W-20+1/(W-100)' } }] }).elements[0];
  assert.equal(odd.expr?.w, '=W-20+1/(W-100)');
  assert.ok(Math.abs(V.valueOn(odd, 'w', mid) - (mid.w - 20 + 1 / (mid.w - 100))) < 1e-9);
  assert.equal(V.valueOn(odd, 'w', { id: 'x', w: 100, h: 50 }), 30, 'where it cannot be worked out, the stored value');
});

test('the inspector view: reads this size, writes for every size or this one, refuses a broken formula', () => {
  const el = newElement('shape', { w: 40 });
  let scope = 'all', said = '';
  const view = V.viewOn(el, small, () => scope, e => { said = e.message; });
  view.w = '=W/2';
  assert.equal(view.w, small.w / 2); assert.equal(view[V.FORMULA]('w'), '=W/2', 'the field shows the formula');
  scope = 'size'; view.w = 12;
  assert.equal(view.w, 12); assert.equal(view[V.FORMULA]('w'), null, 'this size has its own value, so no formula to show');
  assert.equal(V.valueOn(el, 'w', wide), wide.w / 2, 'other sizes still follow the formula');
  scope = 'all'; view.h = '=H*';
  assert.match(said, /stops/); assert.equal(el.h, 20, 'a broken formula changes nothing');
  view.color = 'c3'; assert.equal(el.color, 'c3');
  view.anything = 5; assert.equal(el.anything, 5, 'non-settings pass straight through');
});

test('settings drawn by their own pickers stay the same on every size', async () => {
  const { parseDesign } = await import('../js/export/design.js');
  const t = newElement('text', { text: 'OFFICE' });
  V.setOn(t, 'font', 'mono', small, 'size');
  assert.equal(t.font, 'mono', 'a font goes to the master even while only this size is changed');
  assert.equal(t.bySize, undefined);
  assert.equal(V.canOverride(t, 'flush'), false); assert.equal(V.canOverride(t, 'anchor'), false);
  assert.equal(V.canOverride(newElement('shape'), 'shape'), false, 'a shape\'s outline is its own picker');
  assert.equal(V.canOverride(newElement('surface'), 'shape'), true, 'a surface\'s outline is an ordinary choice');
  const back = parseDesign({ elements: [{ kind: 'text', text: 'A', bySize: { '1W-1H': { font: 'mono', anchor: 'tl', flush: 't', size: 9 } } }] }).elements[0];
  assert.deepEqual(back.bySize, { '1W-1H': { size: 9 } }, 'a file cannot give a size its own font, slot or edge');
});

test('a this-size value equal to what the size gets anyway is not kept as its own', () => {
  const el = newElement('shape', { w: 40, x: 5, y: 0 });
  V.setOn(el, 'x', 22, wide, 'size'); V.setOn(el, 'y', 0, wide, 'size');   // a drag along x writes y unchanged
  assert.deepEqual(el.bySize, { '4W-1H': { x: 22 } }, 'y equals the master: no own value, no badge');
  V.setOn(el, 'x', 5, wide, 'size');
  assert.equal(el.bySize, undefined, 'moved back onto the master: no longer its own');
  V.setOn(el, 'w', '=W-20', mid, 'all');
  V.setOn(el, 'w', wide.w - 20, wide, 'size');
  assert.equal(el.bySize, undefined, 'equal to what the formula gives there');
});
