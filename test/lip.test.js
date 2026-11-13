// The lip pull and flush-with-an-edge placement: closed bodies, the flush side exactly on the plate's edge on every
// size, the undercut toward the plate, a clean bill from the checks, and both surviving a save and load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;

const P = await import('../js/geometry/polys.js');
const { gripShape, LIP_PRESET } = await import('../js/geometry/grips.js');
const lipShape = el => gripShape({ ...el, style: 'lip' });
const { buildFace, newElement, elementCentre } = await import('../js/geometry/face.js');
const { runChecks } = await import('../js/checks/checks.js');
const { newDesign, serializeDesign, parseDesign } = await import('../js/export/design.js');
const { SIZES, SIZE_BY_ID } = await import('../js/data/sizes.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);

/** Every directed edge used once and its reverse once (closed, consistently wound), and the signed volume. */
function closedness(t) {
  const key = i => `${t[i].toFixed(5)},${t[i + 1].toFixed(5)},${t[i + 2].toFixed(5)}`;
  const edges = new Map();
  let vol = 0;
  for (let i = 0; i < t.length; i += 9) {
    const a = key(i), b = key(i + 3), c = key(i + 6);
    for (const [p, q] of [[a, b], [b, c], [c, a]]) edges.set(`${p}>${q}`, (edges.get(`${p}>${q}`) || 0) + 1);
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = [t[i], t[i + 1], t[i + 2], t[i + 3], t[i + 4], t[i + 5], t[i + 6], t[i + 7], t[i + 8]];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  let unpaired = 0;
  for (const [k, n] of edges) { const [p, q] = k.split('>'); if (n !== 1 || edges.get(`${q}>${p}`) !== 1) unpaired++; }
  return { unpaired, vol };
}
const yRange = t => { let lo = Infinity, hi = -Infinity; for (let i = 1; i < t.length; i += 3) { lo = Math.min(lo, t[i]); hi = Math.max(hi, t[i]); } return [lo, hi]; };
const lipDesign = (extra = {}) => {
  const lip = newElement('grip', { ...LIP_PRESET, ...extra });
  const d = newDesign({ mode: 'up', elements: [lip] });
  d.handles.mount = 'none'; d.handles.holes = false;
  return { d, lip };
};

test('a lip pull is a closed, outward body for every end and undercut, its overhang the undercut slope', () => {
  for (const ends of ['angled', 'round', 'square']) for (const undercut of [0, 3, 6.5, 12]) {
    const s = lipShape({ ...LIP_PRESET, ends, undercut });
    const { unpaired, vol } = closedness(s.tris);
    assert.equal(unpaired, 0, `${ends}, undercut ${undercut}: closed`);
    assert.ok(vol > 0, `${ends}, undercut ${undercut}: outward`);
    near(s.overhang, undercut ? Math.atan2(Math.min(undercut, 15), 10 - 3) * 180 / Math.PI : 0, 1e-9, 'overhang angle');
  }
  // square ends, measured: 70 mm long, a 16 x 10 section less the 6.5 x 7 pocket
  near(closedness(lipShape({ ...LIP_PRESET, ends: 'square', chamfer: 0 }).tris).vol, 70 * (16 * 10 - 6.5 * 7 / 2), 1e-6, 'volume');
  near(closedness(lipShape({ ...LIP_PRESET, ends: 'square' }).tris).vol, 70 * (16 * 10 - 6.5 * 7 / 2 - 1 / 2), 1e-6, 'volume less the 1 mm chamfer on the lip');
  // the ends come in toward the lip's edge: shorter there by the taper at each end
  const b = P.bbox(lipShape(LIP_PRESET).footprint);
  near(b.x1 - b.x0, 70, 1e-9, 'flush side full length');
  const edgeRow = lipShape(LIP_PRESET).footprint[0][0].filter(([, y]) => Math.abs(y + 8) < 1e-9).map(([x]) => x);
  near(Math.max(...edgeRow) - Math.min(...edgeRow), 70 - 16, 1e-9, 'lip edge shorter by twice the taper');
});

test('flush with the top edge on every size: the flush side on the plate edge, the pocket toward the plate', () => {
  const { d, lip } = lipDesign();
  for (const size of SIZES) {
    const s = buildFace(d, size).solids.find(x => x.elementId === lip.id);
    near(yRange(s.tris)[1], size.h / 2, 1e-4, `${size.id}: top of the body`);
    near(P.bbox(s.footprint).y1, size.h / 2, 1e-9, `${size.id}: footprint`);
    assert.ok(P.bbox(s.base).y0 > P.bbox(s.footprint).y0 + 1, `${size.id}: the base stops short of the lip's edge`);
    assert.equal(closedness(s.tris).unpaired, 0, `${size.id}: closed`);
  }
  // the bottom edge: turned over, so the pocket faces up into the plate
  lip.flush = 'b';
  const size = SIZE_BY_ID['2W-1H'];
  const s = buildFace(d, size).solids.find(x => x.elementId === lip.id);
  near(yRange(s.tris)[0], -size.h / 2, 1e-4, 'bottom of the body');
  assert.ok(P.bbox(s.base).y1 < P.bbox(s.footprint).y1 - 1, 'the pocket opens toward the plate');
  // Offset X slides it along; the old anchor and Offset Y no longer apply
  Object.assign(lip, { flush: 't', x: 25, y: -40, anchor: 'bl', rotation: 33 });
  const moved = buildFace(d, size).solids.find(x => x.elementId === lip.id);
  near(P.bbox(moved.footprint).y1, size.h / 2, 1e-9, 'still on the top edge');
  near((P.bbox(moved.footprint).x0 + P.bbox(moved.footprint).x1) / 2, 25, 1e-9, 'slid along by Offset X');
});

test('a block and a shape sit flush with the top edge too, turned or not', () => {
  const block = newElement('solid', { shape: 'box', w: 40, h: 12, out: 4, rotation: 30, flush: 't' });
  const shape = newElement('shape', { shape: 'roundrect', w: 60, h: 8, op: 'raise', height: 2, flush: 'b', x: 20 });
  const d = newDesign({ mode: 'up', elements: [block, shape] }); d.handles.mount = 'none'; d.handles.holes = false;
  for (const id of ['1W-1H', '2W-1H', '3W-2H', '1W-05H']) {
    const size = SIZE_BY_ID[id], b = buildFace(d, size);
    near(P.bbox(b.solids.find(x => x.elementId === block.id).footprint).y1, size.h / 2, 1e-6, `${id}: block on the top edge`);
    const layer = b.layers.find(L => L.elementId === shape.id);
    near(P.bbox(layer.poly).y0, -size.h / 2, 1e-6, `${id}: shape on the bottom edge`);
    near(elementCentre(shape, size.w, size.h)[0], 20, 1e-9, `${id}: shape slid along`);
  }
});

test('the lip pull as added from the library prints clean, and survives a save and load', () => {
  const { d, lip } = lipDesign();
  for (const id of SIZES.map(s => s.id)) {
    const size = SIZE_BY_ID[id], res = runChecks(buildFace(d, size), d, size);
    assert.equal(res.status, 'pass', `${id}: ${res.checks.filter(c => c.st !== 'pass').map(c => c.lbl).join(', ')}`);
  }
  // a steeper pocket than 45 degrees is called out
  lip.undercut = 12;
  const steep = runChecks(buildFace(d, SIZE_BY_ID['2W-1H']), d, SIZE_BY_ID['2W-1H']);
  assert.ok(steep.checks.some(c => c.id === 'overhang' && c.st !== 'pass'), 'steep undercut flagged');
  lip.undercut = 6.5;
  const back = parseDesign(serializeDesign(d));
  const g = back.elements.find(e => e.kind === 'grip');
  for (const k of ['style', 'flush', 'ends', 'endTaper', 'lipEdge', 'undercut', 'depth', 'height', 'length']) assert.equal(g[k], lip[k], k);
  // a symmetric pair: the twin of an offset lip is mirrored and on the edge too
  d.symmetry = 'x'; lip.x = 40; lip.length = 40;
  const size = SIZE_BY_ID['3W-1H'] || SIZE_BY_ID['2W-1H'];
  const pair = buildFace(d, size).solids.filter(x => x.elementId === lip.id);
  assert.equal(pair.length, 2, 'original and twin');
  for (const s of pair) { near(P.bbox(s.footprint).y1, size.h / 2, 1e-9, 'twin on the edge'); assert.equal(closedness(s.tris).unpaired, 0, 'twin closed'); }
});

test('Sol 01a1b3a8: a vanishing undercut is none, and a curve step near the undercut never moves its start', () => {
  // an undercut of 5e-7 mm used to lose its starting level, sloping the whole underside at 66 degrees while
  // reporting 0 and leaving no base: now it is flat underneath with the full base on the face
  const tiny = lipShape({ ...LIP_PRESET, ends: 'square', undercut: 5e-7, chamfer: 0 });
  assert.equal(tiny.overhang, 0);
  let zLow = Infinity; for (let i = 2; i < tiny.tris.length; i += 3) if (tiny.tris[i] > 1e-9) zLow = Math.min(zLow, tiny.tris[i]);
  near(zLow, 10, 1e-9, 'nothing between the face and the outer face: the underside is flat on the face');
  near(P.area(tiny.base), P.area(tiny.footprint), 1e-6, 'the whole footprint touches the face');
  // rounded ends step every 16/24 mm; an undercut that starts 1e-7 mm past a step keeps its own level
  const uc = 16 / 24 + 1e-7, ub = 8 - (16 - uc);
  for (const undercut of [uc, 16 / 24 - 1e-7, 6.5]) {
    const s = lipShape({ ...LIP_PRESET, ends: 'round', undercut });
    near(P.bbox(s.base).y0, 8 - (16 - undercut), 1e-9, `undercut ${undercut}: the base starts where the undercut does`);
    assert.equal(closedness(s.tris).unpaired, 0, `undercut ${undercut}: closed`);
    near(s.overhang, Math.atan2(undercut, 7) * 180 / Math.PI, 1e-9, `undercut ${undercut}: overhang`);
  }
  assert.ok(ub < -7, 'the probe sits near the first step');
});
