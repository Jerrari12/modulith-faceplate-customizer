// Pins the defects the 2026-11-05 Sol review found (thread 01a1ae75), so they stay fixed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;

const P = await import('../js/geometry/polys.js');
const { generatePattern } = await import('../js/geometry/patterns.js');
const { buildFace, newElement } = await import('../js/geometry/face.js');
const { runChecks } = await import('../js/checks/checks.js');
const { newDesign } = await import('../js/export/design.js');
const { fitsBed, BEDS } = await import('../js/export/orient.js');
const { SIZE_BY_ID } = await import('../js/data/sizes.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);

test('chevron matches the series: grooves every 14 mm along the top edge, first at 3.5 mm, strips rising to the centre', () => {
  const W = 87, H = 55;
  const c = generatePattern('chevron', {}, W, H);
  // along the top edge (just inside), from the top-left corner: grooves at 3.5 + 14k, solid half way between
  for (let k = 0; k < 3; k++) {
    const gx = -W / 2 + 3.5 + 14 * k, sx = gx + 7;
    assert.ok(!P.contains(c, gx, H / 2 - 0.05), `groove at ${3.5 + 14 * k} mm from the corner`);
    assert.ok(P.contains(c, sx, H / 2 - 0.05), `solid at ${10.5 + 14 * k} mm from the corner`);
  }
  // the same groove, 14 mm lower, sits 14 mm further right: x + y(down) is constant on a groove ("/" on the left half)
  assert.ok(!P.contains(c, -W / 2 + 17.5, H / 2 - 14), 'groove line runs down-left to up-right on the left half');
  // 14 strips on 1W-1H as the Chevron series counts them (EXPECT_STRIPS), plus up to one corner sliver per half
  const plate = P.rect(-W / 2, -H / 2, W / 2, H / 2);
  const strips = P.intersection(c, plate);
  assert.ok(strips.length >= 14 && strips.length <= 16, `strip count on 1W-1H: ${strips.length}`);
  // perpendicular groove is 0.25: fill ratio = (perp - 0.25) / perp with perp = 14 cos 45
  const perp = 14 * Math.SQRT1_2;
  near(P.area(strips) / (W * H), (perp - 0.25) / perp, 0.012, 'fill ratio (seam and clipping aside)');
});

test('grid lines follow the angle parameter', () => {
  const a0 = generatePattern('grid', { angle: 0 }, 87, 55), a45 = generatePattern('grid', { angle: 45 }, 87, 55);
  assert.ok(P.contains(a0, 0, 3) && P.contains(a0, 3, 0), 'axis grid passes through the origin both ways');
  assert.ok(!P.contains(a0, 3, 3), 'the axis grid leaves (3, 3) clear');
  assert.ok(P.contains(a45, 3, 3) && P.contains(a45, 3, -3), 'a 45 degree grid runs along both diagonals');
  assert.ok(!P.contains(a45, 3, 0), 'the 45 degree grid leaves (3, 0) clear');
});

test('a raise over a pocket is an island even when its other pieces are supported', () => {
  const size = SIZE_BY_ID['2W-1H'];
  const design = newDesign({ mode: 'up' });
  design.handles.holes = false;
  design.elements.push(newElement('shape', { name: 'Pocket', shape: 'circle', w: 6, op: 'cut', depth: 1, x: 0, y: 0 }));
  design.elements.push(newElement('pattern', { name: 'Dots', pattern: 'dots', params: { pitchX: 8, pitchY: 8, diameter: 2, stagger: false }, op: 'raise', height: 1 }));
  const res = runChecks(buildFace(design, size), design, size);
  const c = res.checks.find(x => x.id === 'support');
  assert.equal(c.st, 'fail', `the dot over the pocket floats: ${c.lbl}`);
  assert.match(c.lbl, /floats/);
});

test('face down: a shorter raise inside a channel of taller relief starts in mid-air', () => {
  const size = SIZE_BY_ID['2W-1H'];
  const design = newDesign();
  design.handles.holes = false;
  // tall relief everywhere but a 3 mm channel, and a short raise inside the channel
  design.elements.push(newElement('shape', { name: 'Tall', shape: 'rect', w: 180, h: 60, op: 'raise', height: 2 }));
  design.elements.push(newElement('shape', { name: 'Channel', shape: 'rect', w: 3, h: 60, op: 'cut', depth: 4 }));
  design.elements.push(newElement('shape', { name: 'Short', shape: 'rect', w: 2, h: 2, op: 'raise', height: 1 }));
  const res = runChecks(buildFace(design, size), design, size);
  assert.equal(res.checks.find(x => x.id === 'levels')?.st, 'fail', 'raised features at two heights');
});

test('grips: a wedge with a recess under its overhang but not its base is supported; later raises do not grow into a grip', () => {
  const size = SIZE_BY_ID['2W-1H'];
  const design = newDesign({ mode: 'up' });
  design.handles.holes = false;
  // an 8 mm wedge with 3 mm undercuts has a 2 mm base; a 3 mm recess sits under one overhanging side only
  design.elements.push(newElement('shape', { name: 'Recess', shape: 'rect', w: 60, h: 2.5, op: 'cut', depth: 1, y: -10 + 2.5 }));
  design.elements.push(newElement('grip', { name: 'Pull', style: 'wedge', depth: 8, undercut: 3, height: 6, length: 50, y: -10 }));
  let built = buildFace(design, size);
  let res = runChecks(built, design, size);
  assert.ok(!res.checks.some(c => c.id === 'gripbase'), 'base is on flat face; the overhang may hang over the recess');
  near(P.bbox(built.solids[0].base).h, 2, 1e-9, 'wedge base is 2 mm deep');
  // a raise added after the grip stops where the grip has material in the raise's height: the 2 mm base and the
  // first 0.5 mm of each undercut (they rise 2 mm per mm), so the pad keeps going under the overhangs
  design.elements.push(newElement('shape', { name: 'Pad', shape: 'rect', w: 100, h: 30, op: 'raise', height: 1, y: -10 }));
  built = buildFace(design, size);
  const pad = built.layers.find(L => L.name === 'Pad');
  near(P.area(pad.poly), 100 * 30 - 50 * 3, 1e-6, 'pad minus where the grip is within its height');
  // and a grip added after a raise takes the raise's place inside its footprint
  const d2 = newDesign({ mode: 'up' }); d2.handles.holes = false;
  d2.elements.push(newElement('shape', { name: 'Pad', shape: 'rect', w: 100, h: 30, op: 'raise', height: 1 }));
  d2.elements.push(newElement('grip', { name: 'Pull', style: 'bar', depth: 8, height: 6, length: 50 }));
  const b2 = buildFace(d2, size);
  near(P.area(b2.layers.find(L => L.name === 'Pad').poly), 100 * 30 - 50 * 8, 1e-6, 'earlier raise carved under the grip');
  assert.ok(!runChecks(b2, d2, size).checks.some(c => c.id === 'gripbase'), 'the slab under the grip still supports it');
});

test('a 4W plate fits the Prusa XL bed', () => {
  assert.ok(fitsBed(SIZE_BY_ID['4W-2H'], BEDS['prusa-xl-5t']));
  assert.ok(!fitsBed(SIZE_BY_ID['4W-2H'], BEDS['prusa-coreone-mmu3']));
  assert.ok(fitsBed(SIZE_BY_ID['2W-3H'], BEDS['prusa-coreone-mmu3']));
});

// UI review (thread 01a1aec1): a commit that changes nothing must not add an undo step. Snapshots carry their save
// time, so comparing them whole never matched and every repeated commit became an empty undo.
test('a commit that changes nothing adds no undo step, and undo returns the last real change', async () => {
  const S = await import('../js/state.js');
  S.setDesign(newDesign({ name: 'undo test' }));
  S.state.design.face.thickness = 1.2; S.commit('Face thickness');
  assert.equal(S.state.undo.length, 1);
  await new Promise(r => setTimeout(r, 5));   // a later save time, as in the app
  S.commit('Face thickness');
  assert.equal(S.state.undo.length, 1, 'the repeated commit added an undo step');
  S.undo();
  assert.equal(S.state.design.face.thickness, 2);
});
