// Pins combine and outline (2026-11-11): a combine joins, cuts away or overlaps its pieces' outlines and the pieces
// stop printing on their own (left as ghosts for the stage); an outline follows another element at a distance as a
// band or as the grown shape; both follow edits, take symmetry twins, never loop, and build like a drawing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;

const F = await import('../js/geometry/face.js');
const { newElement, buildFace } = F;
const { newDesign, parseDesign, serializeDesign } = await import('../js/export/design.js');
const { SIZE_BY_ID } = await import('../js/data/sizes.js');
const V = await import('../js/variants.js');
const P = await import('../js/geometry/polys.js');

const mid = SIZE_BY_ID['2W-1H'];
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const design = els => { const d = newDesign({ elements: els, mode: 'up' }); d.handles.mount = 'none'; d.handles.holes = false; return d; };
const areaOf = (built, id) => P.area(P.union(...built.layers.filter(L => L.elementId === id).map(L => L.poly)));

test('a combine joins, cuts away or overlaps its pieces, which stop printing on their own', () => {
  const rect = newElement('shape', { shape: 'rect', w: 40, h: 20, op: 'raise', height: 1 });
  const hole = newElement('shape', { shape: 'circle', w: 10, op: 'raise', height: 1 });
  const c = newElement('combine', { parts: [rect.id, hole.id], operation: 'cut', op: 'raise', height: 2 });
  const d = design([rect, hole, c]);
  let b = buildFace(d, mid);
  near(areaOf(b, c.id), 800 - Math.PI * 25, 1.5, 'a rectangle with a round hole (the circle is a polygon)');
  assert.equal(b.layers.some(L => L.elementId === rect.id || L.elementId === hole.id), false, 'the pieces are not built on their own');
  assert.deepEqual(b.ghosts.map(g => g.elementId).sort(), [rect.id, hole.id].sort(), 'they are kept as ghosts for the stage');
  near(Math.max(...b.layers.filter(L => L.elementId === c.id).map(L => L.z1)) - b.t, 2, 1e-9, 'at the combine’s own height');
  c.operation = 'join'; hole.x = 20;   // the circle half over the right end
  b = buildFace(d, mid);
  near(areaOf(b, c.id), 800 + Math.PI * 25 / 2, 1.5, 'joined: the rectangle and the half of the circle past it');
  c.operation = 'common';
  b = buildFace(d, mid);
  near(areaOf(b, c.id), Math.PI * 25 / 2, 1.5, 'overlap: only the half circle inside');
  // a hidden piece is left out of it; a hidden combine hides the lot (its pieces still do not print)
  c.operation = 'cut'; hole.x = 0; hole.visible = false;
  near(areaOf(buildFace(d, mid), c.id), 800, 0.01, 'the hole hidden: no hole');
  hole.visible = true; c.visible = false;
  b = buildFace(d, mid);
  assert.equal(b.layers.some(L => [rect.id, hole.id, c.id].includes(L.elementId)), false, 'hidden combine: nothing');
});

test('hidden pieces are left out, empty shown pieces still count, twins get ghosts, long chains build (Sol 01a1ccfb)', () => {
  const A = newElement('shape', { shape: 'rect', w: 30, h: 20 }), B = newElement('shape', { shape: 'rect', w: 10, h: 10 });
  const cut = newElement('combine', { parts: [A.id, B.id], operation: 'cut' });
  const d = design([A, B, cut]);
  A.visible = false;
  near(P.area(F.derivedOutline(cut, d, mid)), 100, 0.01, 'the first piece hidden: the next shown one is cut into');
  A.visible = true;
  // a shown piece that comes to nothing: Overlap with it is nothing
  const same = newElement('shape', { shape: 'rect', w: 10, h: 10 });
  const empty = newElement('combine', { parts: [B.id, same.id], operation: 'cut' });
  const both = newElement('combine', { parts: [empty.id, A.id], operation: 'common' });
  const d2 = design([A, B, same, empty, both]);
  assert.equal(P.area(F.derivedOutline(empty, d2, mid)), 0, 'a square cut by itself is nothing');
  assert.equal(F.derivedOutline(both, d2, mid).length, 0, 'nothing overlaps nothing');
  // a symmetric piece: its twin has a ghost of its own, marked as the twin
  const c = newElement('shape', { shape: 'circle', w: 8, x: -30 });
  const j = newElement('combine', { parts: [c.id], operation: 'join' });
  const d3 = design([c, j]); d3.symmetry = 'x';
  const gh = buildFace(d3, mid).ghosts.filter(g => g.elementId === c.id);
  assert.equal(gh.length, 2); assert.equal(gh.filter(g => g.twin).length, 1);
  assert.ok(P.bbox(gh.find(g => g.twin).poly).x0 > 0, 'the twin ghost is on the other side');
  // thirteen outlines in a chain, each following the last: the last still has its shape
  const r = newElement('shape', { shape: 'rect', w: 20, h: 10 }), chain = [r];
  for (let i = 0; i < 13; i++) chain.push(newElement('offset', { source: chain[chain.length - 1].id, distance: 0, band: 'shape' }));
  near(P.area(F.derivedOutline(chain[13], design(chain), mid)), 200, 0.01, 'no depth limit, only loops stop it');
});

