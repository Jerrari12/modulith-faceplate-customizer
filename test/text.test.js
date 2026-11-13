// Pins the text element (2026-11-06): fonts load in Node from the same files the browser fetches, letters come out
// at the asked cap height, nonzero fills resolve self-crossing outlines, lines and alignment, the arc, the stroke
// measure the checks use, raise / cut / inlay in the builder, readable symmetry twins, and the design file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;

const P = await import('../js/geometry/polys.js');
const T = await import('../js/geometry/text.js');
const { buildFace, newElement } = await import('../js/geometry/face.js');
const { runChecks } = await import('../js/checks/checks.js');
const { newDesign, serializeDesign, parseDesign } = await import('../js/export/design.js');
const { SIZE_BY_ID } = await import('../js/data/sizes.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);
const S = id => SIZE_BY_ID[id];
const txt = (o = {}) => newElement('text', o);
// every font but Pacifico (the first test watches Pacifico load from cold)
const ready = () => Promise.all(T.FONTS.filter(f => f.id !== 'pacifico').map(f => T.loadFont(f.id)));

test('a font loads on first use: the outline throws "loading" until it arrives, then the build has letters', async () => {
  const el = txt({ font: 'pacifico', text: 'Hi' });
  assert.throws(() => T.textOutline(el), /loading the Pacifico font/);
  const d = newDesign({ elements: [el] });
  const before = buildFace(d, S('2W-1H'));
  assert.ok(before.notes.some(n => /loading the Pacifico font/.test(n.text)), 'the builder notes the wait');
  assert.equal(await T.ensureFonts(d), true, 'ensureFonts reports that it loaded something');
  assert.equal(await T.ensureFonts(d), false, 'and nothing the second time');
  const after = buildFace(d, S('2W-1H'));
  assert.ok(after.layers.some(L => L.elementId === el.id), 'the letters are in the build once the font is here');
});

test('every font: capitals stand at the asked height, centred, and every printable ASCII character outlines cleanly', async () => {
  const ascii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');
  for (const f of T.FONTS) {
    const entry = await T.loadFont(f.id);
    const H = T.textOutline(txt({ font: f.id, text: 'H', size: 12 }));
    const b = P.bbox(H.poly);
    // the size is the font's cap-height metric: the H's ink is that tall, give or take the font's own overshoot
    // (Pacifico's script H swashes 4 % past it), so measure it against the glyph's own box in font units
    const gb = entry.font.charToGlyph('H').getBoundingBox();
    near(b.h, 12 * (gb.y2 - gb.y1) / entry.cap, 0.02, `${f.id} H height`);
    assert.ok(Math.abs(b.h - 12) < 0.8, `${f.id} H is within the font's overshoot of 12 mm`);
    // the block is centred on the font's cap-height metric, which a rounded font's H can fall short of by a little
    near((b.y0 + b.y1) / 2, 0, 0.25, `${f.id} H centred vertically`);
    // lines are centred by their advance, so the ink sits off centre by the glyph's own side bearings
    const adv = entry.font.charToGlyph('H').advanceWidth;
    near((b.x0 + b.x1) / 2, 12 * ((gb.x1 + gb.x2) / 2 - adv / 2) / entry.cap, 0.02, `${f.id} H centred across by its advance`);
    const all = T.textOutline(txt({ font: f.id, text: ascii, size: 5 }));
    assert.deepEqual(all.missing, [], `${f.id} has every printable ASCII character`);
    assert.ok(P.area(all.poly) > 0, `${f.id} outlines`);
    const O = T.textOutline(txt({ font: f.id, text: 'O', size: 10 }));
    assert.ok(O.poly.length === 1 && O.poly[0].length === 2, `${f.id} O is one ring with one counter`);
  }
});

test('a contour that crosses itself is split into loops: a lobe turning against the outline is part of the stroke', async () => {
  await ready();
  // a square traced with a figure-eight spur: the spur's loop turns the other way and must not punch a hole
  const ring = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 6], [4, 4], [4, 6], [0, 4], [0, 0]];
  const loops = T.splitLoops(ring);
  assert.equal(loops.length, 2, 'two loops');
  const mp = T.resolveNonzero([ring]);
  // the nonzero fill: the square, the spur's lobe (winding -1 + +1... the spur leaves the square, so its lobe is
  // the triangle 0,4 - 2,5 - 0,6 counted once): the result is the square minus nothing inside it
  assert.ok(P.contains(mp, 5, 5), 'the middle is filled');
  assert.ok(P.contains(mp, 3, 5), 'the spur lobe inside the square is filled, not a hole');
  // Bitter's B (an instanced variable font) has counters with spurs into the stem: exactly two holes
  const B = T.textOutline(txt({ font: 'bitter', text: 'B', size: 10 }));
  assert.equal(B.poly.length, 1);
  assert.equal(B.poly[0].length, 3, 'Bitter B: an outline and two counters, no slivers');
  // Fredoka's A is two overlapping outlines and no hole contour: still one shape with its counter
  const A = T.textOutline(txt({ font: 'fredoka', text: 'A', size: 10 }));
  assert.equal(A.poly.length, 1, 'Fredoka A is one piece');
  assert.equal(A.poly[0].length, 2, 'with its counter');
});

