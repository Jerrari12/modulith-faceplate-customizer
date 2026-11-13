// Pins inlay on every flat element (2026-11-06): shapes, patterns and SVG art layers can sit flush in the face in
// their own colour, new flat elements start as inlays on face-down designs, the design file keeps an art layer's
// inlay, and the checks measure every inlaid piece (it prints on its own, in its own filament).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;

const P = await import('../js/geometry/polys.js');
const { buildFace, newElement, flushOp, ELEMENT_DEFS } = await import('../js/geometry/face.js');
const { runChecks } = await import('../js/checks/checks.js');
const { newDesign, serializeDesign, parseDesign } = await import('../js/export/design.js');
const { SIZE_BY_ID } = await import('../js/data/sizes.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);
const size = SIZE_BY_ID['2W-1H'];
const check = (d, id) => runChecks(buildFace(d, size), d, size).checks.filter(c => c.id === id);

/** An SVG art element with one colour layer per entry: [{ rings (a MultiPolygon in art mm), op, color }]. */
function art(groups, width = 40) {
  const el = newElement('svg', { width });
  el.groups = groups.map((g, i) => ({ name: `Fill ${i}`, fill: '#cc3300', rings: g.rings, color: g.color || 'c2', op: g.op, height: 1, depth: 0.6, visible: true }));
  el.natural = { w: width, h: 20 };
  return el;
}

test('every flat element offers inlay, with depth and colour; new ones start as inlays on a face-down design', () => {
  for (const kind of ['shape', 'pattern', 'text']) {
    const op = ELEMENT_DEFS[kind].params.find(p => p.key === 'op');
    assert.ok(op.options.some(([v]) => v === 'inlay'), `${kind} offers inlay`);
    const depth = ELEMENT_DEFS[kind].params.find(p => p.key === 'depth'), color = ELEMENT_DEFS[kind].params.find(p => p.key === 'color');
    assert.ok(depth.showIf.op.includes('inlay') && color.showIf.op.includes('inlay'), `${kind} shows depth and colour for an inlay`);
  }
  assert.equal(flushOp(newDesign({ mode: 'down' })), 'inlay');
  assert.equal(flushOp(newDesign({ mode: 'up' })), 'raise');
  assert.equal(flushOp(newDesign({ mode: 'down', face: { thickness: 2, color: 'c1', enabled: false } })), 'raise', 'no face to sit in: raise');
});

test('an inlaid shape, pattern and art layer each sit flush, in their own colour, with the face top one plane', () => {
  const shape = newElement('shape', { shape: 'circle', w: 14, op: 'inlay', depth: 0.8, color: 'c3', x: -50 });
  const stripes = newElement('pattern', { pattern: 'stripes', op: 'inlay', depth: 0.4, color: 'c2' });
  const layer = art([{ rings: P.rect(-10, -5, 10, 5), op: 'inlay', color: 'c3' }]);
  layer.x = 45;
  for (const el of [shape, stripes, layer]) {
    const d = newDesign({ elements: [el] });
    const b = buildFace(d, size);
    const mine = b.layers.filter(L => L.elementId === el.id);
    assert.ok(mine.length && mine.every(L => L.inlay && L.z1 === 2 && Math.abs(L.z0 - (2 - (el.kind === 'svg' ? 0.6 : el.depth))) < 1e-9), `${el.kind} is inlaid flush`);
    assert.ok(mine.every(L => L.color === (el.kind === 'svg' ? 'c3' : el.color)), `${el.kind} keeps its colour`);
    const top = b.layers.filter(L => L.z1 === 2);
    near(P.area(P.union(...top.map(L => L.poly))), P.area(b.keep), 0.05, `${el.kind}: the face top stays one flat plane`);
    for (const L of b.layers) for (const M of b.layers) if (L !== M && L.z0 < M.z1 - 1e-9 && M.z0 < L.z1 - 1e-9) assert.ok(P.area(P.intersection(L.poly, M.poly)) < 0.01, `${el.kind}: no two bodies overlap`);
    const off = buildFace(newDesign({ face: { thickness: 2, color: 'c1', enabled: false }, elements: [el] }), size);
    assert.ok(off.notes.some(n => /inlay sits in the face/.test(n.text)), `${el.kind}: face off notes it`);
  }
});

test('the design file keeps an art layer inlaid', () => {
  const el = art([{ rings: P.rect(-10, -5, 10, 5), op: 'inlay' }, { rings: P.rect(-2, -2, 2, 2), op: 'cut' }, { rings: P.rect(-1, -1, 1, 1), op: 'melt' }]);
  const back = parseDesign(serializeDesign(newDesign({ elements: [el] }))).elements[0];
  assert.deepEqual(back.groups.map(g => g.op), ['inlay', 'cut', 'raise'], 'inlay and cut survive, junk falls back to raise');
});

test('inlay widths: a pattern counts the face left between its pieces; art pieces are measured on their own', () => {
  // stripes 3 mm wide every 3.3 mm: the inlay is fine but the face between the stripes is 0.3 mm
  const tight = newElement('pattern', { pattern: 'stripes', op: 'inlay', color: 'c2', params: { pitch: 3.3, width: 3 } });
  const thin = check(newDesign({ elements: [tight] }), 'thin');
  assert.ok(thin.some(c => c.st === 'fail' && c.elementId === tight.id && /strips of face 0.3 mm wide between its inlaid pieces/.test(c.det)), `the 0.3 mm face strips fail, named as face: ${thin.map(c => c.det)}`);
  const roomy = newElement('pattern', { pattern: 'stripes', op: 'inlay', color: 'c2', params: { pitch: 6, width: 3 } });
  assert.ok(!check(newDesign({ elements: [roomy] }), 'thin').some(c => c.st !== 'pass' && c.elementId === roomy.id), '3 mm stripes 3 mm apart are fine');
  // art layers, measured on the checks' 0.1 mm raster with its two-cell allowance (as the face-down pads are): a ring
  // 0.15 mm wide vanishes, 0.3 and 0.45 mm are single lines, 2 mm prints
  const ring = w => P.difference(P.rect(-8, -6, 8, 6), P.rect(-8 + w, -6 + w, 8 - w, 6 - w));
  const verdict = w => { const el = art([{ rings: ring(w), op: 'inlay' }]); const c = check(newDesign({ elements: [el] }), 'inlay'); return { c: c[0], el }; };
  const v15 = verdict(0.15), v3 = verdict(0.3), v45 = verdict(0.45), v20 = verdict(2);
  assert.equal(v15.c?.st, 'fail', `0.15 mm: ${v15.c?.det}`);
  assert.equal(v15.c.elementId, v15.el.id, 'the finding names the art element');
  assert.ok(v15.c.geo?.at && P.contains(P.union(...buildFace(newDesign({ elements: [v15.el] }), size).layers.filter(L => L.inlay).map(L => L.poly)), v15.c.geo.at[0], v15.c.geo.at[1]), 'and points at the piece');
  assert.equal(v3.c?.st, 'warn', `0.3 mm: ${v3.c?.det}`);
  assert.equal(v45.c?.st, 'warn', `0.45 mm: ${v45.c?.det}`);
  assert.equal(v20.c?.st, 'pass', '2 mm prints');
  // an element its exact width already flagged is not reported twice
  const hair = newElement('shape', { shape: 'rect', w: 0.3, h: 20, op: 'inlay' });
  const res = runChecks(buildFace(newDesign({ elements: [hair] }), size), newDesign({ elements: [hair] }), size).checks;
  assert.ok(res.some(c => c.id === 'thin' && c.st === 'fail' && c.elementId === hair.id), 'the exact width reports the 0.3 mm shape');
  assert.ok(!res.some(c => c.id === 'inlay' && c.st !== 'pass'), 'the inlay check does not repeat it');
});

test('Sol 01a1b261: a face-coloured inlay is part of the face; a clipped sliver still fails behind a milder exact warning', () => {
  // the face is c1; an art ring 0.15 mm wide in c1 merges with the face, so there is no piece to fail
  const ring = P.difference(P.rect(-8, -6, 8, 6), P.rect(-7.85, -5.85, 7.85, 5.85));
  const faceColoured = art([{ rings: ring, op: 'inlay', color: 'c1' }]);
  assert.ok(!check(newDesign({ elements: [faceColoured] }), 'inlay').some(c => c.st !== 'pass'), 'no finding for an inlay in the face colour');
  const faceBar = newElement('shape', { shape: 'rect', w: 0.3, h: 20, op: 'inlay', color: 'c1' });
  assert.ok(!check(newDesign({ elements: [faceBar] }), 'thin').some(c => c.st !== 'pass' && c.elementId === faceBar.id), 'nor from its exact width');
  // a 0.7 mm inlaid bar warns by its exact width; a later cut over all but 0.15 mm of it, in the middle of the plate,
  // leaves a sliver that cannot print and fails
  const bar = newElement('shape', { shape: 'rect', w: 0.7, h: 20, op: 'inlay', x: 30 });
  const cover = newElement('shape', { shape: 'rect', w: 0.55, h: 30, op: 'cut', depth: 1, x: 30 - 0.35 + 0.15 + 0.275 });
  const d = newDesign({ elements: [bar, cover] });
  const res = runChecks(buildFace(d, size), d, size).checks;
  assert.ok(res.some(c => c.id === 'thin' && c.st === 'warn' && c.elementId === bar.id), 'the exact width warns');
  assert.ok(res.some(c => c.id === 'inlay' && c.st === 'fail' && c.elementId === bar.id), `and the clipped sliver fails: ${res.filter(c => c.id === 'inlay').map(c => c.det)}`);
  // the same bar pushed over the plate's right edge (x = 87.5) so 0.15 mm stays on: a sliver along the edge, noted
  // as one (it loses nothing you can see), not failed
  const edgeBar = newElement('shape', { shape: 'rect', w: 0.7, h: 20, op: 'inlay', x: 87.5 + 0.35 - 0.15 });
  const d2 = newDesign({ elements: [edgeBar] });
  const res2 = runChecks(buildFace(d2, size), d2, size).checks;
  assert.ok(res2.some(c => c.id === 'edge' && c.st === 'info'), 'noted as an edge sliver');
  assert.ok(!res2.some(c => c.id === 'inlay' && c.st === 'fail'), 'not failed');
});

test('an inlaid shape under symmetry gets a mirrored inlaid twin', () => {
  const el = newElement('shape', { shape: 'triangle', w: 12, h: 10, op: 'inlay', x: 40 });
  const b = buildFace(newDesign({ symmetry: 'x', elements: [el] }), size);
  const own = b.layers.find(L => L.elementId === el.id && !L.twin), twin = b.layers.find(L => L.elementId === el.id && L.twin);
  assert.ok(own?.inlay && twin?.inlay, 'both copies are inlays');
  near(P.area(P.xor(P.mirrorX(own.poly, 0), twin.poly)), 0, 0.05, 'the twin is the mirror image');
});