test('an outline follows its element as a band or as the grown shape, on every edit', () => {
  const r = newElement('shape', { shape: 'rect', w: 20, h: 10, op: 'raise', height: 1 });
  const o = newElement('offset', { source: r.id, distance: 2, band: 'ring', op: 'raise', height: 0.6, color: 'c3' });
  const d = design([o, r]);
  const outline = () => P.area(F.derivedOutline(o, d, mid));
  near(areaOf(buildFace(d, mid), o.id), 2 * 2 * 30 + Math.PI * 4, 1.2, 'a 2 mm band round it (round corners), as built');
  o.band = 'shape';
  near(outline(), 200 + 120 + Math.PI * 4, 1.2, 'the grown shape');
  near(areaOf(buildFace(d, mid), o.id), 120 + Math.PI * 4, 1.2, 'built, the rectangle after it in the stack stands over its middle');
  o.band = 'ring'; o.distance = -2;
  near(outline(), 200 - 16 * 6, 1.2, 'a band inside it');
  assert.ok(buildFace(d, mid).layers.some(L => L.elementId === r.id), 'what it follows still prints');
  // it follows a move, and follows a hidden element too
  o.distance = 2; r.x = 30;
  let bb = P.bbox(P.union(...buildFace(d, mid).layers.filter(L => L.elementId === o.id).map(L => L.poly)));
  near((bb.x0 + bb.x1) / 2, 30, 0.05, 'moved with it');
  r.visible = false;
  assert.ok(areaOf(buildFace(d, mid), o.id) > 100, 'an outline of a hidden element still draws');
  // nothing to follow: a note, nothing built
  o.source = 'gone';
  const b = buildFace(d, mid);
  assert.ok(b.notes.some(n => n.elementId === o.id && /follows is gone/.test(n.text)));
  assert.equal(b.layers.some(L => L.elementId === o.id), false);
});

test('symmetry twins count, loops go nowhere, and a raised combine with a taper is a body', () => {
  const s = newElement('shape', { shape: 'circle', w: 8, x: -40, op: 'raise' });
  const o = newElement('offset', { source: s.id, distance: 1, band: 'shape' });
  const d = design([s, o]); d.symmetry = 'x';
  const parts = buildFace(d, mid).layers.filter(L => L.elementId === o.id);
  const bb = P.bbox(P.union(...parts.map(L => L.poly)));
  assert.ok(bb.x0 < -40 && bb.x1 > 40, 'the outline takes the circle’s twin too');
  // a combine using an outline that follows the combine: refused at once, and harmless in a file
  const c = newElement('combine', { parts: [], operation: 'join' });
  const loop = newElement('offset', { source: c.id, distance: 1 });
  c.parts = [loop.id, s.id];
  const d2 = design([s, c, loop]);
  assert.equal(F.usesElement(loop, c, d2), true); assert.equal(F.usesElement(c, loop, d2), true);
  assert.doesNotThrow(() => buildFace(d2, mid), 'a loop builds, it does not hang');
  // a shaped combine: raised with a taper, a body cut at the plate edge
  const a = newElement('shape', { shape: 'rect', w: 30, h: 20, x: mid.w / 2 });
  const cut = newElement('shape', { shape: 'circle', w: 8, x: mid.w / 2 - 6 });
  const body = newElement('combine', { parts: [a.id, cut.id], operation: 'cut', op: 'raise', height: 5, taper: 20 });
  const b3 = buildFace(design([a, cut, body]), mid);
  const g = b3.solids.find(x => x.elementId === body.id);
  assert.equal(g?.kind, 'shaped', 'a body');
  assert.ok(P.bbox(g.footprint).x1 <= mid.w / 2 + 1e-6, 'stopped at the plate edge');
  near(g.z1 - b3.t, 5, 1e-6, 'its height');
});

test('the design file keeps a combine’s pieces and an outline’s element; what they are is the same on every size', () => {
  const r = newElement('shape'), t = newElement('text', { text: 'A' });
  const c = newElement('combine', { parts: [r.id, t.id], operation: 'join' });
  const o = newElement('offset', { source: t.id, distance: -1.5, band: 'shape' });
  const back = parseDesign(serializeDesign(newDesign({ elements: [r, t, c, o] }))).elements;
  assert.deepEqual(back[2].parts, [r.id, t.id]); assert.equal(back[2].operation, 'join');
  assert.equal(back[3].source, t.id); assert.equal(back[3].distance, -1.5); assert.equal(back[3].band, 'shape');
  const junk = parseDesign({ elements: [{ kind: 'combine', parts: [1, null, 'ok', { x: 1 }, 'b'.repeat(200)] }] }).elements[0];
  assert.deepEqual(junk.parts, ['ok', 'b'.repeat(80)], 'strings only, trimmed');
  assert.equal(V.canOverride(c, 'operation'), false); assert.equal(V.canOverride(o, 'source'), false); assert.equal(V.canOverride(o, 'band'), false);
  assert.equal(V.canOverride(o, 'distance'), true, 'the distance can differ per size');
});

test('dragging a combine or an outline whole moves everything it is built from, once each (patterns stay)', () => {
  const a = newElement('shape'), b = newElement('text', { text: 'B' }), hid = newElement('shape', { visible: false });
  const pat = newElement('pattern');
  const inner = newElement('combine', { parts: [b.id, hid.id], operation: 'join' });
  const outer = newElement('combine', { parts: [a.id, inner.id, pat.id, a.id], operation: 'cut' });
  const halo = newElement('offset', { source: outer.id, distance: 1 });
  const d = design([a, b, hid, pat, inner, outer, halo]);
  const ids = els => els.map(e => e.id).sort();
  assert.deepEqual(ids(F.movablePieces(outer, d)), ids([a, b, hid]), 'through the inner combine, hidden too, the pattern stays, a once');
  assert.deepEqual(ids(F.movablePieces(halo, d)), ids([a, b, hid]), 'an outline moves what it follows');
  const loop = newElement('combine', { parts: [], operation: 'join' }), back = newElement('offset', { source: loop.id });
  loop.parts = [back.id, a.id];
  assert.deepEqual(ids(F.movablePieces(loop, design([a, loop, back]))), ids([a]), 'a loop ends');
});