test('lines, alignment, spacing and kerning', async () => {
  await ready();
  const one = T.textOutline(txt({ text: 'Hello', size: 10 }));
  const two = T.textOutline(txt({ text: 'Hello\nHi', size: 10, lineGap: 1.6 }));
  near(two.height, 10 + 16, 1e-9, 'block height is a cap plus one line gap');
  near(one.width, two.width, 1e-9, 'the block is as wide as its widest line');
  // two lines that start and end with the same letter: aligned left they start together, aligned right they end together
  const lines = align => { const mp = T.textOutline(txt({ text: 'HHH\nH', size: 10, align })).poly; return [P.bbox(P.intersection(mp, P.rect(-99, 0, 99, 99))), P.bbox(P.intersection(mp, P.rect(-99, -99, 99, 0)))]; };
  const [lt, lb] = lines('left'), [rt, rb] = lines('right'), [ct, cb] = lines('centre');
  near(lt.x0, lb.x0, 1e-6, 'left: the lines start together');
  near(rt.x1, rb.x1, 1e-6, 'right: the lines end together');
  near((ct.x0 + ct.x1) / 2, (cb.x0 + cb.x1) / 2, 1e-6, 'centre: the lines share a centre');
  const wide = T.textOutline(txt({ text: 'Hello', size: 10, spacing: 2 }));
  near(wide.width - one.width, 4 * 2, 1e-9, 'letter spacing adds between letters, not after the last');
  const AV = T.textOutline(txt({ text: 'AV', size: 10 })).width;
  const AandV = T.textOutline(txt({ text: 'A', size: 10 })).width + T.textOutline(txt({ text: 'V', size: 10 })).width;
  assert.ok(AV < AandV - 0.1, `AV is kerned (${AV.toFixed(2)} < ${AandV.toFixed(2)})`);
  const blank = T.textOutline(txt({ text: '  \n ' }));
  assert.equal(blank.poly.length, 0, 'spaces only: nothing to print');
  const odd = T.textOutline(txt({ text: 'A☃B' }));
  assert.deepEqual(odd.missing, ['☃'], 'a character the font lacks is reported, not drawn as a box');
});

test('the arc: the middle stays put, the ends drop for an upward arch, and a short line cannot turn inside out', async () => {
  await ready();
  const flat = T.textOutline(txt({ text: 'ARCHED LINE', size: 8 }));
  const up = T.textOutline(txt({ text: 'ARCHED LINE', size: 8, bend: 90 }));
  const down = T.textOutline(txt({ text: 'ARCHED LINE', size: 8, bend: -90 }));
  near(up.bend, 90, 1e-6); near(down.bend, -90, 1e-6);
  const bu = P.bbox(up.poly), bd = P.bbox(down.poly), bf = P.bbox(flat.poly);
  assert.ok(bu.y0 < bf.y0 - 2, 'an upward arch brings its ends down');
  assert.ok(bd.y1 > bf.y1 + 2, 'a downward one lifts them');
  assert.ok(bu.w < bf.w, 'and both are narrower than the straight line');
  near(P.area(up.poly), P.area(flat.poly), 0.08 * P.area(flat.poly), 'bending keeps the ink area about the same');
  const ring = T.textOutline(txt({ text: 'AB', size: 10, bend: 360 }));
  assert.ok(Math.abs(ring.bend) < 360, `two letters cannot close a ring that small: held to ${ring.bend.toFixed(0)}°`);
  for (const poly of ring.poly) for (const r of poly) for (const [x, y] of r) assert.ok(Number.isFinite(x) && Number.isFinite(y));
});

test('stroke width: a hairline crossbar breaks the shape, sharp tips and round ends do not', async () => {
  await ready();
  // an H with 2 mm stems and a 0.5 mm crossbar
  const H = P.union(P.rect(0, 0, 2, 10), P.rect(6, 0, 8, 10), P.rect(1, 4.75, 7, 5.25));
  near(T.polyStroke(H, 0.02, 60), 0.5, 0.06, 'the crossbar');
  // a long thin triangle comes to a point; nothing breaks before the opening eats the whole body
  const spike = P.polygon([[0, 0], [20, 1.5], [0, 3]]);
  assert.ok(T.polyStroke(spike, 0.05, 20) > 1.5, 'a tapering point is not a thin stroke');
  // the real fonts: Archivo ExtraBold is sturdy; IBM Plex Sans has thin joins at its shoulders
  const archivo = T.textStroke(txt({ font: 'archivo', text: 'Kitchen', size: 10 }));
  const plex = T.textStroke(txt({ font: 'plex-sans', text: 'ham', size: 10 }));
  assert.ok(archivo.mm > 1, `Archivo at 10 mm strokes ${archivo.mm.toFixed(2)} mm`);
  assert.ok(plex.mm < archivo.mm, 'Plex is lighter');
  near(T.textStroke(txt({ font: 'archivo', text: 'Kitchen', size: 20 })).mm, 2 * archivo.mm, 1e-9, 'strokes scale with the height');
});

