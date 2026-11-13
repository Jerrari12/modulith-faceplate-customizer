// Pins drawn shapes and the plate clip (2026-11-11): a path flattens within tolerance, makes a filled shape, a wall
// or a line of the right size, a taper leans its sides in at the angle and meets in a ridge where the shape is too
// narrow, and every modelled body stops at the plate's edge, closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;

const PA = await import('../js/geometry/path.js');
const { clipTrisToPlate } = await import('../js/geometry/clip.js');
const await_face = await import('../js/geometry/face.js');
const { newElement, buildFace } = await_face;
const { newDesign, parseDesign, serializeDesign } = await import('../js/export/design.js');
const { SIZE_BY_ID } = await import('../js/data/sizes.js');
const P = await import('../js/geometry/polys.js');

const mid = SIZE_BY_ID['2W-1H'];
const square = (w, h) => [{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }];
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

/** The volume of a closed, outward-wound triangle soup. */
function volume(t) {
  let v = 0;
  for (let i = 0; i < t.length; i += 9) v += (t[i] * (t[i + 4] * t[i + 8] - t[i + 5] * t[i + 7]) - t[i + 1] * (t[i + 3] * t[i + 8] - t[i + 5] * t[i + 6]) + t[i + 2] * (t[i + 3] * t[i + 7] - t[i + 4] * t[i + 6])) / 6;
  return v;
}
/**
 * Whether a soup is closed the way a slicer checks it: every edge a -> b (exact coordinates) is met by exactly one
 * b -> a, so each edge is shared by two triangles that face the same way round.
 */
function closed(t) {
  const n = new Map(), v = i => `${t[i]},${t[i + 1]},${t[i + 2]}`;
  for (let i = 0; i < t.length; i += 9) for (const [a, b] of [[0, 3], [3, 6], [6, 0]]) { const p = v(i + a), q = v(i + b); if (p === q) continue; const k = `${p}>${q}`; n.set(k, (n.get(k) || 0) + 1); }
  for (const [k, c] of n) { const [p, q] = k.split('>'); if ((n.get(`${q}>${p}`) || 0) !== c) return false; }
  return true;
}

test('a path flattens within its tolerance, and points from a file are checked', () => {
  assert.equal(PA.flattenPath(square(20, 10), true).length, 4, 'straight sides: just the corners');
  // a quarter circle as a cubic (handle 0.5523 r): every flattened point within 0.03 mm of the radius
  const r = 20, k = 0.5523 * r, arc = [{ x: r, y: 0, o: [0, k] }, { x: 0, y: r, i: [k, 0] }];
  const pts = PA.flattenPath(arc, false);
  assert.ok(pts.length > 8);
  for (const [x, y] of pts) near(Math.hypot(x, y), r, 0.03, 'on the arc');
  assert.deepEqual(PA.cleanPoints([{ x: 1, y: '2', i: [0, 0], o: [3, 'x'] }, { x: NaN, y: 1 }, 'junk', { x: 9999, y: -1, o: [1, 1] }]),
    [{ x: 1, y: 2 }, { x: 400, y: -1, o: [1, 1] }], 'numbers only, inside the limits; a zero handle is no handle');
  assert.equal(PA.cleanPoints(Array.from({ length: 300 }, (_, i) => ({ x: i, y: 0 }))).length, PA.PATH_LIMITS.maxPoints);
});

