// Pins 3D textures (2026-11-06): height maps stay in [0, 1] and follow their seed, the surface mesher makes closed
// watertight bodies of the right volume and outline (still watertight after the 3MF writer welds its vertices), the
// element covers the whole face, a shape or another element's outline, mirrors under symmetry, prints face up only,
// and its settings and picture survive the design file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;

const P = await import('../js/geometry/polys.js');
const { HEIGHT_MAPS, heightFunction } = await import('../js/geometry/heightmaps.js');
const { surfaceBody } = await import('../js/geometry/surface.js');
const { imageFromRGBA, bytesToB64 } = await import('../js/geometry/image.js');
const T = await import('../js/geometry/text.js');
const { buildFace, newElement } = await import('../js/geometry/face.js');
const { runChecks } = await import('../js/checks/checks.js');
const { newDesign, serializeDesign, parseDesign } = await import('../js/export/design.js');
const { indexTriangles } = await import('../js/export/threemf.js');
const { SIZE_BY_ID } = await import('../js/data/sizes.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);
const size = SIZE_BY_ID['2W-1H'];
function volume(t) {
  let v = 0;
  for (let i = 0; i < t.length; i += 9) v += (t[i] * (t[i + 4] * t[i + 8] - t[i + 5] * t[i + 7]) - t[i + 1] * (t[i + 3] * t[i + 8] - t[i + 5] * t[i + 6]) + t[i + 2] * (t[i + 3] * t[i + 7] - t[i + 4] * t[i + 6])) / 6;
  return v;
}
/** Every directed edge used once and its reverse once: closed and consistently wound. Optionally after welding. */
function closed(tris, weld = false) {
  let list;
  if (weld) { const { tris: idx } = indexTriangles(tris); list = idx; } else {
    const key = new Map(), id = (x, y, z) => { const k = `${x},${y},${z}`; if (!key.has(k)) key.set(k, key.size); return key.get(k); };
    list = [];
    for (let i = 0; i < tris.length; i += 9) list.push([id(tris[i], tris[i + 1], tris[i + 2]), id(tris[i + 3], tris[i + 4], tris[i + 5]), id(tris[i + 6], tris[i + 7], tris[i + 8])]);
  }
  const edges = new Map();
  for (const [a, b, c] of list) for (const [p, q] of [[a, b], [b, c], [c, a]]) { const k = `${p}|${q}`; edges.set(k, (edges.get(k) || 0) + 1); }
  let bad = 0;
  for (const [k, n] of edges) { const [p, q] = k.split('|'); if (n !== 1 || edges.get(`${q}|${p}`) !== 1) bad++; }
  return bad;
}

test('height maps: every map stays between 0 and 1, varies, and repeats with its seed', () => {
  for (const [map] of HEIGHT_MAPS.filter(([k]) => k !== 'picture')) {
    const f = heightFunction({ map, scale: 4, seed: 3 }), g = heightFunction({ map, scale: 4, seed: 3 });
    let lo = 1, hi = 0;
    for (let x = -20; x <= 20; x += 0.37) for (let y = -10; y <= 10; y += 0.41) {
      const v = f(x, y);
      assert.ok(v >= 0 && v <= 1, `${map} at ${x},${y}: ${v}`);
      assert.equal(v, g(x, y), `${map} repeats with the same seed`);
      lo = Math.min(lo, v); hi = Math.max(hi, v);
    }
    assert.ok(hi - lo > 0.5, `${map} has relief (${lo.toFixed(2)}..${hi.toFixed(2)})`);
  }
  // a picture: white is high, invert flips it, stretch covers the box, tile repeats every `scale` mm
  const rgba = new Uint8ClampedArray(2 * 1 * 4);
  rgba.set([0, 0, 0, 255, 255, 255, 255, 255]);
  const d = imageFromRGBA(rgba, 2, 1), pic = { w: 2, h: 1, bytes: Uint8Array.from(atob(d.g), c => c.charCodeAt(0)) };
  const box = { x0: -10, y0: -5, w: 20, h: 10 };
  const st = heightFunction({ map: 'picture', picture: pic, fit: 'stretch', box });
  assert.ok(st(-9, 0) < 0.1 && st(9, 0) > 0.9, 'stretched: black on the left, white on the right');
  assert.ok(heightFunction({ map: 'picture', picture: pic, fit: 'stretch', box, invert: true })(9, 0) < 0.1, 'inverted');
  const tl = heightFunction({ map: 'picture', picture: pic, fit: 'tile', scale: 4 });
  near(tl(0.5, 0.2), tl(4.5, 0.2), 1e-9, 'a tile repeats every 4 mm');
});

test('the mesher: closed bodies of the right volume and outline, for any outline', async () => {
  await T.loadFont('archivo');
  const word = T.textOutline({ font: 'archivo', text: 'Rock', size: 14 }).poly;
  const shapes = { rect: P.rect(-20, -10, 20, 10), circle: P.circle(0, 0, 12, 128), ring: P.difference(P.circle(0, 0, 12, 128), P.circle(0, 0, 5, 64)), word };
  for (const [name, region] of Object.entries(shapes)) {
    const flat = surfaceBody(region, () => 0, { z0: 2, base: 0.5, depth: 0.6, grid: 0.3 });
    near(volume(flat.tris), P.area(region) * 0.5, 0.012 * P.area(region) * 0.5, `${name}: a flat body is area x base`);
    near(P.area(flat.footprint), P.area(region), 0.012 * P.area(region), `${name}: the outline follows the area`);
    const tex = surfaceBody(region, heightFunction({ map: 'crystal', scale: 3 }), { z0: 2, base: 0.5, depth: 0.6, grid: 0.3 });
    assert.equal(closed(tex.tris), 0, `${name}: watertight`);
    assert.equal(closed(tex.tris, true), 0, `${name}: still watertight after the 3MF writer welds vertices`);
    assert.ok(volume(tex.tris) > volume(flat.tris), `${name}: the texture adds volume`);
    let zmin = Infinity, zmax = -Infinity;
    for (let i = 2; i < tex.tris.length; i += 3) { zmin = Math.min(zmin, tex.tris[i]); zmax = Math.max(zmax, tex.tris[i]); }
    near(zmin, 2, 1e-6, `${name}: the bottom is on z0`); assert.ok(zmax <= 3.1 + 1e-6 && zmax > 2.9, `${name}: the top within base + depth`);
  }
  const big = surfaceBody(P.rect(-200, -60, 200, 60), () => 0.5, { grid: 0.25, maxCells: 20000 });
  assert.ok(big.cells <= 22000, `a big area is coarsened to stay quick (${big.cells} cells, ${big.grid.toFixed(2)} mm)`);
});

test('the element: the whole face, a shape, or another element; it replaces raised relief and mirrors with symmetry', async () => {
  await T.loadFont('archivo');
  const face = newElement('surface', { map: 'noise' });
  let d = newDesign({ mode: 'up', elements: [face] }); d.handles.mount = 'none'; d.handles.holes = false;
  let b = buildFace(d, size);
  assert.equal(b.solids.length, 1); assert.equal(b.solids[0].kind, 'surface');
  near(P.area(b.solids[0].footprint), P.area(b.keep), 0.01 * P.area(b.keep), 'the whole face');
  assert.equal(b.solids[0].z0, 2, 'standing on the 2 mm face');
  d.face.enabled = false;
  assert.equal(buildFace(d, size).solids[0].z0, 0, 'on the backer when the face is off');
  // raised letters, textured: the letters' flat raise is gone, the texture stands in their place
  const txt = newElement('text', { text: 'ROCK', size: 20, op: 'raise', height: 1 });
  const sur = newElement('surface', { map: 'crystal', region: 'element', target: txt.id, scale: 2 });
  d = newDesign({ mode: 'up', elements: [txt, sur] }); d.handles.mount = 'none'; d.handles.holes = false;
  b = buildFace(d, size);
  assert.equal(b.layers.filter(L => L.elementId === txt.id).length, 0, 'no flat raise of the letters is left');
  near(P.area(b.solids[0].footprint), P.area(T.textOutline(txt).poly), 0.02 * P.area(T.textOutline(txt).poly), 'the texture takes the letters\' outline');
  assert.equal(runChecks(b, d, size).status, 'pass', 'and prints clean');
  // a shape of its own, mirrored by symmetry
  const shp = newElement('surface', { map: 'hexdome', region: 'shape', w: 30, h: 20, x: 40 });
  d = newDesign({ mode: 'up', symmetry: 'x', elements: [shp] }); d.handles.mount = 'none'; d.handles.holes = false;
  b = buildFace(d, size);
  const own = b.solids.find(s => !s.twin), twin = b.solids.find(s => s.twin);
  assert.ok(own && twin, 'a twin');
  near(P.area(P.xor(P.mirrorX(own.footprint, 0), twin.footprint)), 0, 0.05, 'mirrored');
  near(P.area(P.xor(P.mirrorX(own.clear, 0), twin.clear)), 0, 0.05, 'and it clears its own mirrored area');
  // a missing element, and a picture map with no picture yet
  const lost = newElement('surface', { region: 'element', target: 'nope' });
  assert.ok(buildFace(newDesign({ mode: 'up', elements: [lost] }), size).notes.some(n => /element it textures is gone/.test(n.text)));
  const pic = newElement('surface', { map: 'picture' });
  const pb = buildFace(newDesign({ mode: 'up', elements: [pic] }), size);
  assert.ok(pb.notes.some(n => /choose a picture/.test(n.text)) && pb.solids.length === 1, 'flat until a picture is chosen');
});

test('checks: face up only; it needs face under it', () => {
  const down = newDesign({ mode: 'down', elements: [newElement('surface', {})] });
  assert.ok(runChecks(buildFace(down, size), down, size).checks.some(c => c.lbl === '3D textures need Face Up' && c.st === 'fail'));
  const cut = newElement('shape', { shape: 'rect', w: 30, h: 20, op: 'cut', depth: 2 });
  const over = newElement('surface', { region: 'shape', w: 30, h: 20, map: 'knurl' });
  const d = newDesign({ mode: 'up', elements: [cut, over] }); d.handles.mount = 'none'; d.handles.holes = false;
  assert.ok(runChecks(buildFace(d, size), d, size).checks.some(c => c.lbl === 'Texture has no face under it'), 'a texture over a cut is flagged');
});

test('the design file keeps a texture, its area and its picture, and cleans junk', () => {
  const rgba = new Uint8ClampedArray(4 * 4 * 4).fill(200);
  const el = newElement('surface', { map: 'picture', region: 'shape', w: 40, fit: 'tile', scale: 6, depth: 1.2, data: imageFromRGBA(rgba, 4, 4) });
  const back = parseDesign(serializeDesign(newDesign({ elements: [el] }))).elements[0];
  assert.equal(back.map, 'picture'); assert.equal(back.region, 'shape'); assert.equal(back.fit, 'tile'); assert.equal(back.depth, 1.2);
  assert.deepEqual(back.data, el.data, 'the picture travels in the file');
  const junk = parseDesign({ elements: [{ kind: 'surface', map: 'lava', region: 'everywhere', data: { w: 3, h: 3, g: 'AA' }, target: { toString: null } }] }).elements[0];
  assert.equal(junk.map, 'crystal'); assert.equal(junk.region, 'face');
  assert.equal(junk.data, undefined, 'a picture whose pixels do not add up is dropped');
});

test('a design file with objects where strings belong still opens (names, ids, colours, settings)', () => {
  const bad = { toString: null };
  const d = parseDesign({ name: bad, face: { color: bad }, colors: [{ id: bad, name: bad, hex: '#123456' }], elements: [{ kind: 'shape', id: bad, name: bad }, { kind: 'solid', stackOn: bad }, { kind: 'svg', groups: [{ name: bad, color: bad, rings: [] }], natural: { w: 1, h: 1 } }] });
  assert.equal(typeof d.name, 'string'); assert.equal(typeof d.face.color, 'string');
  assert.equal(typeof d.elements[0].id, 'string'); assert.equal(typeof d.elements[0].name, 'string');
  assert.equal(d.elements[1].stackOn, ''); assert.equal(typeof d.elements[2].groups[0].name, 'string');
});

test('no two bodies fill the same space: a later texture takes its area, blocks keep their footprints', async () => {
  await T.loadFont('archivo');
  const word = newElement('text', { text: 'ROCK', size: 22, op: 'raise', height: 1, x: 30 });
  const block = newElement('solid', { shape: 'box', w: 12, h: 12, out: 5, x: -50 });
  const faceTex = newElement('surface', { map: 'hammered' });
  const letters = newElement('surface', { map: 'crystal', region: 'element', target: word.id });
  const d = newDesign({ mode: 'up', elements: [block, faceTex, word, letters] }); d.handles.mount = 'none'; d.handles.holes = false;
  const b = buildFace(d, size);
  const fp = id => b.solids.find(s => s.elementId === id).footprint;
  // two traced outlines meet within the mesher's tolerance (a few hundredths of a mm), so measure the overlap's
  // average thickness along the shared edge, not its area
  const perim = mp => mp.reduce((s, poly) => s + poly.reduce((t, r) => { for (let i = 0; i + 1 < r.length; i++) t += Math.hypot(r[i + 1][0] - r[i][0], r[i + 1][1] - r[i][1]); return t; }, 0), 0);
  const overlap = (a, b) => P.area(P.intersection(fp(a), fp(b))) / perim(fp(b));
  // an eighth of the 0.4 mm grid each side: 0.05 mm; a real overlap would be the bodies' whole width
  assert.ok(overlap(faceTex.id, letters.id) < 0.06, `the face texture leaves the letters to their own texture (overlap ${overlap(faceTex.id, letters.id).toFixed(3)} mm thick)`);
  assert.ok(overlap(faceTex.id, block.id) < 0.06, `and the block its footprint (${overlap(faceTex.id, block.id).toFixed(3)} mm)`);
  assert.ok(P.area(P.intersection(fp(faceTex.id), fp(letters.id))) < 0.05 * P.area(fp(letters.id)), 'nowhere near the area of the letters');
  assert.equal(runChecks(b, d, size).status, 'pass', 'it prints clean');
});

test('Sol 01a1b382: a moved block, a new picture of the same size, and a turned stretched picture all rebuild', () => {
  const block = newElement('solid', { shape: 'box', w: 10, h: 10, out: 4, x: -30 });
  const tex = newElement('surface', { map: 'noise' });
  const d = newDesign({ mode: 'up', elements: [block, tex] }); d.handles.mount = 'none'; d.handles.holes = false;
  const first = buildFace(d, size).solids.find(s => s.elementId === tex.id).footprint;
  block.x = 30;
  const second = buildFace(d, size).solids.find(s => s.elementId === tex.id).footprint;
  assert.ok(P.contains(second, -30, 0) && !P.contains(first, -30, 0), 'the hole followed the block');
  assert.ok(!P.contains(second, 30, 0), 'to its new place');
  // two pictures alike in size and first bytes, different after
  // (stored bytes, not imageFromRGBA, which stretches every picture to full range)
  const pic = fill => { const g = new Uint8Array(64 * 64); for (let i = 0; i < 64 * 64; i++) g[i] = i < 64 * 40 ? 128 : fill; return { w: 64, h: 64, g: bytesToB64(g) }; };
  const sp = newElement('surface', { map: 'picture', region: 'shape', w: 30, h: 30, data: pic(0) });
  const d2 = newDesign({ mode: 'up', elements: [sp] }); d2.handles.mount = 'none'; d2.handles.holes = false;
  const top = () => { const t = buildFace(d2, size).solids[0].tris; let z = 0; for (let i = 2; i < t.length; i += 3) z = Math.max(z, t[i]); return z; };
  const darkTop = top();
  sp.data = pic(255);
  assert.ok(Math.abs(top() - darkTop) > 0.1, 'a new picture of the same size and start rebuilds the texture');
  // a stretched picture turned a quarter: its left-right gradient now runs top to bottom
  const rgba = new Uint8ClampedArray(2 * 1 * 4); rgba.set([0, 0, 0, 255, 255, 255, 255, 255]);
  const d3 = imageFromRGBA(rgba, 2, 1), bytes = Uint8Array.from(atob(d3.g), c => c.charCodeAt(0)), picture = { w: 2, h: 1, bytes };
  const box = { x0: -10, y0: -10, w: 20, h: 20 };
  const flat = heightFunction({ map: 'picture', picture, fit: 'stretch', box });
  const turned = heightFunction({ map: 'picture', picture, fit: 'stretch', box, angle: 90 });
  assert.ok(flat(9, 0) - flat(-9, 0) > 0.8, 'unturned: dark left, light right');
  assert.ok(Math.abs(turned(9, 0) - turned(-9, 0)) < 0.2 && Math.abs(turned(0, 9) - turned(0, -9)) > 0.8, 'turned: the gradient runs up and down');
});
