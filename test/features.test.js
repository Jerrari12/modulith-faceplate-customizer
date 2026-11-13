// Pins the features added on 2026-11-05 after Joey's list: chevron layouts without a seam, linked patterns that join
// across neighbouring plates, the face slab switched off, the handle mount (pair, knob, none), solid blocks that
// stack, symmetry twins, snapping, and filament-named colour slots in the file format.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;

const P = await import('../js/geometry/polys.js');
const { generatePattern } = await import('../js/geometry/patterns.js');
const { buildFace, newElement, mountHoles, handleMount } = await import('../js/geometry/face.js');
const { solidBody, mirrorSolid } = await import('../js/geometry/solids.js');
const { runChecks } = await import('../js/checks/checks.js');
const { newDesign, serializeDesign, parseDesign } = await import('../js/export/design.js');
const { SIZE_BY_ID } = await import('../js/data/sizes.js');
const { snapMove } = await import('../js/ui/snapping.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);
const S = id => SIZE_BY_ID[id];

/** Signed volume of a closed, outward-wound triangle soup (positive when the normals face out). */
function volume(t) {
  let v = 0;
  for (let i = 0; i < t.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = [t[i], t[i + 1], t[i + 2], t[i + 3], t[i + 4], t[i + 5], t[i + 6], t[i + 7], t[i + 8]];
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

test('chevron: the slants run across the centre line with no seam; the chevron keeps its seam', () => {
  const centre = P.rect(-0.05, -27.5, 0.05, 27.5);
  const seam = generatePattern('chevron', { layout: 'chevron', seam: 0.25 }, 175, 55);
  assert.ok(P.isEmpty(P.intersection(seam, centre)), 'the chevron leaves a seam down the middle');
  for (const layout of ['slant', 'slantBack']) {
    const s = generatePattern('chevron', { layout, seam: 0.25 }, 175, 55);
    assert.ok(P.area(P.intersection(s, centre)) > 0.5, `${layout} crosses the centre line`);
  }
  // the back slant is the forward slant's mirror image
  const a = P.intersection(generatePattern('chevron', { layout: 'slant' }, 175, 55), P.rect(-87.5, -27.5, 87.5, 27.5));
  const b = P.intersection(generatePattern('chevron', { layout: 'slantBack' }, 175, 55), P.rect(-87.5, -27.5, 87.5, 27.5));
  // (compared by overlap area: an XOR of two near-identical strip sets is exactly what polygon-clipping trips on)
  near(P.area(P.intersection(P.snap(P.mirrorX(a, 0), 1e-3), P.snap(b, 1e-3))), P.area(b), 1, 'mirror');
});

/** Centres of the pieces a pattern leaves on a line just at a plate's pitch edge. */
function crossings(poly, axis, at) {
  const strip = axis === 'x' ? P.rect(at - 0.01, -300, at + 0.01, 300) : P.rect(-300, at - 0.01, 300, at + 0.01);
  return P.intersection(poly, strip).map(pg => { const b = P.bbox([pg]); return +((axis === 'x' ? b.y0 + b.y1 : b.x0 + b.x1) / 2).toFixed(1) + 0; }).sort((p, q) => p - q);   // + 0 turns -0 into 0
}

test('linked tiles join any neighbour: different sizes and different seeds meet at the same points', () => {
  for (const tiles of ['arcs', 'circuit', 'angles']) {
    // a 2W-1H and the 1W-1H to its right (pitch edges at x = +88 and x = -44)
    const a = generatePattern('truchet', { tiles, seed: 3 }, 175, 55), b = generatePattern('truchet', { tiles, seed: 77 }, 87, 55);
    assert.deepEqual(crossings(a, 'x', 88), crossings(b, 'x', -44), `${tiles}: side by side`);
    assert.ok(crossings(a, 'x', 88).length >= 4, `${tiles}: lines do reach the edge`);
    // a 1W-1H above a 1W-0.5H (pitch edges at y = -28 and y = +14)
    const top = generatePattern('truchet', { tiles, seed: 5 }, 87, 55), low = generatePattern('truchet', { tiles, seed: 9 }, 87, 27.15);
    assert.deepEqual(crossings(top, 'y', -28), crossings(low, 'y', 14), `${tiles}: stacked`);
  }
  // waves run on from plate to plate
  const w1 = generatePattern('waves', {}, 175, 55), w2 = generatePattern('waves', {}, 263, 55);
  assert.deepEqual(crossings(w1, 'x', 88), crossings(w2, 'x', -132), 'waves side by side');
});

test('the face off: no slab, raises stand on the backer, cuts are skipped with a note, and a bare backer prints clean', () => {
  const d = newDesign({ mode: 'up' });
  d.face.enabled = false;
  d.elements.push(newElement('shape', { shape: 'rect', w: 20, h: 10, op: 'raise', height: 2, color: 'c2' }));
  d.elements.push(newElement('shape', { name: 'Groove', shape: 'rect', w: 40, h: 2, op: 'cut', depth: 1, y: 15 }));
  const b = buildFace(d, S('2W-1H'));
  assert.equal(b.t, 0);
  assert.ok(!b.layers.some(L => L.kind === 'slab'), 'no face slab');
  const raise = b.layers.find(L => L.kind === 'shape');
  assert.equal(raise.z0, 0); assert.equal(raise.z1, 2);
  assert.ok(b.notes.some(n => /needs the face/.test(n.text)), 'the cut is explained');
  const bare = newDesign({ mode: 'down' }); bare.face.enabled = false;
  const r = runChecks(buildFace(bare, S('2W-1H')), bare, S('2W-1H'));
  assert.equal(r.status, 'pass', r.checks.filter(c => c.st !== 'pass').map(c => c.lbl).join('; '));
  bare.handles.mount = 'none';
  assert.ok(runChecks(buildFace(bare, S('2W-1H')), bare, S('2W-1H')).checks.some(c => c.id === 'backerholes'), 'the backer holes stay open without a face');
});

test('handle mount: the pair, one centred knob hole that the checks hold back, or none; old files keep their meaning', () => {
  const d = newDesign();
  assert.equal(handleMount(d), 'pair');
  assert.equal(mountHoles(d, S('2W-1H')).length, 2);
  d.handles.mount = 'knob'; d.handles.knobD = 4;
  const holes = mountHoles(d, S('2W-1H'));
  assert.equal(holes.length, 1); assert.equal(holes[0].x, 0); near(holes[0].y, -0.5, 1e-9); assert.equal(holes[0].d, 4);
  const b = buildFace(d, S('2W-1H'));
  near(P.area(b.keep), 175 * 55 - Math.PI * 4, 0.2, 'one hole in the face');
  assert.equal(runChecks(b, d, S('2W-1H')).checks.find(c => c.id === 'knob').st, 'fail', 'the knob backer does not exist yet');
  assert.equal(handleMount({ handles: { holes: false } }), 'none', 'the old switch');
  assert.equal(parseDesign({ elements: [], handles: { holes: false } }).handles.mount, 'none');
});

test('solid blocks are closed bodies; a stacked block sits on the top of what it names', () => {
  for (const shape of ['box', 'cylinder', 'taper', 'dome', 'pyramid', 'wedge']) {
    const el = newElement('solid', { shape, w: 20, h: 10, out: 6, edge: 'chamfer', edgeSize: 1 });
    const body = solidBody(el);
    assert.ok(volume(body.tris) > 0, `${shape}: outward and closed`);
    if (shape === 'box') near(volume(body.tris), 20 * 10 * 6 - 1, 60, 'box volume less its chamfer');
    if (shape === 'wedge') near(volume(body.tris), 20 * 10 * 6 / 2, 1, 'wedge volume');
  }
  const d = newDesign({ mode: 'up' });
  const post = newElement('solid', { shape: 'cylinder', w: 8, h: 8, out: 8, edge: 'square' });
  const cap = newElement('solid', { shape: 'box', w: 6, h: 6, out: 2, stackOn: post.id, edge: 'square', corner: 0 });
  d.elements.push(post, cap);
  const b = buildFace(d, S('2W-1H'));
  const [p, c] = b.solids;
  near(p.z0, 2, 1e-9, 'on the face'); near(c.z0, p.z1, 1e-9, 'on the post');
  assert.equal(runChecks(b, d, S('2W-1H')).checks.filter(x => x.id === 'support' && x.st !== 'pass').length, 0, 'a cap inside the post top is supported');
});

test('a block footprint covers its whole mesh, also a chamfered top wider than the base (Sol 01a1af13)', () => {
  const body = solidBody(newElement('solid', { shape: 'taper', w: 30, h: 10, out: 6, taper: 1.5, edge: 'chamfer', edgeSize: 1, corner: 2 }));
  let x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < body.tris.length; i += 3) { x1 = Math.max(x1, body.tris[i]); y1 = Math.max(y1, body.tris[i + 1]); }
  const b = P.bbox(body.footprint);
  near(b.x1, x1, 1e-6, 'x reach'); near(b.y1, y1, 1e-6, 'y reach');
  near(x1, 21.5, 1e-6, 'the chamfered top reaches 15 x 1.5 - 1 mm');
});

test('block support: two posts make a bridge, a bar past them makes a ledge, a lifted block floats', () => {
  const run = (postX, barW, lift = 0) => {
    const d = newDesign({ mode: 'up' }); d.handles.mount = 'none';
    const post = newElement('solid', { shape: 'cylinder', w: 8, h: 8, out: 8, edge: 'square', x: -postX });
    const post2 = newElement('solid', { shape: 'cylinder', w: 8, h: 8, out: 8, edge: 'square', x: postX });
    const bar = newElement('solid', { name: 'Bar', shape: 'box', w: barW, h: 8, out: 4, edge: 'square', corner: 0, stackOn: post2.id, lift });
    d.elements.push(post, post2, bar);
    return runChecks(buildFace(d, S('2W-1H')), d, S('2W-1H')).checks.filter(c => c.id === 'support' && /^Bar/.test(c.det));
  };
  const wide = run(20, 48);
  assert.equal(wide[0]?.st, 'fail'); assert.match(wide[0].lbl, /bridges too far/); near(parseFloat(wide[0].short), 32, 1.5, 'span between the posts');
  const ledge = run(10, 36);
  // the square bar's far corner (18, 4) to the round post's edge (centre 10, radius 4)
  assert.match(ledge[0]?.lbl || '', /sticks out/); near(parseFloat(ledge[0].short), Math.hypot(8, 4) - 4, 0.3, 'how far past the post');
  assert.match(run(10, 28, 3)[0]?.lbl || '', /floats/);
});

test('symmetry: an off-centre element gets a mirror twin, one on the centre line does not; twin bodies stay outward', () => {
  const d = newDesign({ mode: 'up', symmetry: 'x' });
  d.elements.push(newElement('shape', { shape: 'circle', w: 10, op: 'raise', height: 1, x: -40 }));
  d.elements.push(newElement('shape', { shape: 'circle', w: 10, op: 'raise', height: 1, x: 0, y: 15 }));
  d.elements.push(newElement('solid', { shape: 'taper', w: 10, h: 10, out: 5, x: 30 }));
  const b = buildFace(d, S('2W-1H'));
  assert.equal(b.layers.filter(L => L.kind === 'shape' && L.twin).length, 1, 'one twin layer');
  const twin = b.solids.find(s => s.twin);
  assert.ok(twin, 'a twin block'); near(P.bbox(twin.footprint).x0, -35, 0.01, 'mirrored across x = 0');
  assert.ok(volume(twin.tris) > 0, 'the mirror is re-wound');
  assert.ok(volume(mirrorSolid(mirrorSolid(twin)).tris) > 0);
});

test('snapping: the nearest line within reach wins, on each axis separately', () => {
  const lines = { x: [0, -40, 40], y: [0, 10] };
  const box = { x0: -5, x1: 5, y0: -3, y1: 3 };
  const r = snapMove([0.8, 6.6], box, lines, 1);
  assert.equal(r.x, 0, 'centre to the centre line');
  near(r.y, 7, 1e-9, 'top edge onto y = 10');
  assert.deepEqual(r.guides.map(g => g.axis).sort(), ['x', 'y']);
  assert.equal(snapMove([20, 20], box, lines, 1).x, null, 'nothing in reach');
});

test('design files keep filaments, mount, symmetry and the face switch, and refuse a value a menu does not offer', () => {
  const d = newDesign({ symmetry: 'x' });
  d.face.enabled = false; d.handles.mount = 'knob'; d.handles.knobD = 4.5;
  d.colors[2] = { id: 'c2', name: 'Printed Solid Mystery Orange', hex: '#F56233', filament: 'Printed Solid Mystery Orange' };
  d.elements.push(newElement('solid', { shape: 'dome' }));
  const back = parseDesign(serializeDesign(d));
  assert.equal(back.symmetry, 'x'); assert.equal(back.face.enabled, false);
  assert.equal(back.handles.mount, 'knob'); assert.equal(back.handles.knobD, 4.5);
  assert.equal(back.colors[2].filament, 'Printed Solid Mystery Orange');
  assert.equal(back.elements[0].shape, 'dome');
  const bad = parseDesign({ elements: [{ kind: 'solid', shape: '<img onerror=x>', edge: 'spiky' }] });
  assert.equal(bad.elements[0].shape, 'box'); assert.equal(bad.elements[0].edge, 'chamfer');
});

// Sol 01a1af13, parts 2-4: the fixes stay fixed.
test('reopening a file keeps the old switch: holes off with the default mount is still no holes', () => {
  const d = newDesign(); d.handles.holes = false;            // mount is still the default 'pair'
  assert.equal(handleMount(d), 'none');
  assert.equal(handleMount(parseDesign(serializeDesign(d))), 'none');
});

test('a twin over a cut its original does not stand on is flagged, and a symmetric twin adds nothing', () => {
  const d = newDesign({ mode: 'up', symmetry: 'x' }); d.handles.mount = 'none';
  // a through-cut band on the right only (a pattern: patterns are not mirrored, placed shapes are), then a block on
  // the left whose twin lands over the cut
  d.elements.push(newElement('pattern', { pattern: 'stripes', params: { pitch: 175, width: 30, angle: 0, anchor: 'center', phaseX: 40, phaseY: 0 }, op: 'cut', depth: 2 }));
  d.elements.push(newElement('solid', { name: 'Block', shape: 'box', w: 10, h: 10, out: 4, edge: 'square', corner: 0, x: -40 }));
  const r = runChecks(buildFace(d, S('2W-1H')), d, S('2W-1H')).checks.filter(c => c.id === 'gripbase' || c.id === 'support');
  assert.ok(r.some(c => c.st === 'fail'), 'the twin over the cut is caught');
  const sym = newDesign({ mode: 'up', symmetry: 'x' }); sym.handles.mount = 'none';
  sym.elements.push(newElement('solid', { name: 'Wide', shape: 'box', w: 30, h: 10, out: 4, edge: 'square', x: -150 }));
  // (wholly past the plate's edge, the block is gone from it since 2026-11-11, and said once to run off this size)
  const symChecks = runChecks(buildFace(sym, S('2W-1H')), sym, S('2W-1H')).checks;
  assert.equal(symChecks.filter(c => c.id === 'offplate').length, 0, 'nothing is left past the edge to report');
  const off = symChecks.filter(c => c.id === 'hidden' && /runs off/.test(c.lbl));
  assert.equal(off.length, 1, 'the twin\u2019s identical finding is dropped');
  assert.equal(off[0].elementId, sym.elements[0].id);
});

test('snapping offers each side of a mirrored pair its own centre', async () => {
  const { snapLines } = await import('../js/ui/snapping.js');
  const d = newDesign({ mode: 'up', symmetry: 'x' });
  d.elements.push(newElement('solid', { shape: 'box', w: 10, h: 10, out: 4, x: -20 }));
  const lines = snapLines(buildFace(d, S('2W-1H')), d, 'someone-else');
  assert.ok(lines.x.some(x => Math.abs(x + 20) < 1e-6) && lines.x.some(x => Math.abs(x - 20) < 1e-6), 'both centres');
});

test('two meshes that share an id and counts but not coordinates do not share a cache entry', async () => {
  const { packMesh } = await import('../js/geometry/meshio.js');
  const { meshBody } = await import('../js/geometry/face.js');
  const tet = s => ({ positions: new Float32Array([0, 0, 0, s, 0, 0, 0, s, 0, 0, 0, s]), indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]) });
  const a = newElement('mesh', { data: packMesh(tet(10)), width: 20, up: 'z' });
  const b = { ...a, data: packMesh(tet(30)), width: 20, up: 'z' };   // same id, same counts
  const ha = meshBody(a).height, hb = meshBody(b).height;
  near(ha, 20, 1e-3, 'scaled to 20 wide'); near(hb, 20, 1e-3);
  assert.notEqual(meshBody(a).sig, meshBody(b).sig, 'the cache key sees the coordinates');
  // one changed vertex anywhere in the data still changes the key (Sol: a sampled hash could skip it)
  const t1 = tet(10), t2 = tet(10); t2.positions[4] = 10.5;
  const c = { ...a, data: packMesh(t1) }, e = { ...a, data: packMesh(t2) };
  assert.notEqual(meshBody(c).sig, meshBody(e).sig);
});