test('filled, wall and line outlines come out the size they are drawn', () => {
  const el = newElement('path', { pts: square(20, 10) });
  near(P.area(PA.pathOutline(el)), 200, 0.01, 'filled');
  // a figure of eight crosses itself: both lobes fill (the nonzero rule)
  const eight = newElement('path', { pts: [{ x: -10, y: -5 }, { x: 10, y: 5 }, { x: 10, y: -5 }, { x: -10, y: 5 }] });
  near(P.area(PA.pathOutline(eight)), 100, 0.5, 'figure of eight');
  const wall = newElement('path', { pts: square(20, 20), form: 'wall', thick: 2 });
  near(P.area(PA.pathOutline(wall)), 400 - 16 * 16, 1.5, 'a 2 mm wall inside a 20 mm square');
  const line = newElement('path', { pts: [{ x: 0, y: 0 }, { x: 20, y: 0 }], form: 'line', thick: 2 });
  near(P.area(PA.pathOutline(line)), 40 + Math.PI, 0.3, 'round ends');
  near(P.area(PA.pathOutline({ ...line, ends: 'flat' })), 40, 0.3, 'flat ends');
  assert.deepEqual(PA.pathOutline(newElement('path', { pts: square(4, 4).slice(0, 2) })), [], 'two points make no shape');
  // a flat end cuts only its own end: a later part of the line passing close by keeps its full width (Sol 01a1cc6f)
  const hook = PA.strokeLine([[0, 0], [10, 0], [10, 10], [-1, 10], [-1, -10]], 2, 'flat');
  assert.ok(P.contains(hook, -0.1, 0) && P.contains(hook, -0.5, 0) && P.contains(hook, -1.9, 0), 'the passing line is whole beside the start');
  assert.ok(!P.contains(hook, 0.3, -12) && P.contains(hook, -1, -9.7), 'the far end is cut square');
  const tight = PA.strokeLine([[0, 0], [1, 0], [1, 2], [-2, 2], [-2, 10]], 2, 'flat');
  assert.ok(P.contains(tight, -0.5, 2), 'a tight hook back across the start keeps its width');
  assert.ok(!P.contains(tight, -0.5, 0), 'and the start is still cut square');
  // a real join right by the start keeps its round outside (Sol 01a1cc6f, third turn)
  assert.ok(P.contains(PA.strokeLine([[0, 0], [0.2, 0], [0.2, 0.2], [0, 0.2], [0, -10]], 2, 'flat'), -0.4, 0.6), 'the join by the start is whole');
  // a straight run in many pieces is one band with no seams; a sharp zigzag is one piece with no holes
  const run = PA.strokeLine(Array.from({ length: 41 }, (_, i) => [i * 0.5, 0]), 2, 'flat');
  assert.equal(run.length, 1); assert.equal(run[0].length, 1, 'no pinholes along the seams'); near(P.area(run), 40, 0.05, 'the run');
  const zig = PA.strokeLine([[0, 0], [10, 0], [0, 3], [10, 6]], 1.5, 'round');
  assert.equal(zig.length, 1); assert.equal(zig[0].length, 1, 'no holes at the sharp joins');
  assert.ok(!P.contains(PA.strokeLine([[0, 0], [0.01, 0], [0.02, 0]], 2, 'flat'), -0.04, 0), 'a join never reaches past a square end');
  // a flat-ended curve: a quarter of a 20 mm circle, 2 mm wide, is a quarter of an annulus
  const k = 0.5523 * 20, arcLine = PA.flattenPath([{ x: 20, y: 0, o: [0, k] }, { x: 0, y: 20, i: [k, 0] }], false);
  near(P.area(PA.strokeLine(arcLine, 2, 'flat')), Math.PI / 4 * (21 * 21 - 19 * 19), 0.3, 'a quarter annulus');
});

test('a huge curve still flattens within tolerance, and a drawing is open or closed on every size alike', async () => {
  const V = await import('../js/variants.js');
  const big = [{ x: -400, y: 0, o: [0, 400] }, { x: 400, y: 0, i: [0, 400] }];
  const line = PA.flattenPath(big, false, 0.02);
  // the true curve sampled densely: every one of its points within tolerance of the polyline
  const seg = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)); return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t); };
  let worst = 0;
  for (let s = 0; s <= 2000; s++) {
    const t = s / 2000, u = 1 - t, q = [u * u * u * -400 + 3 * u * u * t * -400 + 3 * u * t * t * 400 + t * t * t * 400, 3 * u * u * t * 400 + 3 * u * t * t * 400];
    let d = Infinity; for (let k = 0; k + 1 < line.length; k++) d = Math.min(d, seg(q, line[k], line[k + 1]));
    worst = Math.max(worst, d);
  }
  assert.ok(worst <= 0.021, `within 0.02 mm: ${worst}`);
  assert.equal(V.canOverride(newElement('path'), 'form'), false, 'open or closed is the drawing\'s own, like its points');
  assert.equal(V.canOverride(newElement('path'), 'thick'), true);
});

test('a taper leans the sides in at its angle, and narrow parts meet in a ridge', () => {
  const sq = P.rect(-10, -10, 10, 10);
  // 20 mm square, 5 mm up at 45°: a frustum with a 10 mm top
  const b = PA.taperBody(sq, sq, { z0: 2, height: 5, angle: 45 });
  near(b.z1, 7, 1e-6, 'full height'); assert.ok(closed(b.tris), 'closed');
  near(volume(b.tris), (5 / 3) * (400 + 100 + 200), 12, 'frustum volume');
  // a 4 mm wide bar 10 mm up at 45°: the sides meet 2 mm up, along its middle
  const bar = P.rect(-15, -2, 15, 2), r = PA.taperBody(bar, bar, { z0: 0, height: 10, angle: 45 });
  near(r.z1, 2, 0.05, 'a ridge where the sides meet');
});

