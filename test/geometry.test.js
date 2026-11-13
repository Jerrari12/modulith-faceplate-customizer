import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The package is "type": "module", so require() loads these UMD files as ESM: the UMD wrapper then finds no
// CommonJS exports and installs the library on globalThis itself. Keep whichever form came back working.
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;
const zipLib = require('../vendor/jszip/jszip.min.js');
if (zipLib && zipLib.loadAsync) globalThis.JSZip = zipLib;

const P = await import('../js/geometry/polys.js');
const { generatePattern } = await import('../js/geometry/patterns.js');
const { buildFace, newElement, faceTriangles } = await import('../js/geometry/face.js');
const { extrudeMultiPolygon, sweepProfileX } = await import('../js/geometry/extrude.js');
const { rasterize, regionStats, frameFor } = await import('../js/checks/raster.js');
const { runChecks } = await import('../js/checks/checks.js');
const { newDesign, serializeDesign, parseDesign } = await import('../js/export/design.js');
const { buildPrusa3MF, buildBambu3MF, indexTriangles } = await import('../js/export/threemf.js');
const { stlBuffer } = await import('../js/export/stl.js');
const { orientForPrint } = await import('../js/export/orient.js');
const { SIZES, SIZE_BY_ID } = await import('../js/data/sizes.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);

test('polys: areas, booleans and winding', () => {
  const a = P.rect(0, 0, 10, 10), b = P.rect(5, 0, 15, 10);
  near(P.area(a), 100, 1e-9, 'rect area');
  near(P.area(P.union(a, b)), 150, 1e-9, 'union area');
  near(P.area(P.intersection(a, b)), 50, 1e-9, 'intersection area');
  const holed = P.difference(a, P.circle(5, 5, 2, 64));
  assert.equal(holed.length, 1); assert.equal(holed[0].length, 2, 'one hole ring');
  assert.ok(P.ringArea(holed[0][0]) > 0, 'outer ring CCW'); assert.ok(P.ringArea(holed[0][1]) < 0, 'hole ring CW');
  near(P.area(holed), 100 - Math.PI * 4, 0.05, 'holed area');
  assert.ok(P.contains(a, 5, 5)); assert.ok(!P.contains(holed, 5, 5));
  const m = P.mirrorX(P.polygon([[1, 0], [3, 0], [3, 2]]), 0);
  assert.ok(P.ringArea(m[0][0]) > 0, 'mirror keeps CCW');
});

test('patterns cover a plate at the expected fill ratio', () => {
  const W = 87, H = 55, plate = P.rect(-W / 2, -H / 2, W / 2, H / 2);
  const s = P.intersection(generatePattern('stripes', { pitch: 10, width: 6, angle: 30 }, W, H), plate);
  near(P.area(s) / (W * H), 0.6, 0.03, 'stripes fill');
  const c = P.intersection(generatePattern('chevron', { pitch: 14, groove: 0.25, seam: 0.25 }, W, H), plate);
  near(P.area(c) / (W * H), (14 * Math.SQRT1_2 - 0.25) / (14 * Math.SQRT1_2), 0.02, 'chevron fill');
  const bb = P.bbox(c); near(bb.x0, -W / 2, 1e-6); near(bb.x1, W / 2, 1e-6);
  const left = P.area(P.intersection(c, P.rect(-W / 2, -H / 2, 0, H / 2))), right = P.area(P.intersection(c, P.rect(0, -H / 2, W / 2, H / 2)));
  near(left, right, 1e-6, 'chevron is mirror-symmetric');
  const d = P.intersection(generatePattern('dots', { pitchX: 8, pitchY: 8, diameter: 4, stagger: true }, W, H), plate);
  near(P.area(d) / (W * H), Math.PI * 4 / 64, 0.03, 'dots fill');
  for (const kind of ['grid', 'bricks', 'hex', 'checker']) {
    const g = P.intersection(generatePattern(kind, {}, W, H), plate);
    assert.ok(P.area(g) > 0.05 * W * H && P.area(g) < 0.98 * W * H, `${kind} fills some of the plate`);
  }
});

test('face builder: slab, holes, raise, cut and clamping', () => {
  const size = SIZE_BY_ID['1W-1H'];
  const design = newDesign();
  let built = buildFace(design, size);
  assert.equal(built.layers.length, 1);
  near(P.area(built.keep), 87 * 55 - 2 * Math.PI * 1.6 * 1.6, 0.2, 'keep area minus two holes');
  near(built.layers[0].z1, 2, 1e-9);

  design.elements.push(newElement('shape', { shape: 'rect', w: 20, h: 10, op: 'raise', height: 1.5, color: 'c2' }));
  built = buildFace(design, size);
  assert.equal(built.layers.length, 2);
  const r = built.layers.find(L => L.kind === 'shape');
  near(r.z0, 2, 1e-9); near(r.z1, 3.5, 1e-9); near(P.area(r.poly), 200, 1e-6);

  design.elements.push(newElement('shape', { shape: 'circle', w: 6, op: 'cut', depth: 0.5, x: 0, y: 0 }));
  built = buildFace(design, size);
  // the circle cuts the raised rect fully (cut goes up through everything) and the slab down to 1.5
  const raisedNow = built.layers.filter(L => L.kind === 'shape');
  assert.equal(raisedNow.length, 1); near(P.area(raisedNow[0].poly), 200 - Math.PI * 9, 0.5, 'rect carved by circle (24-gon circle)');
  const slabs = built.layers.filter(L => L.kind === 'slab').sort((a, b) => a.z0 - b.z0);
  assert.equal(slabs.length, 2, 'slab split into below-cut and beside-cut');
  near(slabs[0].z1, 1.5, 1e-9); near(slabs[1].z0, 1.5, 1e-9);

  design.elements[1].depth = 9;   // deeper than the face: clamps at the backer and notes it
  built = buildFace(design, size);
  assert.ok(built.notes.some(n => /backer/.test(n.text)));
  assert.ok(built.layers.every(L => L.z0 >= 0));
  design.handles.holes = false;
  built = buildFace(design, size);
  near(P.area(built.keep), 87 * 55, 1e-6, 'no holes when off');
});

function manifoldCheck(tris) {
  const edges = new Map();
  const key = (a, b) => `${a.join(',')}|${b.join(',')}`;
  for (let i = 0; i < tris.length; i += 9) {
    const v = [[tris[i], tris[i + 1], tris[i + 2]], [tris[i + 3], tris[i + 4], tris[i + 5]], [tris[i + 6], tris[i + 7], tris[i + 8]]].map(p => p.map(x => +x.toFixed(6)));
    for (let k = 0; k < 3; k++) { const a = v[k], b = v[(k + 1) % 3]; edges.set(key(a, b), (edges.get(key(a, b)) || 0) + 1); }
  }
  let bad = 0;
  for (const [k, n] of edges) { const [a, b] = k.split('|'); if (n !== 1 || edges.get(`${b}|${a}`) !== 1) bad++; }
  return bad;
}

function signedVolume(tris) {
  let v = 0;
  for (let i = 0; i < tris.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = tris.slice(i, i + 9);
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

test('extrusion is closed, outward and the right volume', () => {
  const holed = P.difference(P.rect(0, 0, 10, 10), P.circle(5, 5, 2, 32));
  const tris = extrudeMultiPolygon(holed, 1, 3);
  assert.equal(manifoldCheck(tris), 0, 'every edge shared by exactly two opposite half-edges');
  near(signedVolume(tris), P.area(holed) * 2, 1e-6, 'volume = area x height');
  const sweep = sweepProfileX([[-4, 0], [4, 0], [5, 6], [-5, 6]], -25, 25);
  assert.equal(manifoldCheck(sweep), 0);
  near(signedVolume(sweep), 54 * 50, 1e-6, 'wedge volume');
});

test('raster: inscribed widths', () => {
  const frame = frameFor({ x0: 0, y0: 0, x1: 20, y1: 20 }, 0.1);
  const m1 = rasterize(P.rect(2, 2, 12, 12), frame.x0, frame.y0, frame.w, frame.h, frame.res);
  const s1 = regionStats(m1, frame.w, frame.h, frame.res, frame.x0, frame.y0);
  assert.equal(s1.length, 1); near(s1[0].maxWidth, 10, 0.25, 'square width'); near(s1[0].areaMm2, 100, 1);
  const m2 = rasterize(P.union(P.rect(2, 2, 2.5, 18), P.rect(10, 2, 13, 18)), frame.x0, frame.y0, frame.w, frame.h, frame.res);
  const s2 = regionStats(m2, frame.w, frame.h, frame.res, frame.x0, frame.y0).sort((a, b) => a.maxWidth - b.maxWidth);
  assert.equal(s2.length, 2); near(s2[0].maxWidth, 0.5, 0.15, 'thin strip'); near(s2[1].maxWidth, 3, 0.25, 'wide strip');
});

test('checks: face-down rules', () => {
  const size = SIZE_BY_ID['1W-1H'];
  const design = newDesign();
  design.elements.push(newElement('pattern', { pattern: 'chevron', params: { pitch: 14, groove: 0.25, seam: 0.25, angle: 45 }, op: 'cut', depth: 2, invert: true }));
  let res = runChecks(buildFace(design, size), design, size);
  assert.equal(res.checks.find(c => c.id === 'groove').st, 'pass', 'chevron grooves stay open');
  assert.equal(res.checks.find(c => c.id === 'bridge').st, 'pass', 'chevron grooves bridge');
  assert.equal(res.status, 'pass', JSON.stringify(res.checks.filter(c => c.st !== 'pass').map(c => c.lbl)));

  design.elements = [newElement('shape', { shape: 'circle', w: 30, op: 'cut', depth: 1, x: 0, y: 15 })];
  res = runChecks(buildFace(design, size), design, size);
  assert.equal(res.checks.find(c => c.id === 'bridge').st, 'fail', 'a 30 mm recess cannot be bridged');

  design.elements = [newElement('grip', { style: 'wedge' })];
  res = runChecks(buildFace(design, size), design, size);
  assert.equal(res.checks.find(c => c.id === 'grip').st, 'fail', 'grips need face up');

  design.elements = [newElement('shape', { shape: 'rect', w: 20, h: 6, op: 'raise', height: 1, x: 22, y: -0.5 })];
  res = runChecks(buildFace(design, size), design, size);
  assert.equal(res.checks.find(c => c.id === 'holes').st, 'fail', 'relief over a screw hole');

  design.elements = [newElement('pattern', { pattern: 'stripes', params: { pitch: 2, width: 1.85 }, op: 'cut', depth: 1 })];
  res = runChecks(buildFace(design, size), design, size);
  assert.equal(res.checks.find(c => c.id === 'groove').st, 'pass', '0.15 mm ribs are features, not grooves');
  assert.equal(res.checks.find(c => c.id === 'thin').st, 'fail', '0.15 mm ribs vanish (exact, from the pattern)');
  design.elements[0].params.width = 0.15;
  res = runChecks(buildFace(design, size), design, size);
  assert.equal(res.checks.find(c => c.id === 'groove').st, 'warn', '0.15 mm grooves close (exact, from the pattern)');
});

test('checks: face-up rules', () => {
  const size = SIZE_BY_ID['2W-1H'];
  const design = newDesign({ mode: 'up' });
  design.handles.holes = false;
  design.elements.push(newElement('grip', { style: 'wedge', undercut: 3, height: 6, length: 60, y: -10 }));
  let res = runChecks(buildFace(design, size), design, size);
  assert.equal(res.status, 'pass', JSON.stringify(res.checks.filter(c => c.st !== 'pass').map(c => c.lbl)));
  design.elements[0].undercut = 12; design.elements[0].height = 4; design.elements[0].depth = 30;
  res = runChecks(buildFace(design, size), design, size);
  assert.equal(res.checks.find(c => c.id === 'overhang').st, 'fail', 'steep undercut');
  // a raise on top of a cut floats
  design.elements = [newElement('shape', { shape: 'rect', w: 30, h: 20, op: 'cut', depth: 1 }), newElement('shape', { shape: 'rect', w: 20, h: 10, op: 'raise', height: 1 })];
  res = runChecks(buildFace(design, size), design, size);
  assert.equal(res.checks.find(c => c.id === 'support').st, 'fail', 'raise over a pocket floats');
});

test('design file round trip', () => {
  const d = newDesign({ name: 'Round trip' });
  d.elements.push(newElement('pattern', { pattern: 'dots' }), newElement('grip'));
  const back = parseDesign(serializeDesign(d));
  assert.equal(back.name, 'Round trip'); assert.equal(back.elements.length, 2); assert.equal(back.elements[0].params.pitchX, 8);
  assert.throws(() => parseDesign('{"nope":1}'));
});

test('3MF and STL writers produce the expected package', async () => {
  const size = SIZE_BY_ID['1W-05H'];
  const design = newDesign();
  design.elements.push(newElement('pattern', { pattern: 'stripes', op: 'raise', height: 1, color: 'c2' }));
  const built = buildFace(design, size);
  const bodies = faceTriangles(built, extrudeMultiPolygon).map((b, i) => ({ name: b.name, tris: orientForPrint(b.tris, 'down', 3, { w: 250, l: 220 }), extruder: i + 1 }));
  const blob = await buildPrusa3MF({ bodies, name: 'test', profileIni: '; test = 1\n' });
  const zip = await globalThis.JSZip.loadAsync(await blob.arrayBuffer());
  const names = Object.keys(zip.files).sort();
  assert.deepEqual(names, ['3D/', '3D/3dmodel.model', 'Metadata/', 'Metadata/Slic3r_PE.config', 'Metadata/Slic3r_PE_model.config', '[Content_Types].xml', '_rels/', '_rels/.rels']);
  const cfg = await zip.file('Metadata/Slic3r_PE_model.config').async('string');
  assert.equal((cfg.match(/<volume /g) || []).length, bodies.length);
  const bb = await buildBambu3MF({ bodies, name: 'test' });
  const z2 = await globalThis.JSZip.loadAsync(await bb.arrayBuffer());
  assert.ok(z2.file('Metadata/model_settings.config'));
  const stl = stlBuffer(bodies.map(b => b.tris));
  assert.equal(stl.byteLength, 84 + 50 * bodies.reduce((n, b) => n + b.tris.length / 9, 0));
  const idx = indexTriangles(bodies[0].tris);
  assert.ok(idx.verts.length < bodies[0].tris.length / 3, 'vertices are shared');
});

test('performance: largest plate with a chevron builds and checks quickly enough', () => {
  const size = SIZE_BY_ID['4W-2H'];
  const design = newDesign();
  design.elements.push(newElement('pattern', { pattern: 'chevron', op: 'cut', depth: 2, invert: true }));
  const t0 = performance.now();
  const built = buildFace(design, size);
  const t1 = performance.now();
  const res = runChecks(built, design, size);
  const t2 = performance.now();
  console.log(`  4W-2H chevron: build ${(t1 - t0).toFixed(0)} ms, checks ${(t2 - t1).toFixed(0)} ms, layers ${built.layers.length}, status ${res.status}`);
  assert.ok(t2 - t0 < 15000);
});