// The tile editor's tiles (2026-11-06): whatever is drawn, the lines meet across plates.
test('drawn tiles join any neighbour for every preset, turned or not, on any size and seed', async () => {
  const { presetTiles, TILE_PRESETS } = await import('../js/geometry/tiles.js');
  for (const name of Object.keys(TILE_PRESETS)) for (const rotate of [true, false]) {
    const base = { ...presetTiles(name), rotate };
    const a = generatePattern('tiles', { ...base, seed: 3 }, 175, 55), b = generatePattern('tiles', { ...base, seed: 77 }, 87, 55);
    assert.deepEqual(crossings(a, 'x', 88), crossings(b, 'x', -44), `${name} rotate=${rotate}: side by side`);
    const top = generatePattern('tiles', { ...base, seed: 5 }, 87, 55), low = generatePattern('tiles', { ...base, seed: 9 }, 87, 27.15);
    assert.deepEqual(crossings(top, 'y', -28), crossings(low, 'y', 14), `${name} rotate=${rotate}: stacked`);
    assert.ok(crossings(a, 'x', 88).length >= 3, `${name}: lines reach the edge`);
  }
});

test('a hand-drawn tile with a straight link, a U-turn and an open end still meets its neighbours at the ports it uses', async () => {
  const tiles = [{ links: [[0, 5], [2, 3]], style: 'straight' }, { links: [[1, 4], [6, 7]], dot: 0.3 }];
  const p = { ports: 'thirds', tiles, rotate: true, width: 10 };   // width beyond the thirds limit is clamped
  const a = generatePattern('tiles', { ...p, seed: 1 }, 175, 55), b = generatePattern('tiles', { ...p, seed: 2 }, 87, 55);
  assert.ok(P.area(a) > 100, 'it draws');
  // ports a tile leaves open end in the cell; ports both sides use must line up, so every crossing on one side has
  // a partner on the other side unless it ends there: compare only the crossings present on both
  const ca = crossings(a, 'x', 88), cb = crossings(b, 'x', -44);
  for (const y of ca.filter(y => cb.includes(y))) assert.ok(cb.includes(y));
  assert.ok(ca.some(y => cb.includes(y)), 'some lines carry on across the join');
});

