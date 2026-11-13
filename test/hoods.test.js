// The series' Classic Pro and Classic grips, rebuilt: closed on every size, the shipped dimensions (checked against
// the shipped models by tools/compare-shipped-grips.mjs; the cross-section areas below are that tool's readings of
// the shipped Faceplate_ClassicPro_1W-1H and Faceplate_ClassicDecor_1W-1H), relief kept in the finger pocket, the
// accent strip in its own colour, and clean checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;

const P = await import('../js/geometry/polys.js');
const { gripShape, styleStart, GRIP_STRENGTH } = await import('../js/geometry/grips.js');
const { hoodShape } = await import('../js/geometry/hoods.js');
const { buildFace, newElement } = await import('../js/geometry/face.js');
const { runChecks } = await import('../js/checks/checks.js');
const { newDesign, serializeDesign, parseDesign } = await import('../js/export/design.js');
const { SIZES, SIZE_BY_ID } = await import('../js/data/sizes.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);
function closedness(t) {
  const key = i => `${t[i].toFixed(5)},${t[i + 1].toFixed(5)},${t[i + 2].toFixed(5)}`, edges = new Map();
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
/** The area of a body's cross-section at x: the cut segments chained into loops (by distance), even-odd. */
function sectionArea(tris, x) {
  const segs = [];
  for (let i = 0; i < tris.length; i += 9) {
    const P3 = [0, 3, 6].map(o => [tris[i + o], tris[i + o + 1], tris[i + o + 2]]), d = P3.map(p => p[0] - x), c = [];
    for (let e = 0; e < 3; e++) { const p = P3[e], q = P3[(e + 1) % 3], dp = d[e], dq = d[(e + 1) % 3]; if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) { const f = dp / (dp - dq); c.push([p[1] + (q[1] - p[1]) * f, p[2] + (q[2] - p[2]) * f]); } }
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

test('Classic Pro and Classic are closed on every size, full width along the top edge, 27 mm down and 23 mm proud', () => {
  for (const style of ['classicpro', 'classic']) {
    const grip = newElement('grip', { style, ...styleStart({}, style) });
    const d = design(grip);
    for (const size of SIZES) {
      const b = buildFace(d, size), [body, accent] = b.solids.filter(s => s.elementId === grip.id);
      assert.equal(closedness(body.tris).unpaired, 0, `${style} ${size.id}: closed`);
      assert.ok(closedness(body.tris).vol > 0, `${style} ${size.id}: outward`);
      assert.equal(closedness(accent.tris).unpaired, 0, `${style} ${size.id}: accent closed`);
      const fp = P.bbox(body.footprint);
      near(fp.y1, size.h / 2, 1e-9, `${style} ${size.id}: flush with the top edge`);
      near(fp.y1 - fp.y0, 27, 1e-9, `${style} ${size.id}: 27 mm down the face`);
      near(fp.x1 - fp.x0, size.w, 1e-9, `${style} ${size.id}: the full width`);
      near(body.z1 - body.z0, 23, 1e-9, `${style} ${size.id}: 23 mm proud`);
      near(P.bbox(body.top).w, size.w - 46, 1e-9, `${style} ${size.id}: the ends lean in at 45 degrees`);
      assert.ok(P.area(P.difference(accent.footprint, body.footprint)) < 1e-9, `${style} ${size.id}: the strip sits in the bar`);
      const res = runChecks(b, d, size);
      assert.ok(!res.checks.some(c => c.st === 'fail'), `${style} ${size.id}: ${res.checks.filter(c => c.st === 'fail').map(c => c.lbl).join(', ')}`);
    }
  }
});

test('the rebuilt sections match the shipped models (the comparison tool\'s readings)', () => {
  // shipped 1W-1H mid-section areas in front of the face: Classic Pro 88.0 mm2, Classic 76.6 mm2 (with the accent
  // strip); the rebuild drops the shipped parts' small edge breaks, so it may read up to 1 mm2 under
  const pro = hoodShape({ style: 'classicpro' }, 87), cls = hoodShape({ style: 'classic' }, 87);
  near(sectionArea([...pro.tris, ...pro.accent.tris], 0.37), 88.0, 1.0, 'Classic Pro mid-section');
  near(sectionArea([...cls.tris, ...cls.accent.tris], 0.37), 76.6, 1.0, 'Classic mid-section');
  // Classic Pro's recessed panel: 46.4 mm long on every width, the slot 21.2 mm in from each end
  for (const W of [87, 175, 351]) near(P.bbox(hoodShape({ style: 'classicpro' }, W).accent.footprint).w, W - 42.4, 1e-9, `${W}: accent strip length`);
  // the recess (a 41.17 mm2 parallelogram in section) is in the middle 46.4 mm only, on every width wide enough to
  // show a full section either side of it
  for (const W of [175, 351]) {
    const g = hoodShape({ style: 'classicpro' }, W);
    near(sectionArea(g.tris, 10) - sectionArea(g.tris, 40), -41.17, 0.05, `${W}: recessed at x = 10, not at x = 40`);
    near(sectionArea(g.tris, 22) - sectionArea(g.tris, 24), -41.17, 0.05, `${W}: its end at 23.2 mm`);
  }
  // the shortest hood still closes; anything asked shorter is held at that length
  const short = gripShape({ style: 'classicpro', length: 20 });
  assert.equal(closedness(short.tris).unpaired, 0, 'shortest hood closed');
  near(P.bbox(short.footprint).w, 56, 1e-9, 'held at 56 mm');
  // with the strip switched off, the bar is whole: the body's volume is the slotted body plus the strip
  const solid = hoodShape({ style: 'classicpro', accentStrip: false }, 175), slotted = hoodShape({ style: 'classicpro' }, 175);
  assert.equal(solid.accent, null);
  near(closedness(solid.tris).vol, closedness(slotted.tris).vol + closedness(slotted.accent.tris).vol, 1e-6, 'volumes add up');
});

test('relief keeps going in the finger pocket; the strip prints in its own colour; settings survive a save', () => {
  const ribs = newElement('pattern', { pattern: 'stripes', op: 'raise', height: 2, color: 'c2', params: { pitch: 7, width: 3, angle: 90, phaseY: 3.5 } });
  const grip = newElement('grip', { style: 'classicpro', ...styleStart({}, 'classicpro'), color: 'c1', accentColor: 'c3' });
  const d = design(ribs, grip), size = SIZE_BY_ID['2W-1H'], b = buildFace(d, size);
  const [body, accent] = b.solids.filter(s => s.elementId === grip.id);
  const raised = P.union(...b.layers.filter(L => L.elementId === ribs.id).map(L => L.poly));
  assert.ok(P.area(P.intersection(raised, body.footprint)) > 100, 'ribs under the pocket');
  for (const L of b.layers.filter(L => L.elementId === ribs.id)) assert.ok(P.area(P.intersection(L.poly, body.occupies(L.z0, L.z1))) < 1e-6, 'and none inside the hood');
  assert.equal(accent.color, 'c3');
  assert.equal(body.color, 'c1');
  // strength: the hood stands on its top band and end walls, pulled at the bar
  assert.ok(gripShape(grip, { plateW: size.w }).strength.sigma < GRIP_STRENGTH.warnMPa, 'sturdy');
  const back = parseDesign(serializeDesign(d)).elements.find(e => e.id === grip.id);
  for (const k of ['style', 'fullWidth', 'flush', 'accentStrip', 'accentColor']) assert.equal(back[k], grip[k], k);
  // full width works for the other styles too
  const lip = newElement('grip', { style: 'lip', depth: 16, height: 10, undercut: 6, flush: 't', fullWidth: true });
  near(P.bbox(buildFace(design(lip), size).solids[0].footprint).w, size.w, 1e-9, 'a full-width lip');
});

test('Sol 01a1b6bb: a hood claims only where it has material at those heights, not its whole footprint', () => {
  const g = hoodShape({ style: 'classic' }, 87), pro = hoodShape({ style: 'classicpro' }, 175);
  const has = (mp, x, e) => P.contains(mp, x, 13.5 - e);   // e: mm down from the flush edge
  // above the face, the slope leaves the band along the top edge empty (e < v): relief there is not the hood's
  assert.ok(!has(g.occupies(1, 2), 0, 0.5), 'Classic, 1-2 mm up, 0.5 mm from the edge: empty');
  assert.ok(has(g.occupies(1, 2), 0, 1.6), 'but just inside the slope it is the hood');
  // from the face up, Classic Pro's recessed panel and the slope together leave the top band empty in the middle,
  // while the frame either side of the panel is solid
  assert.ok(!has(pro.occupies(0, 2), 0, 1), 'Pro, middle, 1 mm from the edge: empty');
  assert.ok(has(pro.occupies(0, 2), 40, 1), 'Pro, beside the panel: the frame');
  // the pocket stays clear of a low relief; the walls and the band above the pocket are the hood
  assert.ok(!has(pro.occupies(0, 2), 0, 15), 'pocket');
  assert.ok(has(pro.occupies(0, 2), 86, 15), 'end wall');
  // and it never claims less than the body has: every vertex of the body below 2 mm lies in occupies(0, 2)
  const occ = pro.occupies(0, 2);
  for (let i = 0; i < pro.tris.length; i += 3) if (pro.tris[i + 2] < 2 - 1e-6 && pro.tris[i + 2] > 1e-6) assert.ok(P.contains(occ, pro.tris[i], pro.tris[i + 1]) || P.area(P.intersection(occ, P.rect(pro.tris[i] - 0.01, pro.tris[i + 1] - 0.01, pro.tris[i] + 0.01, pro.tris[i + 1] + 0.01))) > 0, `vertex ${pro.tris[i]}, ${pro.tris[i + 1]}, ${pro.tris[i + 2]} covered`);
});
