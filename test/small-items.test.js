// The four small items left from the 2026-11-08 workflow review: a texture's height settings say what they
// measure, its card can say which grid a size really meshes it on (the build carries it, and a big area is
// coarsened), and a pattern's own offset is named apart from an element's Offset X / Y.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;

const { buildFace, newElement, ELEMENT_DEFS } = await import('../js/geometry/face.js');
const { PATTERNS } = await import('../js/geometry/patterns.js');
const { SURFACE_GRIDS, SURFACE_LIMITS } = await import('../js/geometry/surface.js');
const { newDesign } = await import('../js/export/design.js');
const { SIZE_BY_ID } = await import('../js/data/sizes.js');

const label = (params, key) => params.find(p => p.key === key)?.label;

test('a texture names its height settings for what they measure', () => {
  const ps = ELEMENT_DEFS.surface.params;
  assert.equal(label(ps, 'depth'), 'Texture height');
  assert.equal(label(ps, 'base'), 'Base thickness');
  assert.match(ps.find(p => p.key === 'detail').help, /preview and the download alike/);
});

test('a pattern offset is named apart from an element offset, on every pattern that has one', () => {
  let n = 0;
  for (const [name, def] of Object.entries(PATTERNS)) {
    for (const p of def.params) {
      if (p.key === 'phaseX' || p.key === 'phaseY') {
        n++;
        assert.equal(p.label, p.key === 'phaseX' ? 'Pattern offset X' : 'Pattern offset Y', name);
        assert.ok(p.help, `${name} ${p.key} explains itself`);
      }
      assert.ok(!/^Shift /.test(p.label), `${name}: ${p.label}`);
    }
  }
  assert.ok(n >= 10, `found ${n} pattern offsets`);
  assert.equal(label(ELEMENT_DEFS.shape.params, 'x'), 'Offset X', 'an element still has Offset X');
});

test('heights out of the face all read "Stands out", and the rest of the review renames hold', () => {
  const grip = ELEMENT_DEFS.grip.params, solid = ELEMENT_DEFS.solid.params, mesh = ELEMENT_DEFS.mesh.params;
  assert.equal(label(ELEMENT_DEFS.shape.params, 'height'), 'Stands out', 'a raised shape');
  assert.equal(label(ELEMENT_DEFS.text.params, 'height'), 'Stands out', 'raised text');
  assert.equal(label(grip, 'height'), 'Stands out');
  assert.equal(label(solid, 'out'), 'Stands out');
  assert.equal(label(grip, 'depth'), 'Width', 'across the grip, beside its Length');
  assert.equal(label(solid, 'taper'), 'Top-to-base ratio');
  const base = mesh.find(p => p.key === 'base');
  assert.equal(base.label, 'Face under it');
  assert.deepEqual(base.options.map(o => o[0]), ['on', 'in'], 'the stored values are unchanged');
  for (const def of Object.values(PATTERNS)) for (const p of def.params) if (p.key === 'perSize') assert.equal(p.label, 'A different layout on each size');
  // within one kind, no two settings share a label (a block's Height and a grip's Height once meant different axes)
  for (const [kind, def] of Object.entries({ ...ELEMENT_DEFS, ...Object.fromEntries(Object.entries(PATTERNS).map(([k, v]) => [`pattern:${k}`, v])) })) {
    const seen = new Set();
    for (const p of def.params) { assert.ok(!seen.has(p.label), `${kind}: two settings called ${p.label}`); seen.add(p.label); }
  }
});

test('the build reports the grid a texture is meshed on: Fine as asked on a small plate, coarser on a big one', () => {
  const grids = {};
  for (const id of ['1W-1H', '2W-2H']) {
    const d = newDesign({ mode: 'up' });
    const tex = newElement('surface', { detail: 'fine' });
    d.elements.push(tex);
    const built = buildFace(d, SIZE_BY_ID[id]);
    const body = built.solids.find(s => s.elementId === tex.id && s.kind === 'surface');
    assert.ok(body, `${id} has the texture body`);
    grids[id] = body.grid;
  }
  assert.equal(grids['1W-1H'], SURFACE_GRIDS.fine, 'a 1W-1H face fits Fine');
  assert.ok(grids['2W-2H'] > SURFACE_GRIDS.fine + 0.05, `2W-2H is coarsened, got ${grids['2W-2H']}`);
  // the coarsened grid is the one that keeps the face's box under the cell limit
  const s = SIZE_BY_ID['2W-2H'];
  assert.ok(grids['2W-2H'] <= Math.sqrt((s.w * s.h) / SURFACE_LIMITS.maxCells) + 0.01, 'no coarser than it needs to be');
});