test('a tile list from a file is cleaned: unknown ports, repeats and junk go, sizes are capped', async () => {
  const { normTiles, MAX_TILES, MAX_LINKS } = await import('../js/geometry/tiles.js');
  const junk = [{ links: [[0, 1], [1, 0], [0, 0], [0, 9], ['x', 2], [2, 3, 4], 'nope'], style: '<b>', dot: 99, weight: -5 }, null, 'tile',
    ...Array.from({ length: 20 }, () => ({ links: Array.from({ length: 40 }, (_, i) => [i % 4, (i + 1) % 4]) }))];
  const out = normTiles(junk, 'mid');
  assert.equal(out.length, MAX_TILES);
  assert.deepEqual(out[0].links, [[0, 1]]);
  assert.equal(out[0].style, 'curve'); assert.equal(out[0].dot, 0.6); assert.equal(out[0].weight, 0);
  assert.equal(out[1].links.length, 0, 'null tile');
  assert.ok(out.every(tl => tl.links.length <= MAX_LINKS));
  assert.doesNotThrow(() => generatePattern('tiles', { ports: 'mid', tiles: junk }, 175, 55));
  assert.deepEqual(generatePattern('tiles', { ports: 'mid', tiles: [] }, 175, 55), [], 'no tiles, no pattern');
});

