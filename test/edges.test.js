// Stripes that start clear of the edges, and the pattern edge tidy: slivers along the plate edge and round the
// holes taken away, thickened, or kept; thin stripes running into the edge and square corners left alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;

const P = await import('../js/geometry/polys.js');
const { generatePattern, patternDefaults } = await import('../js/geometry/patterns.js');
const { tidyEdges, EDGE_MIN } = await import('../js/geometry/edges.js');
const { buildFace, newElement } = await import('../js/geometry/face.js');
const { runChecks, PRINT_LIMITS } = await import('../js/checks/checks.js');
const { newDesign, serializeDesign, parseDesign } = await import('../js/export/design.js');
const { SIZES, SIZE_BY_ID } = await import('../js/data/sizes.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);
const OLD = { pitch: 10, width: 6, angle: 0, anchor: 'center', phaseX: 0, phaseY: 0 };   // the stripes before
const plateOf = (size, holes = []) => {
  const W = size.w, H = size.h, plate = P.rect(-W / 2, -H / 2, W / 2, H / 2);
  return { W, H, holes, keep: holes.length ? P.difference(plate, P.union(...holes.map(h => P.circle(h.x, h.y, h.d / 2, 40)))) : plate };
};
const pieces = mp => mp.map(poly => P.bbox([poly]));
const design = els => { const d = newDesign({ mode: 'up', elements: els }); d.handles.mount = 'none'; d.handles.holes = false; return d; };

test('the edge minimum is the checks\' minimum wall', () => {
  assert.equal(EDGE_MIN, PRINT_LIMITS.minWall);
});

test('stripes start as horizontal ribs 3 mm every 7 mm, and leave no sliver on any size even kept as drawn', () => {
  const p = patternDefaults('stripes');
  assert.deepEqual([p.angle, p.pitch, p.width, p.phaseY], [90, 7, 3, 3.5]);
  for (const size of SIZES) {
    const { W, H, keep } = plateOf(size);
    const bands = pieces(P.intersection(generatePattern('stripes', p, W, H), keep));
    assert.ok(bands.length >= 2, `${size.id}: ribs`);
    for (const b of bands) {
      near(b.h, 3, 1e-6, `${size.id}: every rib whole`);
      near(b.w, W, 1e-6, `${size.id}: running edge to edge`);
    }
    // the outermost ribs stop 1.5 mm short of the top and bottom (1.575 on the half height)
    const top = Math.max(...bands.map(b => b.y1)), bottom = Math.min(...bands.map(b => b.y0));
    assert.ok(H / 2 - top >= 1.5 - 1e-6 && bottom + H / 2 >= 1.5 - 1e-6, `${size.id}: clear of the edges (${(H / 2 - top).toFixed(3)})`);
  }
  // and a new stripes element on the default design checks clean of edge slivers on every size
  const d = design([newElement('pattern', { pattern: 'stripes', op: 'raise', height: 1, color: 'c2' })]);
  for (const size of SIZES) assert.ok(!runChecks(buildFace(d, size), d, size).checks.some(c => c.id === 'edge'), `${size.id}: no edge note`);
});

test('the old 0.5 mm sliver: kept, tidied away, or thickened to 0.8 mm', () => {
  const size = SIZE_BY_ID['2W-1H'], { W, H, holes, keep } = plateOf(size);
  const pat = P.intersection(generatePattern('stripes', OLD, W, H), keep);
  const thinOnes = mp => pieces(mp).filter(b => b.w < 5.9);
  const kept = tidyEdges(pat, { W, H, holes, keep, mode: 'keep' });
  assert.equal(kept, pat, 'keep leaves it as drawn');
  assert.deepEqual(thinOnes(kept).map(b => +b.w.toFixed(3)), [0.5, 0.5], 'a sliver down each side');
  const tidy = tidyEdges(pat, { W, H, holes, keep, mode: 'tidy' });
  assert.equal(thinOnes(tidy).length, 0, 'tidied away');
  near(P.area(pat) - P.area(tidy), 2 * 0.5 * H, 0.05, 'exactly the two slivers');
  const thick = tidyEdges(pat, { W, H, holes, keep, mode: 'thicken' });
  const t = thinOnes(thick);
  assert.equal(t.length, 2, 'still two edge strips');
  for (const b of t) { near(b.w, EDGE_MIN, 0.03, 'thickened to the minimum'); near(b.h, H, 1e-6, 'the full height, no feet round the corners'); }
  // through the builder and the checks: the checks' sliver note comes and goes with the setting
  const el = newElement('pattern', { pattern: 'stripes', op: 'raise', height: 1, color: 'c2', params: OLD, edges: 'keep' });
  const d = design([el]);
  const hasEdge = () => runChecks(buildFace(d, size), d, size).checks.some(c => c.id === 'edge');
  assert.ok(hasEdge(), 'kept: the checks note the slivers');
  el.edges = 'tidy';
  assert.ok(!hasEdge(), 'tidied: no note');
  el.edges = 'thicken';
  assert.ok(!hasEdge(), 'thickened: no note');
  assert.equal(parseDesign(serializeDesign(d)).elements[0].edges, 'thicken', 'saved and loaded');
});

test('thin stripes running into the edge, square corners and angled bands keep their shape', () => {
  const size = SIZE_BY_ID['2W-1H'], { W, H, holes, keep } = plateOf(size);
  // 0.5 mm ribs every 4 mm, running into the left and right edges: deliberate, so left alone
  const ribs = P.intersection(generatePattern('stripes', { ...patternDefaults('stripes'), pitch: 4, width: 0.5, phaseY: 2 }, W, H), keep);
  near(P.area(tidyEdges(ribs, { W, H, holes, keep })), P.area(ribs), 1e-6, 'thin ribs untouched');
  // ...but shifted so a rib is centred on the top edge, the half rib left along it is a sliver, and only it goes
  const onEdge = P.intersection(generatePattern('stripes', { ...patternDefaults('stripes'), pitch: 4, width: 0.5, phaseY: 3.5 }, W, H), keep);
  near(P.area(onEdge) - P.area(tidyEdges(onEdge, { W, H, holes, keep })), 0.25 * W, 0.05, 'the half rib on the edge, nothing else');
  // the default ribs meet the edges square: the corners are not nibbled
  const def = P.intersection(generatePattern('stripes', patternDefaults('stripes'), W, H), keep);
  near(P.area(tidyEdges(def, { W, H, holes, keep })), P.area(def), 1e-6, 'square corners untouched');
  // bands at 30 degrees: only their sharp tips along the edge (narrower than the minimum) go, a few mm2 in all
  const slant = P.intersection(generatePattern('stripes', { ...OLD, angle: 30 }, W, H), keep);
  const lost = P.area(slant) - P.area(tidyEdges(slant, { W, H, holes, keep }));
  assert.ok(lost > 0 && lost < 0.5 * pieces(slant).length, `tips only (${lost.toFixed(2)} mm2)`);
});

test('a cut or an inlay never leaves a thin wall of face at the edge, and holes are edges too', () => {
  const size = SIZE_BY_ID['2W-1H'], { W, H, keep } = plateOf(size);
  // a cut band stopping 0.4 mm short of the left edge leaves a 0.4 mm wall: the cut runs out to the edge instead
  const pat = P.intersection(generatePattern('stripes', { ...OLD, phaseX: 5.9 }, W, H), keep);
  assert.ok(Math.min(...pieces(pat).map(b => b.x0)) > -W / 2 + 0.39, 'the wall is there as drawn');
  for (const op of ['cut', 'inlay']) {
    const out = tidyEdges(pat, { W, H, holes: [], keep, op });
    near(Math.min(...pieces(out).map(b => b.x0)), -W / 2, 1e-6, `${op}: out to the edge`);
  }
  near(Math.min(...pieces(tidyEdges(pat, { W, H, holes: [], keep, op: 'raise' })).map(b => b.x0)), -W / 2 + 0.4, 0.01, 'a raise keeps its place: the face under it is whole');
  // round a screw hole: a wide band reaching 0.4 mm below the hole leaves a crescent under it, which goes
  const hole = size.holes[0], r = hole.d / 2, withHole = plateOf(size, [hole]);
  const band = P.intersection(P.rect(-W / 2, hole.y - r - 0.4, W / 2, hole.y + 10), withHole.keep);
  const under = mp => P.area(P.intersection(mp, P.rect(hole.x - 0.3, hole.y - r - 0.38, hole.x + 0.3, hole.y - r - 0.05)));
  assert.ok(under(band) > 0.1, 'the crescent as drawn');
  near(under(tidyEdges(band, { ...withHole, op: 'raise' })), 0, 1e-6, 'tidied away round the hole');
});

test('every pattern, raised or inlaid, checks clean of edge slivers once tidied, screw holes and all', () => {
  const kinds = ['stripes', 'chevron', 'grid', 'dots', 'bricks', 'hex', 'truchet', 'waves', 'knurl', 'ripple', 'wood', 'stipple', 'checker'];
  // each on one of two sizes, alternating (the half height and a 1.5H plate showed the most slivers kept as drawn)
  kinds.forEach((k, n) => ['raise', 'inlay'].forEach((op, o) => { const id = (n + o) % 2 ? '3W-15H' : '1W-05H'; {
    const el = newElement('pattern', { pattern: k, op, height: 1, depth: 0.6, color: 'c2' });
    const d = newDesign({ mode: 'up', elements: [el] }); d.handles.mount = 'pair'; d.handles.holes = true;
    const size = SIZE_BY_ID[id];
    const note = runChecks(buildFace(d, size), d, size).checks.find(c => c.id === 'edge');
    assert.ok(!note, `${k} ${op} on ${id}: ${note?.det}`);
  } }));
});

test('Sol 01a1b3f0: a rib or a wall of face 0.8 mm or wider is never tidied, whatever the raster alignment', () => {
  const size = SIZE_BY_ID['1W-1H'], { W, H, holes, keep } = plateOf(size);
  for (let k = 0; k <= 12; k++) {
    const w = 0.8 + k * 0.005;   // 0.800 .. 0.860 mm, every alignment of a 0.07 mm raster across a cell
    // a raised rib along the left edge, and one along the top (rows instead of columns)
    for (const rib of [P.rect(-W / 2, -H / 2, -W / 2 + w, H / 2), P.rect(-W / 2, H / 2 - w, W / 2, H / 2)]) {
      for (const mode of ['tidy', 'thicken']) near(P.area(tidyEdges(rib, { W, H, holes, keep, mode })), P.area(rib), 1e-6, `${w.toFixed(3)} mm rib, ${mode}`);
    }
    // an inlay stopping w short of the left edge leaves a wall of face w wide: kept
    const band = P.rect(-W / 2 + w, -H / 2, -W / 2 + w + 6, H / 2);
    near(P.area(tidyEdges(band, { W, H, holes, keep, op: 'inlay' })), P.area(band), 1e-6, `${w.toFixed(3)} mm wall`);
  }
  for (const w of [0.3, 0.5, 0.7]) {
    const rib = P.rect(-W / 2, -H / 2, -W / 2 + w, H / 2);
    near(P.area(tidyEdges(rib, { W, H, holes, keep })), 0, 1e-6, `${w} mm rib tidied away`);
    const band = P.rect(-W / 2 + w, -H / 2, -W / 2 + w + 6, H / 2);
    near(P.area(tidyEdges(band, { W, H, holes, keep, op: 'inlay' })), P.area(band) + w * H, 0.05, `${w} mm wall closed`);
  }
});