test('a chamfered or rounded top edge, on a straight or a tapered side', () => {
  // straight sides, 5 mm tall, a 1 mm edge: it starts at 4 mm on the drawn edge and is flat 1 mm in
  const ch = PA.sideProfile({ height: 5, angle: 0, edge: 'chamfer', size: 1 });
  near(ch.at(0), 4, 1e-9, 'chamfer at the edge'); near(ch.at(0.5), 4.5, 1e-9); near(ch.at(1), 5, 1e-9); near(ch.reach, 1, 1e-9);
  const rd = PA.sideProfile({ height: 5, angle: 0, edge: 'round', size: 1 });
  near(rd.at(0), 4, 1e-9, 'round at the edge'); near(rd.at(0.5), 4 + Math.sqrt(0.75), 1e-9); near(rd.at(1), 5, 1e-9);
  // a round on a tapered side touches the wall where it leaves it, and only climbs
  const tr = PA.sideProfile({ height: 8, angle: 20, edge: 'round', size: 2 }), wall = d => d / Math.tan(20 * Math.PI / 180);
  let prev = -1;
  for (let d = 0; d <= tr.reach + 1; d += 0.01) { const z = tr.at(d); assert.ok(z >= prev - 1e-9 && z <= wall(d) + 1e-9 && z <= 8 + 1e-9, `climbs, under the wall, at ${d}`); prev = z; }
  near(tr.at(tr.reach), 8, 1e-9, 'flat at the top');
  // a side leaning past 45° has nothing for a chamfer to cut
  const steep = PA.sideProfile({ height: 6, angle: 50, edge: 'chamfer', size: 2 }), plain = PA.sideProfile({ height: 6, angle: 50 });
  for (let d = 0; d < 8; d += 0.1) near(steep.at(d), plain.at(d), 1e-9, 'no change past 45°');
  // the bodies: a 20 mm square 5 mm tall, square sides, a 1 mm chamfer or round, against the volume integrated exactly
  const sq = P.rect(-10, -10, 10, 10);
  const integrate = inset => { let v = 0; const n = 2000; for (let k = 0; k < n; k++) { const y = (k + 0.5) / n; v += (20 - 2 * inset(y)) ** 2 / n; } return 400 * 4 + v; };
  const bc = PA.taperBody(sq, sq, { z0: 0, height: 5, angle: 0, edge: 'chamfer', size: 1 });
  assert.ok(closed(bc.tris), 'chamfered body closed'); near(bc.z1, 5, 1e-6);
  near(volume(bc.tris), integrate(y => y), 6, 'chamfered volume');
  const br = PA.taperBody(sq, sq, { z0: 0, height: 5, angle: 0, edge: 'round', size: 1 });
  assert.ok(closed(br.tris), 'rounded body closed');
  near(volume(br.tris), integrate(y => 1 - Math.sqrt(1 - y * y)), 6, 'rounded volume');
  // a shaped top edge alone makes a drawing a body; square and no taper stays flat relief
  const { isShapedBody } = await_face;
  assert.equal(isShapedBody(newElement('path', { op: 'raise', edge: 'round', edgeSize: 1 })), true);
  assert.equal(isShapedBody(newElement('path', { op: 'raise', edge: 'square' })), false);
  assert.equal(isShapedBody(newElement('path', { op: 'inlay', edge: 'round', taper: 10 })), false, 'only a raise');
});

test('a drawing past the plate edge is cut there; a tapered one is a body that stops at the edge', () => {
  const W = mid.w, H = mid.h;
  const flat = newElement('path', { pts: square(40, 20), x: W / 2, op: 'raise', height: 2 });
  const d = newDesign({ elements: [flat] }); d.handles.mount = 'none'; d.handles.holes = false; d.mode = 'up';
  let built = buildFace(d, mid);
  const L = built.layers.find(l => l.elementId === flat.id);
  near(P.bbox(L.poly).x1, W / 2, 1e-6, 'relief cut at the edge');
  flat.taper = 30;
  built = buildFace(d, mid);
  const s = built.solids.find(g => g.elementId === flat.id);
  assert.equal(s.kind, 'shaped');
  assert.ok(P.bbox(s.footprint).x1 <= W / 2 + 1e-6, 'the body stops at the edge');
  let xmax = -Infinity; for (let i = 0; i < s.tris.length; i += 3) xmax = Math.max(xmax, s.tris[i]);
  assert.ok(xmax <= W / 2 + 1e-4, 'no triangle past the edge');
  assert.ok(closed(s.tris), 'closed');
  near(s.z1 - built.t, 2, 1e-6, 'its height');
  assert.ok(built.drawn.find(r => r.id === flat.id).full.length, 'what was drawn is kept for the checks');
});