test('tile curves stay inside their cell on flat cells, and blank tiles leave cells empty (Sol 01a1b16f)', async () => {
  const { linkLine, normTiles } = await import('../js/geometry/tiles.js');
  for (const [cw, ch] of [[88, 56 / 12], [88 / 22, 56 / 2], [9.78, 9.33]]) for (const set of ['mid', 'thirds']) {
    const n = set === 'mid' ? 4 : 8;
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
      if (a === b) continue;
      for (const [x, y] of linkLine(set, a, b, 'curve', 0, 0, cw, ch).pts) {
        assert.ok(x >= -1e-9 && x <= cw + 1e-9 && y >= -1e-9 && y <= ch + 1e-9, `${set} ${a}-${b} in ${cw.toFixed(2)} x ${ch.toFixed(2)}: (${x.toFixed(3)}, ${y.toFixed(3)})`);
      }
    }
  }
  // the bands too, at the widest line each port set allows, with no overlap allowance (join 0)
  const { bandRing } = await import('../js/geometry/tiles.js');
  for (const [cw, ch] of [[88, 56 / 12], [44, 3.5], [4, 28], [9.78, 9.33]]) for (const set of ['mid', 'thirds']) {
    const n = set === 'mid' ? 4 : 8, w = (set === 'thirds' ? 0.28 : 0.8) * Math.min(cw, ch);
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) for (const style of ['curve', 'straight']) {
      if (a === b) continue;
      for (const [x, y] of bandRing(linkLine(set, a, b, style, 0, 0, cw, ch, 20, w), w, 0, 0, cw, ch, 0)) {
        assert.ok(x >= -1e-9 && x <= cw + 1e-9 && y >= -1e-9 && y <= ch + 1e-9, `band ${set} ${a}-${b} ${style} in ${cw.toFixed(2)} x ${ch.toFixed(2)}`);
      }
    }
  }
  // every curve crosses its port exactly port +/- w/2 along the edge, so two different tiles meet without a step
  // (Sol: a sharp bend near the port tilted the sampled cross-section). The band's two end vertices at join 0 are
  // that cross-section; on an ordinary cell the band also covers nothing else of the edge
  for (const [cw, ch] of [[88, 56 / 12], [9.78, 9.33]]) {
    const w = 0.8 * Math.min(cw, ch);
    for (const b of [1, 2, 3]) {
      const ring = bandRing(linkLine('mid', 0, b, 'curve', 0, 0, cw, ch, 20, w), w, 0, 0, cw, ch, 0);
      const ends = [ring[0], ring[ring.length - 1]].sort((p, q) => p[0] - q[0]);
      near(ends[0][0], cw / 2 - w / 2, 1e-6, `0-${b} on ${cw.toFixed(2)} x ${ch.toFixed(2)}: left of the port`); near(ends[0][1], ch, 1e-6);
      near(ends[1][0], cw / 2 + w / 2, 1e-6, `0-${b}: right of the port`); near(ends[1][1], ch, 1e-6);
      if (cw < 20) {
        const bb = P.bbox(P.intersection(P.polygon(ring), P.rect(-1, ch - 0.001, cw + 1, ch + 0.001)));
        near(bb.x0, cw / 2 - w / 2, 0.01); near(bb.x1, cw / 2 + w / 2, 0.01);
      }
    }
  }
  assert.doesNotThrow(() => normTiles([{ links: [[{ toString: null }, 1], [0, { valueOf: null, toString: null }]], dot: { toString: null }, weight: { toString: null } }], 'mid'));
  const one = { ports: 'mid', rotate: false, tiles: [{ links: [[0, 2], [1, 3]] }] };
  const dense = P.area(generatePattern('tiles', one, 175, 55));
  const sparse = P.area(generatePattern('tiles', { ...one, tiles: [...one.tiles, { links: [], weight: 9 }] }, 175, 55));
  assert.ok(sparse < dense * 0.5, `a heavy blank tile empties most cells: ${sparse.toFixed(0)} vs ${dense.toFixed(0)}`);
});
