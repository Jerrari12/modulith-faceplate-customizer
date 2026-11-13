import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;

const P = await import('../js/geometry/polys.js');
const { parseStl, parseObj, packMesh, unpackMesh, flatten, toBinaryStl, meshBounds } = await import('../js/geometry/meshio.js');
const { rasterizeTriangles, traceMask } = await import('../js/checks/trace.js');
const { buildFace, newElement, meshBody } = await import('../js/geometry/face.js');
const { runChecks } = await import('../js/checks/checks.js');
const { newDesign, serializeDesign, parseDesign } = await import('../js/export/design.js');
const { SIZE_BY_ID } = await import('../js/data/sizes.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);

/** A box w x d x h (z up) as flat triangles, optionally with a lip: a slab on top overhanging by `lip` on +y. */
function boxTris(w, d, h, lip = 0, lipT = 1) {
  const out = [];
  const box = (x0, y0, z0, x1, y1, z1) => {
    const q = (a, b, c, dd) => out.push(...a, ...b, ...c, ...a, ...c, ...dd);
    const p = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    q(p[0], p[3], p[2], p[1]); q(p[4], p[5], p[6], p[7]);   // bottom (down), top (up)
    q(p[0], p[1], p[5], p[4]); q(p[1], p[2], p[6], p[5]); q(p[2], p[3], p[7], p[6]); q(p[3], p[0], p[4], p[7]);
  };
  box(-w / 2, -d / 2, 0, w / 2, d / 2, h);
  if (lip) box(-w / 2, d / 2, h - lipT, w / 2, d / 2 + lip, h);   // the lip only where it overhangs (no internal faces)
  return new Float32Array(out);
}

test('STL round trip, binary and ASCII, and OBJ', () => {
  const tris = boxTris(20, 10, 5);
  const bin = parseStl(toBinaryStl(tris));
  assert.equal(bin.indices.length / 3, 12); assert.equal(bin.positions.length / 3, 8, 'welded to 8 corners');
  let ascii = 'solid box\n';
  for (let i = 0; i < tris.length; i += 9) ascii += ` facet normal 0 0 0\n  outer loop\n   vertex ${tris[i]} ${tris[i + 1]} ${tris[i + 2]}\n   vertex ${tris[i + 3]} ${tris[i + 4]} ${tris[i + 5]}\n   vertex ${tris[i + 6]} ${tris[i + 7]} ${tris[i + 8]}\n  endloop\n endfacet\n`;
  ascii += 'endsolid box\n';
  const asc = parseStl(new TextEncoder().encode(ascii).buffer);
  assert.equal(asc.indices.length / 3, 12);
  const obj = parseObj('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n');
  assert.equal(obj.indices.length / 3, 2, 'quad fan-triangulated');
  const packed = packMesh(bin), back = unpackMesh(packed);
  assert.deepEqual(Array.from(back.indices), Array.from(bin.indices));
  near(meshBounds(back).x1, 10, 1e-6);
  assert.equal(flatten(back).length, 12 * 9);
  assert.throws(() => parseStl(new ArrayBuffer(10)));
});

test('raster tracing recovers a box footprint with a hole', () => {
  const frame = { x0: -20, y0: -20, w: 160, h: 160, res: 0.25 };
  const tris = boxTris(20, 10, 5);
  const mask = rasterizeTriangles(tris, frame);
  const polys = traceMask(mask, frame);
  assert.equal(polys.length, 1);
  near(P.area(polys), 200, 6, 'traced area of a 20 x 10 box');
  const bb = P.bbox(polys); near(bb.w, 20, 0.5); near(bb.h, 10, 0.5);
  // a ring: outer box minus inner box -> one polygon with a hole
  const inner = boxTris(6, 4, 5);
  const m2 = rasterizeTriangles(tris, frame);
  const m3 = rasterizeTriangles(inner, frame);
  for (let i = 0; i < m2.length; i++) if (m3[i]) m2[i] = 0;
  const ringPolys = traceMask(m2, frame);
  assert.equal(ringPolys.length, 1); assert.equal(ringPolys[0].length, 2, 'outer ring plus one hole');
  assert.ok(P.ringArea(ringPolys[0][0]) > 0 && P.ringArea(ringPolys[0][1]) < 0, 'winding: outer CCW, hole CW');
  near(P.area(ringPolys), 200 - 24, 8);
});

test('a mesh element stands on the face, keeps its size, and is carved into the stack', () => {
  const size = SIZE_BY_ID['2W-1H'];
  const design = newDesign({ mode: 'up' });
  design.handles.holes = false;
  // file is Y up: a 20 (x) x 10 (depth) x 5 (tall) box authored z-up, exported with (x, y, z) -> (x, z, -y)
  const zUp = boxTris(20, 10, 5);
  const yUp = new Float32Array(zUp.length);
  for (let i = 0; i < zUp.length; i += 3) { yUp[i] = zUp[i]; yUp[i + 1] = zUp[i + 2]; yUp[i + 2] = -zUp[i + 1]; }
  const mesh = parseStl(toBinaryStl(yUp));
  const el = newElement('mesh', { name: 'Box', data: packMesh(mesh), natural: { tris: 12 }, up: 'y', width: 40, base: 'on' });
  design.elements.push(el);
  let built = buildFace(design, size);
  const s = built.solids[0];
  near(s.z0, 2, 1e-9, 'stands on the 2 mm face');
  near(s.z1, 12, 1e-6, 'scaled x2: 10 mm tall');
  const bb = P.bbox(s.footprint); near(bb.w, 40, 0.6); near(bb.h, 20, 0.6);
  near(P.area(s.base), 800, 25, 'the whole bottom touches');
  let res = runChecks(built, design, size);
  assert.equal(res.status, 'pass', JSON.stringify(res.checks.filter(c => c.st !== 'pass').map(c => c.lbl)));
  // replaces the face: bottom on the backer and the slab removed under it
  el.base = 'in';
  built = buildFace(design, size);
  near(built.solids[0].z0, 0, 1e-9);
  const slab = built.layers.find(L => L.kind === 'slab');
  near(P.area(slab.poly), size.w * size.h - 800, 30, 'slab carved under the mesh');
  res = runChecks(built, design, size);
  assert.equal(res.status, 'pass', JSON.stringify(res.checks.filter(c => c.st !== 'pass').map(c => c.lbl)));
  // off the plate on a small size: the plate's edge cuts it (2026-11-11; it used to fail a check instead)
  el.base = 'on'; el.x = 60;
  const small = SIZE_BY_ID['1W-1H'], cutBuilt = buildFace(design, small), cut = cutBuilt.solids[0];
  assert.ok(P.bbox(cut.footprint).x1 <= small.w / 2 + 1e-6, 'cut at the plate edge');
  assert.ok(P.bbox(cut.unclipped).x1 > small.w / 2 + 1, 'what was placed is kept for the checks');
  res = runChecks(cutBuilt, design, small);
  assert.equal(res.checks.find(c => c.id === 'offplate'), undefined, 'nothing runs past the edge');
  // face down refuses it
  el.x = 0; design.mode = 'down';
  res = runChecks(buildFace(design, size), design, size);
  assert.match(res.checks.find(c => c.id === 'grip').lbl, /Meshes need Face Up/);
});

test('an undercut lip is reported as unsupported underside, a dome is not', () => {
  const size = SIZE_BY_ID['2W-1H'];
  const design = newDesign({ mode: 'up' });
  design.handles.holes = false;
  const lip = parseStl(toBinaryStl(boxTris(20, 10, 5, 6, 1)));   // 6 mm lip hanging out on +y
  const el = newElement('mesh', { name: 'Lip', data: packMesh(lip), natural: { tris: 24 }, up: 'z', width: 20 });
  design.elements.push(el);
  const body = meshBody(el);
  near(body.overhang, 90, 1, 'a flat ceiling');
  near(body.area60, 120, 2, 'the lip underside is 20 x 6');
  const res = runChecks(buildFace(design, size), design, size);
  assert.equal(res.checks.find(c => c.id === 'overhang')?.st, 'fail');
  // the design file keeps the mesh and drops a mesh without data
  const back = parseDesign(serializeDesign(design));
  assert.equal(back.elements.length, 1); assert.equal(back.elements[0].data.nt, 24);
  assert.equal(parseDesign(JSON.stringify({ elements: [{ kind: 'mesh', name: 'empty' }] })).elements.length, 0);
  // "Replaces the face" moves the bottom to the backer; the lip's ceiling is still unsupported (Sol 01a1ae8f)
  el.base = 'in';
  const res2 = runChecks(buildFace(design, size), design, size);
  assert.equal(res2.checks.find(c => c.id === 'overhang')?.st, 'fail', 'sinking the mesh does not support its lip');
});

test('review fixes: rotated meshes keep their whole footprint; a point-down shape still has a contact base', () => {
  const size = SIZE_BY_ID['2W-1H'];
  // a 40 x 40 box rotated 45 degrees: its diagonal is 56.6 mm, wider than the unrotated frame would cover
  const box = parseStl(toBinaryStl(boxTris(40, 40, 5)));
  const flat = newElement('mesh', { name: 'Flat', data: packMesh(box), natural: { tris: 12 }, up: 'z', width: 40, rotation: 0 });
  const turned = newElement('mesh', { name: 'Turned', data: packMesh(box), natural: { tris: 12 }, up: 'z', width: 40, rotation: 45 });
  near(P.area(meshBody(turned).footprint), P.area(meshBody(flat).footprint), 40, 'rotation does not clip the footprint');
  near(P.bbox(meshBody(turned).footprint).w, 40 * Math.SQRT2, 0.8, 'rotated bbox is the diagonal');
  // an inverted pyramid: apex at z = 0, no triangle lies flat on the bottom
  const apex = [0, 0, 0], a = [-10, -10, 8], b = [10, -10, 8], c = [10, 10, 8], d = [-10, 10, 8];
  const pyr = new Float32Array([...apex, ...b, ...a, ...apex, ...c, ...b, ...apex, ...d, ...c, ...apex, ...a, ...d, ...a, ...b, ...c, ...a, ...c, ...d]);
  const cone = newElement('mesh', { name: 'Cone', data: packMesh(parseStl(toBinaryStl(pyr))), natural: { tris: 6 }, up: 'z', width: 20 });
  assert.ok(P.area(meshBody(cone).base) > 1, 'a point-down shape still gets a contact base');
  const design = newDesign({ mode: 'up' });
  design.handles.holes = false;
  design.elements.push(newElement('shape', { name: 'Pocket', shape: 'circle', w: 12, op: 'cut', depth: 1 }), cone);
  const res = runChecks(buildFace(design, size), design, size);
  assert.equal(res.checks.find(c => c.id === 'gripbase')?.st, 'fail', 'the tip stands over the pocket');
});
