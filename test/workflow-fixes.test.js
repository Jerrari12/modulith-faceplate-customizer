// Three fixes from the 2026-11-08 workflow review: a new pattern on a face-down design starts as a cut (a raise
// failed the checks at once), the series' grips report their real size, and a full-width grip stays centred side to
// side whatever its Offset X or anchor column (either used to push it off the plate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;

const P = await import('../js/geometry/polys.js');
const { buildFace, newElement, patternOp, flushOp, spansWidth, ELEMENT_DEFS } = await import('../js/geometry/face.js');
const { styleStart } = await import('../js/geometry/grips.js');
const { runChecks } = await import('../js/checks/checks.js');
const { newDesign } = await import('../js/export/design.js');
const { SIZES, SIZE_BY_ID } = await import('../js/data/sizes.js');
const { summary } = await import('../js/ui/actions.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);

test('a new pattern cuts grooves on a face-down design, and prints clean on every size', () => {
  const down = newDesign({ mode: 'down' }), up = newDesign({ mode: 'up' }), bare = newDesign({ mode: 'down' });
  bare.face = { ...bare.face, enabled: false };
  assert.equal(patternOp(down), 'cut');
  assert.equal(patternOp(up), 'raise');
  assert.equal(patternOp(bare), 'raise', 'no face to cut into');
  assert.equal(flushOp(down), 'inlay', 'text and shapes still inlay');
  const stripes = newElement('pattern', { op: patternOp(down) });
  down.elements.push(stripes);
  for (const size of SIZES) {
    const res = runChecks(buildFace(down, size), down, size);
    const bad = res.checks.filter(c => c.st === 'fail');
    assert.equal(bad.length, 0, `${size.id}: ${bad.map(c => c.lbl).join(', ')}`);
  }
});

test('the series grips report the size they are built at', () => {
  const grip = st => { const g = newElement('grip', { style: st }); Object.assign(g, styleStart(g, st)); return g; };
  assert.equal(summary(grip('classicpro')), 'full width × 27 × 23 mm · top edge');
  const classic = Object.assign(grip('classic'), { fullWidth: false, length: 40 });
  assert.equal(summary(classic), '56 × 27 × 23 mm · top edge', 'never shorter than a hood can be built');
  assert.equal(summary(grip('edgelabel')), 'corner hood · 27 × 17.6 mm · top right');
  assert.equal(summary(Object.assign(grip('edgelabel'), { corner: 'left' })), 'corner hood · 27 × 17.6 mm · top left');
  assert.equal(summary(newElement('grip')), '50 × 10 × 6 mm', 'the shaped styles as before');
  assert.equal(summary(newElement('grip', { fullWidth: true, flush: 'b' })), 'full width × 10 × 6 mm · bottom edge');
});

test('a full-width grip stays on the plate whatever Offset X or the anchor column say', () => {
  const xParam = ELEMENT_DEFS.grip.params.find(p => p.key === 'x');
  assert.equal(xParam.showIf.fullWidth, false, 'Offset X is hidden while Full width is on');
  const flush = newElement('grip', { style: 'lip', fullWidth: true, flush: 't', x: 30 });
  const free = newElement('grip', { style: 'wedge', fullWidth: true, anchor: 'l', x: -12, y: -5 });
  const corner = newElement('grip', { style: 'edgelabel', ...styleStart({}, 'edgelabel'), fullWidth: true });
  assert.ok(spansWidth(flush) && spansWidth(free) && !spansWidth(corner), 'EdgeLabel never spans the width');
  const d = newDesign({ mode: 'up', elements: [flush, free] });
  d.handles.mount = 'none'; d.handles.holes = false;
  for (const size of SIZES) {
    const b = buildFace(d, size);
    for (const el of [flush, free]) {
      const bb = P.bbox(b.solids.find(s => s.elementId === el.id).footprint);
      near(bb.x0, -size.w / 2, 1e-6, `${size.id} ${el.style}: left end`);
      near(bb.x1, size.w / 2, 1e-6, `${size.id} ${el.style}: right end`);
    }
  }
  // the offset is kept, and comes back when Full width goes off
  free.fullWidth = false;
  // (it now runs past the left edge, which cuts it: where it was placed is its unclipped footprint)
  const size = SIZE_BY_ID['2W-1H'], g = buildFace(d, size).solids.find(s => s.elementId === free.id), bb = P.bbox(g.unclipped || g.footprint);
  near((bb.x0 + bb.x1) / 2, -size.w / 2 - 12, 1e-6, 'anchored left, 12 mm further left');
  near(P.bbox(g.footprint).x0, -size.w / 2, 1e-6, 'cut at the plate edge');
});