test('blocks and meshes are cut at the plate edge and stay closed', () => {
  const W = mid.w, H = mid.h;
  const box = newElement('solid', { shape: 'box', w: 20, h: 20, out: 10, edge: 'square', corner: 0, x: W / 2, y: H / 2 });
  const d = newDesign({ elements: [box] }); d.handles.mount = 'none'; d.handles.holes = false; d.mode = 'up';
  const built = buildFace(d, mid);
  const s = built.solids.find(g => g.elementId === box.id);
  const b = P.bbox(s.footprint);
  assert.ok(b.x1 <= W / 2 + 1e-6 && b.y1 <= H / 2 + 1e-6, 'the footprint stops at the edges');
  assert.ok(closed(s.tris), 'closed after two cuts');
  near(volume(s.tris), 10 * 10 * 10, 1, 'a quarter of the box is left');
  near(P.area(s.unclipped), 400, 1e-6, 'the whole footprint is kept for the checks');
  // a chamfered cylinder over a corner (two cuts through curved, sloped sides) and a grip past the end
  const cyl = newElement('solid', { shape: 'cylinder', w: 24, h: 24, out: 8, edge: 'chamfer', x: -W / 2 + 4, y: -H / 2 + 5 });
  const grip = newElement('grip', { style: 'wedge', length: 60, x: W / 2 - 10 });
  const d2 = newDesign({ elements: [cyl, grip] }); d2.handles.mount = 'none'; d2.handles.holes = false; d2.mode = 'up';
  const b2 = buildFace(d2, mid);
  for (const e of [cyl, grip]) {
    const g = b2.solids.find(x => x.elementId === e.id), bb = P.bbox(g.footprint);
    assert.ok(g.unclipped, `${e.kind} was cut`);
    assert.ok(bb.x0 >= -W / 2 - 1e-6 && bb.x1 <= W / 2 + 1e-6 && bb.y0 >= -H / 2 - 1e-6, `${e.kind} inside the plate`);
    assert.ok(closed(g.tris), `${e.kind} closed after the cut`);
  }
  // a block wholly past the edge is gone from the plate, said in a note, and kept as drawn for the checks
  const away = newElement('solid', { shape: 'box', w: 10, h: 10, out: 5, x: W / 2 + 20 });
  const d3 = newDesign({ elements: [away] }); d3.handles.mount = 'none'; d3.handles.holes = false; d3.mode = 'up';
  const b3 = buildFace(d3, mid);
  assert.equal(b3.solids.length, 0, 'nothing of it is built');
  assert.ok(b3.notes.some(n => n.elementId === away.id && /outside this plate/.test(n.text)));
  assert.ok(b3.drawn.find(r => r.id === away.id).full.length, 'what was placed is kept for the checks');
  // a body inside the plate is the same object, untouched
  const t = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.equal(clipTrisToPlate(t, 10, 10), t);
  // a cut that cannot close (an open soup) is refused, and the body is left whole
  assert.equal(clipTrisToPlate(new Float32Array([0, 0, 0, 10, 0, 0, 0, 1, 1]), 10, 10), null);
});

test('the design file keeps a drawing and drops one with too few points', () => {
  const el = newElement('path', { pts: [{ x: 0, y: 0, o: [2, 0] }, { x: 10, y: 0, i: [-2, 1] }, { x: 5, y: 8 }], form: 'wall', thick: 1.2, taper: 12, op: 'raise' });
  const back = parseDesign(serializeDesign(newDesign({ elements: [el] }))).elements[0];
  assert.deepEqual(back.pts, el.pts); assert.equal(back.form, 'wall'); assert.equal(back.taper, 12);
  const junk = parseDesign({ elements: [{ kind: 'path', pts: [{ x: 1, y: 1 }] }, { kind: 'path', pts: 'nope' }, { kind: 'path', pts: [{ x: 0, y: 0 }, { x: 5, y: 'a' }, { x: 5, y: 5 }] }] });
  assert.equal(junk.elements.length, 1, 'only the drawing with two good points stays');
  assert.deepEqual(junk.elements[0].pts, [{ x: 0, y: 0 }, { x: 5, y: 5 }]);
});
