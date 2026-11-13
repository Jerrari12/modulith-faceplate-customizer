// The series' EdgeLabel grip, rebuilt: a closed corner hood with the shipped planes (the slice areas below are the
// comparison tool's readings of the shipped Faceplate_EdgeLabel_1W-1H grip above its band), in the top-right corner
// on every size with a second hood 176 mm along on 3W and 4W, mirrorable to the top left, sturdy and clean to print.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;

const P = await import('../js/geometry/polys.js');
const { cornerHood, CORNER_HOOD } = await import('../js/geometry/cornerhood.js');
const { gripShape, styleStart, GRIP_STRENGTH } = await import('../js/geometry/grips.js');
const { buildFace, newElement } = await import('../js/geometry/face.js');
const { runChecks } = await import('../js/checks/checks.js');
const { newDesign, serializeDesign, parseDesign } = await import('../js/export/design.js');
const { SIZES, SIZE_BY_ID } = await import('../js/data/sizes.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);
function closedness(t) {
  const key = i => `${(t[i] + 0).toFixed(5)},${(t[i + 1] + 0).toFixed(5)},${(t[i + 2] + 0).toFixed(5)}`, edges = new Map();
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
/** The plan area of a body's horizontal slice at height z (cut segments chained into loops by distance). */
function planArea(tris, z) {
  const segs = [];
  for (let i = 0; i < tris.length; i += 9) {
    const P3 = [0, 3, 6].map(o => [tris[i + o], tris[i + o + 1], tris[i + o + 2]]), d = P3.map(p => p[2] - z), c = [];
    for (let e = 0; e < 3; e++) { const p = P3[e], q = P3[(e + 1) % 3]; if ((d[e] < 0 && d[(e + 1) % 3] > 0) || (d[e] > 0 && d[(e + 1) % 3] < 0)) { const f = d[e] / (d[e] - d[(e + 1) % 3]); c.push([p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f]); } }
    if (c.length === 2) segs.push(c);
  }
  const used = new Set();
  let mp = [];
  for (let i = 0; i < segs.length; i++) {
    if (used.has(i)) continue;
    used.add(i); const line = [segs[i][0], segs[i][1]];
    for (;;) {
      const end = line[line.length - 1]; let next = -1, flip = false;
      for (let j = 0; j < segs.length && next < 0; j++) if (!used.has(j)) for (const k of [0, 1]) if (Math.hypot(segs[j][k][0] - end[0], segs[j][k][1] - end[1]) < 1e-6) { next = j; flip = k === 1; break; }
      if (next < 0) break;
      used.add(next); line.push(segs[next][flip ? 0 : 1]);
    }
    if (line.length > 3) mp = mp.length ? P.xor(mp, [[line]]) : [[line]];
  }
  return P.area(mp);
}
const design = (...els) => { const d = newDesign({ mode: 'up', elements: els }); d.handles.mount = 'none'; d.handles.holes = false; return d; };

test('the EdgeLabel hood is closed, 17.6 mm proud, and matches the shipped slices', () => {
  const g = cornerHood();
  const { unpaired, vol } = closedness(g.tris);
  assert.equal(unpaired, 0, 'closed');
  assert.ok(vol > 0, 'outward');
  near(g.height, 17.6, 1e-9, 'height above the face');
  // the plan: a diagonal band from 27 mm down the face up to the top edge, its front cut on the corner's diagonal
  const fp = g.footprint[0][0];
  for (const [x, y] of [[-52.81, -27], [-27, -27], [0, 0], [-25.81, 0]]) assert.ok(fp.some(([a, b]) => Math.hypot(a - x, b - y) < 0.01), `footprint corner ${x}, ${y}`);
  // shipped 1W-1H grip above the band (the comparison tool): 137.8 mm2 at 4 mm, 105.8 at 8, 73.9 at 12
  for (const [h, shipped] of [[4, 137.8], [8, 105.8], [12, 73.9]]) near(planArea(g.tris, h), shipped, 1.0, `slice at ${h} mm`);
  // the base is the two blades' feet (an L): not the pocket under them
  assert.ok(P.contains(g.base, -40, -27 + 1) === false, 'pocket floor is not base');
  assert.ok(P.contains(g.base, -46, -24), 'diagonal blade foot');
  assert.ok(P.contains(g.base, -12, -1), 'top blade foot');
});

test('on every size it sits in the top-right corner, with a second hood 176 mm along on 3W and 4W', () => {
  const grip = newElement('grip', { style: 'edgelabel', ...styleStart({}, 'edgelabel') });
  const d = design(grip);
  for (const size of SIZES) {
    const b = buildFace(d, size), hoods = b.solids.filter(s => s.elementId === grip.id);
    assert.equal(hoods.length, size.w > 176 ? 2 : 1, `${size.id}: ${hoods.length} hoods`);
    for (const [k, s] of hoods.entries()) {
      const bb = P.bbox(s.footprint);
      near(bb.x1, size.w / 2 - k * CORNER_HOOD.pitch, 1e-6, `${size.id} hood ${k}: right end`);
      near(bb.y1, size.h / 2, 1e-6, `${size.id} hood ${k}: on the top edge`);
      near(s.z1 - s.z0, 17.6, 1e-9, `${size.id}: proud`);
      assert.equal(closedness(s.tris).unpaired, 0, `${size.id} hood ${k}: closed`);
    }
    const res = runChecks(b, d, size);
    assert.ok(!res.checks.some(c => c.st === 'fail'), `${size.id}: ${res.checks.filter(c => c.st === 'fail').map(c => c.lbl).join(', ')}`);
  }
  // the top-left corner mirrors it; one hood only when asked
  Object.assign(grip, { corner: 'left', pairs: false });
  const size = SIZE_BY_ID['4W-1H'], [only, ...rest] = buildFace(d, size).solids.filter(s => s.elementId === grip.id);
  assert.equal(rest.length, 0, 'one hood');
  near(P.bbox(only.footprint).x0, -size.w / 2, 1e-6, 'in the top-left corner');
  const m = closedness(only.tris);
  assert.equal(m.unpaired, 0, 'mirrored hood closed');
  assert.ok(m.vol > 0, 'and still outward');
});

test('sturdy, keeps relief in its pocket, and the corner and pairing survive a save', () => {
  const grip = newElement('grip', { style: 'edgelabel', ...styleStart({}, 'edgelabel') });
  const st = gripShape(grip).strength;
  assert.ok(st.sigma < GRIP_STRENGTH.warnMPa, `about ${st.sigma.toFixed(2)} MPa`);
  const ribs = newElement('pattern', { pattern: 'stripes', op: 'raise', height: 2, color: 'c2', params: { pitch: 7, width: 3, angle: 90, phaseY: 3.5 } });
  const d = design(ribs, grip), size = SIZE_BY_ID['2W-1H'], b = buildFace(d, size);
  const hood = b.solids.find(s => s.elementId === grip.id);
  const raised = P.union(...b.layers.filter(L => L.elementId === ribs.id).map(L => L.poly));
  assert.ok(P.area(P.intersection(raised, hood.footprint)) > 50, 'ribs in the pocket');
  for (const L of b.layers.filter(L => L.elementId === ribs.id)) assert.ok(P.area(P.intersection(L.poly, hood.occupies(L.z0, L.z1))) < 1e-6, 'none inside the hood');
  grip.corner = 'left';
  const back = parseDesign(serializeDesign(d)).elements.find(e => e.id === grip.id);
  for (const k of ['style', 'corner', 'pairs']) assert.equal(back[k], grip[k], k);
});
