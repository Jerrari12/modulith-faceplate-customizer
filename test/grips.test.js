// Grips as one family: every style closed for every end, lean and chamfer; the old styles unchanged when the new
// options are off; the arch pull support-free with its bridge checked; and relief kept wherever a grip has no
// material at its height (under an undercut, a lip's pocket or an arch) instead of cut to the footprint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;

const P = await import('../js/geometry/polys.js');
const { gripShape, styleStart, LIP_PRESET } = await import('../js/geometry/grips.js');
const { buildFace, newElement } = await import('../js/geometry/face.js');
const { runChecks } = await import('../js/checks/checks.js');
const { newDesign, serializeDesign, parseDesign } = await import('../js/export/design.js');
const { SIZE_BY_ID } = await import('../js/data/sizes.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);
const size = SIZE_BY_ID['2W-1H'];

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
const design = (...els) => { const d = newDesign({ mode: 'up', elements: els }); d.handles.mount = 'none'; d.handles.holes = false; return d; };

test('every grip style is closed and outward for every end, lean, chamfer and flip', () => {
  let n = 0;
  for (const style of ['bar', 'wedge', 'ledge', 'dome', 'lip', 'arch']) for (const ends of ['square', 'angled', 'round']) for (const lean of [0, 20, 45])
    for (const chamfer of [0, 0.5, 2]) for (const flip of [false, true]) {
      const el = { style, ends, lean, chamfer, flip, length: 50, depth: 12, height: style === 'arch' ? 24 : 8, undercut: 4, endTaper: 6 };
      const { unpaired, vol } = closedness(gripShape(el).tris);
      assert.equal(unpaired, 0, `${JSON.stringify(el)}: closed`);
      assert.ok(vol > 0, `${JSON.stringify(el)}: outward`);
      n++;
    }
  assert.equal(n, 324);
});

test('with the new options off, the old styles keep their old shape', () => {
  const v = el => closedness(gripShape({ length: 50, depth: 8, height: 6, undercut: 3, ...el }).tris).vol;
  near(v({ style: 'bar', chamfer: 0.5 }), 50 * (8 * 6 - 2 * 0.125), 1e-6, 'bar with its 0.5 mm chamfer');
  near(v({ style: 'wedge', chamfer: 0 }), 50 * ((8 + 2) / 2) * 6, 1e-6, 'wedge');
  near(v({ style: 'ledge', chamfer: 0 }), 50 * ((8 + 5) / 2) * 6, 1e-6, 'ledge');
  near(gripShape({ style: 'wedge', depth: 8, height: 6, undercut: 3 }).overhang, Math.atan2(3, 6) * 180 / Math.PI, 1e-9, 'wedge overhang');
  // the contact base of a wedge is its 2 mm middle, a flipped ledge's base sits on the other side
  near(P.bbox(gripShape({ style: 'wedge', length: 50, depth: 8, height: 6, undercut: 3, chamfer: 0 }).base).h, 2, 1e-9, 'wedge base');
  const ledge = gripShape({ style: 'ledge', length: 50, depth: 8, height: 6, undercut: 3, flip: true, chamfer: 0 });
  near(P.bbox(ledge.base).y0, -4 + 3, 1e-9, 'flipped ledge base starts past the undercut');
});

test('ends: angled and rounded come in toward the long sides, and lean in as they rise', () => {
  const bar = gripShape({ style: 'bar', length: 60, depth: 10, height: 8, chamfer: 0, ends: 'angled', endTaper: 5 });
  const fp = bar.footprint[0][0];
  const widthAt = y => { const xs = fp.filter(([, v]) => Math.abs(v - y) < 1e-9).map(([x]) => x); return Math.max(...xs) - Math.min(...xs); };
  near(widthAt(0), 60, 1e-9, 'full length along the middle');
  near(widthAt(5), 50, 1e-9, 'pointed in by the taper at each long side');
  const leant = gripShape({ style: 'bar', length: 60, depth: 10, height: 8, chamfer: 0, lean: 30 });
  near(P.bbox(leant.footprint).w - P.bbox(leant.top).w, 2 * 8 * Math.tan(Math.PI / 6), 1e-9, 'top shorter by the lean');
  // a lean so steep the top would vanish is held back
  const tooMuch = gripShape({ style: 'bar', length: 12, depth: 10, height: 20, chamfer: 0, lean: 45 });
  assert.ok(P.bbox(tooMuch.top).w >= 1 - 1e-9, 'some top is left');
});

test('the arch pull prints without support: 45 degree flanks, a short bridge, and the checks agree', () => {
  const start = styleStart({ height: 6 }, 'arch');
  const a = gripShape({ style: 'arch', ...start });
  assert.equal(a.overhang, 45);
  near(a.bridge, 4, 1e-9, 'default arch: 56 long, 6 mm legs, 24 high, 4 mm bar -> a 4 mm bridge');
  near(P.area(a.base), 2 * 6 * 10, 1e-9, 'it stands on its two legs');
  const el = newElement('grip', { style: 'arch', ...start });
  const d = design(el);
  let res = runChecks(buildFace(d, size), d, size);
  assert.equal(res.status, 'pass', res.checks.filter(c => c.st !== 'pass').map(c => `${c.st} ${c.lbl}`).join(', '));
  // a long, low arch leaves a long flat bridge under its bar, and says so
  Object.assign(el, { length: 90, height: 16 });
  res = runChecks(buildFace(d, size), d, size);
  assert.ok(res.checks.some(c => c.lbl === 'Bridge too long' && c.st === 'fail'), 'a 54 mm bridge fails');
  el.length = 50; el.height = 16;   // a = 19, opening 12 high: a 14 mm bridge
  res = runChecks(buildFace(d, size), d, size);
  assert.ok(res.checks.some(c => c.lbl === 'Bridge too long'), '14 mm is past the 12 mm limit');
  // switching a small bar to an arch starts it at a size that works; a tall enough one keeps its sizes
  assert.deepEqual(styleStart({ height: 20 }, 'arch'), {});
});

test('relief keeps going under a lip pocket and an arch, and never through the grip', () => {
  const stripes = newElement('pattern', { name: 'Stripes', pattern: 'stripes', op: 'raise', height: 2.5, color: 'c2', params: { pitch: 7, width: 3, angle: 90, phaseY: 3.5 } });
  for (const grip of [newElement('grip', { ...LIP_PRESET }), newElement('grip', { style: 'arch', ...styleStart({}, 'arch'), y: -5 })]) {
    for (const order of ['before', 'after']) {
      const d = order === 'before' ? design(stripes, grip) : design(grip, stripes);
      const b = buildFace(d, size), g = b.solids.find(s => s.elementId === grip.id);
      const raised = b.layers.filter(L => L.elementId === stripes.id);
      const underFootprint = P.area(P.intersection(P.union(...raised.map(L => L.poly)), g.footprint));
      assert.ok(underFootprint > 20, `${grip.style}, stripes ${order}: relief under the footprint (${underFootprint.toFixed(1)} mm2)`);
      for (const L of raised) {
        const clash = P.area(P.intersection(L.poly, g.occupies(L.z0, L.z1)));
        assert.ok(clash < 1e-6, `${grip.style}, stripes ${order}: no relief inside the grip (${clash})`);
      }
      assert.equal(runChecks(b, d, size).status, 'pass', `${grip.style}, stripes ${order}: prints clean`);
    }
  }
});

test('a mirrored twin keeps its relief too, and the new settings survive a save and load', () => {
  const stripes = newElement('pattern', { pattern: 'stripes', op: 'raise', height: 2, params: { pitch: 7, width: 3, angle: 90, phaseY: 3.5 } });
  const lip = newElement('grip', { ...LIP_PRESET, length: 40, x: 50 });
  const d = design(stripes, lip); d.symmetry = 'x';
  const b = buildFace(d, size), pair = b.solids.filter(s => s.elementId === lip.id);
  assert.equal(pair.length, 2);
  const raised = P.union(...b.layers.filter(L => L.elementId === stripes.id).map(L => L.poly));
  for (const s of pair) assert.ok(P.area(P.intersection(raised, s.footprint)) > 10, 'relief under each pocket');
  const arch = newElement('grip', { style: 'arch', length: 60, legs: 8, bar: 5, chamfer: 1.5, height: 22 });
  const bar = newElement('grip', { style: 'bar', ends: 'round', endTaper: 4, lean: 15, chamfer: 1 });
  const back = parseDesign(serializeDesign(design(arch, bar)));
  for (const [orig, k] of [[arch, ['style', 'length', 'legs', 'bar', 'chamfer', 'height']], [bar, ['style', 'ends', 'endTaper', 'lean', 'chamfer']]]) {
    const got = back.elements.find(e => e.id === orig.id);
    for (const key of k) assert.equal(got[key], orig[key], `${orig.style}.${key}`);
  }
});

test('Sol 01a1b3d5: on rounded ends the carved region never reaches past the grip', () => {
  // a lip with rounded ends and relief 6.9 mm high: the pocket's edge falls between two of the ends' samples, where
  // the true curve bulges about 0.5 mm past the chord the mesh draws; the carve now follows the chord
  const lip = gripShape({ style: 'lip', length: 70, depth: 16, height: 10, undercut: 6.5, lipEdge: 3, chamfer: 0, ends: 'round', endTaper: 8 });
  for (const z of [0.3, 1, 2.5, 4, 6.9, 9]) {
    const occ = lip.occupies(0, z);
    near(P.area(P.difference(occ, lip.footprint)), 0, 1e-6, `occupies(0, ${z}) inside the footprint`);
  }
  for (const style of ['bar', 'wedge', 'ledge', 'dome']) for (const lean of [0, 30]) {
    const g = gripShape({ style, length: 40, depth: 12, height: 8, undercut: 4, chamfer: 1, ends: 'round', endTaper: 6, lean });
    for (const z of [0.5, 3, 7.5]) near(P.area(P.difference(g.occupies(0, z), g.footprint)), 0, 1e-6, `${style} lean ${lean}: occupies(0, ${z}) inside`);
  }
});

test('a grip on a thin base is called out as likely to snap, and Make it sturdy finds the smallest fix', async () => {
  const { sturdier, GRIP_STRENGTH } = await import('../js/geometry/grips.js');
  // Joey's ledge: 8 mm deep with a 6.5 mm undercut stands on 1.5 mm of face
  const ledge = newElement('grip', { name: 'Ledge', style: 'ledge', length: 70, depth: 8, height: 8, undercut: 6.5, flip: true, flush: 't' });
  const d = design(ledge);
  const weak = gripShape(ledge).strength;
  near(weak.width, 1.5, 1e-9, 'base width');
  assert.ok(weak.sigma > GRIP_STRENGTH.failMPa, `about ${weak.sigma.toFixed(1)} MPa`);
  let res = runChecks(buildFace(d, size), d, size);
  assert.ok(res.checks.some(c => c.id === 'strength' && c.st === 'fail' && c.lbl === 'Grip may snap off'), 'flagged');
  const fix = sturdier(ledge);
  assert.deepEqual(Object.keys(fix), ['undercut'], 'it keeps the look: only the undercut shrinks');
  assert.ok(fix.undercut > 0 && fix.undercut < 6.5);
  Object.assign(ledge, fix);
  assert.ok(gripShape(ledge).strength.sigma <= GRIP_STRENGTH.sturdyMPa, 'sturdy now');
  assert.ok(gripShape({ ...ledge, undercut: fix.undercut + 0.25 }).strength.sigma > GRIP_STRENGTH.sturdyMPa, 'and it is the largest undercut that is');
  res = runChecks(buildFace(d, size), d, size);
  assert.ok(res.checks.some(c => c.id === 'strength' && c.st === 'pass'), 'grips are sturdy');
  // the old default wedge (8 mm, 3 mm undercuts: a 2 mm base) was weak; the new defaults are not
  assert.ok(gripShape({ style: 'wedge', length: 50, depth: 8, height: 6, undercut: 3 }).strength.sigma > GRIP_STRENGTH.failMPa);
  const fresh = newElement('grip');
  assert.ok(gripShape(fresh).strength.sigma < GRIP_STRENGTH.warnMPa, 'a new grip is sturdy');
  // a pull you pinch (a bar) is plain tension; a wider base is always stronger
  near(gripShape({ style: 'bar', length: 50, depth: 8, height: 6 }).strength.sigma, 100 / (50 * 8), 1e-9, 'bar: F / A');
  assert.ok(gripShape({ style: 'lip', depth: 20, undercut: 6.5 }).strength.sigma < gripShape({ style: 'lip', depth: 14, undercut: 6.5 }).strength.sigma);
  assert.deepEqual(sturdier(fresh), {}, 'nothing to do when it is sturdy');
});

test('Sol 01a1b3e6: an arch is scored at its leg roots, which bend under the pull, and a long bridge counts', async () => {
  const { sturdier, GRIP_STRENGTH } = await import('../js/geometry/grips.js');
  const base = { style: 'arch', length: 56, depth: 10, height: 24, legs: 6, bar: 4, chamfer: 2 };
  // 50 N per leg through its inner edge: 50/60 + 50*3*3/(10*216/12) = 3.33 MPa, with 0.83 MPa of shear
  near(gripShape(base).strength.sigma, Math.sqrt((50 / 60 + 50 * 9 / 180) ** 2 + 3 * (50 / 60) ** 2), 1e-9, 'default arch');
  assert.ok(gripShape(base).strength.sigma > 4 * 100 / 120 - 1e-9, 'more than plain tension over both legs');
  // narrow legs are thin; Make it sturdy widens them
  const thin = { ...base, legs: 3 };
  assert.ok(gripShape(thin).strength.sigma > GRIP_STRENGTH.warnMPa, `3 mm legs: ${gripShape(thin).strength.sigma.toFixed(1)} MPa`);
  const fix = sturdier(thin);
  assert.ok(fix.legs > 3 && gripShape({ ...thin, ...fix }).strength.sigma <= GRIP_STRENGTH.sturdyMPa, 'wider legs');
  // the span matters now: a wide, low arch with a long bridge is weaker than the same legs on a pointed arch
  assert.ok(gripShape({ ...base, length: 90, height: 16 }).strength.sigma > gripShape(base).strength.sigma, 'a long bridge counts');
});