test('the builder: raise stands on the face, cut goes into it, inlay sits flush in its own colour', async () => {
  await ready();
  const size = S('2W-1H');
  const mk = op => { const el = txt({ text: 'Spices', size: 12, op, color: 'c2', depth: 0.6, height: 1 }); return { el, b: buildFace(newDesign({ elements: [el] }), size) }; };
  const r = mk('raise');
  const rl = r.b.layers.filter(L => L.elementId === r.el.id);
  assert.ok(rl.length && rl.every(L => L.z0 === 2 && L.z1 === 3 && L.color === 'c2'), 'raised 1 mm on the 2 mm face');
  const c = mk('cut');
  assert.equal(c.b.layers.filter(L => L.elementId === c.el.id).length, 0, 'a cut adds no layer');
  const slabTop = P.union(...c.b.layers.filter(L => L.kind === 'slab' && L.z1 === 2).map(L => L.poly));
  const letters = P.union(...r.b.layers.filter(L => L.elementId === r.el.id).map(L => L.poly));
  assert.ok(P.area(P.intersection(slabTop, letters)) < 0.01, 'the cut letters are gone from the top of the face');
  const i = mk('inlay');
  const il = i.b.layers.filter(L => L.elementId === i.el.id);
  assert.ok(il.length && il.every(L => Math.abs(L.z0 - 1.4) < 1e-9 && L.z1 === 2 && L.color === 'c2'), 'inlaid 0.6 mm, flush with the top');
  const top = i.b.layers.filter(L => L.z1 === 2);
  near(P.area(P.union(...top.map(L => L.poly))), P.area(i.b.keep), 0.05, 'the face top is one flat plane: slab and letters together');
  for (const L of top) for (const M of top) if (L !== M && L.z0 < M.z1 && M.z0 < L.z1) assert.ok(P.area(P.intersection(L.poly, M.poly)) < 0.01, 'no two bodies overlap');
  // face off: an inlay has nothing to sit in
  const off = buildFace(newDesign({ face: { thickness: 2, color: 'c1', enabled: false }, elements: [i.el] }), size);
  assert.ok(off.notes.some(n => /inlay sits in the face/.test(n.text)));
});

test('symmetry: a text twin reads the right way round at the mirrored place', async () => {
  await ready();
  const el = txt({ text: 'Ab', size: 10, x: 40, op: 'raise' });
  const b = buildFace(newDesign({ symmetry: 'x', elements: [el] }), S('2W-1H'));
  const own = b.layers.find(L => L.elementId === el.id && !L.twin), twin = b.layers.find(L => L.elementId === el.id && L.twin);
  assert.ok(own && twin, 'both copies are built');
  const shifted = P.translate(own.poly, -80, 0);
  near(P.area(P.xor(shifted, twin.poly)), 0, 0.05, 'the twin is the same letters moved, not mirrored');
});

test('checks: small text in a light font warns about its strokes; the file keeps text and cleans it', async () => {
  await ready();
  const size = S('2W-1H');
  const small = txt({ font: 'plex-sans', text: 'ham', size: 4, op: 'inlay' });
  const d = newDesign({ elements: [small] });
  const res = runChecks(buildFace(d, size), d, size);
  const thin = res.checks.find(c => c.id === 'thin' && c.elementId === small.id);
  assert.ok(thin && thin.st !== 'pass' && /thinnest strokes/.test(thin.det), `small Plex text is flagged: ${thin?.det}`);
  const big = txt({ font: 'archivo', text: 'ham', size: 14, op: 'inlay' });
  const d2 = newDesign({ elements: [big] });
  const res2 = runChecks(buildFace(d2, size), d2, size);
  assert.ok(!res2.checks.some(c => c.id === 'thin' && c.elementId === big.id), 'big Archivo text is fine');
  // the design file: text survives, control characters and extra lines do not, unknown fonts fall back
  const el = txt({ text: 'Line 1\nLine 2', font: 'bitter', op: 'inlay', bend: 30 });
  const back = parseDesign(serializeDesign(newDesign({ elements: [el] })));
  assert.equal(back.elements[0].text, 'Line 1\nLine 2');
  assert.equal(back.elements[0].font, 'bitter');
  assert.equal(back.elements[0].op, 'inlay');
  const junk = parseDesign({ elements: [{ kind: 'text', text: `A\u0000B\r\n${'x\n'.repeat(20)}${'y'.repeat(500)}`, font: 'comic-sans', op: 'melt' }] }).elements[0];
  assert.ok(!/\u0000|\r/.test(junk.text), 'control characters are dropped');
  assert.ok(junk.text.split('\n').length <= T.TEXT_LIMITS.maxLines && junk.text.length <= T.TEXT_LIMITS.maxChars, 'lines and length are capped');
  assert.equal(junk.font, T.FONTS[0].id, 'an unknown font falls back');
  assert.equal(junk.op, 'inlay', 'an unknown operation falls back');
  const odd = parseDesign({ elements: [{ kind: 'text', text: { toString: null } }] }).elements[0];
  assert.equal(typeof odd.text, 'string', 'a text that is not a string does not crash the file');
});
