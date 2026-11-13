// Pins the crisp taper mesher (2026-11-11): flat faces and sharp creases exactly on the true surface, closed on
// awkward shapes, and the grid mesher taking over (still closed) when the crisp build cannot be made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;

const PA = await import('../js/geometry/path.js');
const R = await import('../js/geometry/roof.js');
const P = await import('../js/geometry/polys.js');
const EX = await import('../js/geometry/extrude.js');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const volume = t => { let v = 0; for (let i = 0; i < t.length; i += 9) v += (t[i] * (t[i + 4] * t[i + 8] - t[i + 5] * t[i + 7]) - t[i + 1] * (t[i + 3] * t[i + 8] - t[i + 5] * t[i + 6]) + t[i + 2] * (t[i + 3] * t[i + 7] - t[i + 4] * t[i + 6])) / 6; return v; };

/** The worst gap between a body's top and the true surface, at the middle of every upward-facing triangle. */
function worstGap(tris, outline, opts) {
  const side = PA.sideProfile(opts), dist = PA.edgeDistance(outline, side.reach + 6);
  let worst = 0;
  for (let i = 0; i < tris.length; i += 9) {
    const ux = tris[i + 3] - tris[i], uy = tris[i + 4] - tris[i + 1], vx = tris[i + 6] - tris[i], vy = tris[i + 7] - tris[i + 1];
    if (ux * vy - uy * vx <= 1e-9) continue;   // walls, the bottom, slivers
    const cx = (tris[i] + tris[i + 3] + tris[i + 6]) / 3, cy = (tris[i + 1] + tris[i + 4] + tris[i + 7]) / 3, cz = (tris[i + 2] + tris[i + 5] + tris[i + 8]) / 3;
    worst = Math.max(worst, Math.abs(cz - side.at(dist(cx, cy))));
  }
  return worst;
}

test('flat-faced tapers are exact: frustum volumes, and every face on the true surface', () => {
  const sq = P.rect(-10, -10, 10, 10);
  const before = R.roofStats.exact;
  const f = PA.taperBody(sq, sq, { height: 5, angle: 45 });
  assert.equal(f.exact, true); assert.ok(R.roofStats.exact > before);
  near(volume(f.tris), (5 / 3) * (400 + 100 + 200), 1e-3, 'a 45° frustum, exactly');
  assert.ok(R.closedSoup(f.tris));
  const r = 8 * Math.tan(20 * Math.PI / 180), a = 20 - 2 * r;
  near(volume(PA.taperBody(sq, sq, { height: 8, angle: 20 }).tris), (8 / 3) * (400 + a * a + 20 * a), 1e-3, 'a 20° frustum');
  near(volume(PA.taperBody(sq, sq, { height: 5, angle: 0, edge: 'chamfer', size: 1 }).tris), 1600 + (400 - 40 + 4 / 3), 1e-3, 'a chamfered top');
  // the hips of a tapered L run exactly where the sides meet: its faces lie on the surface (the inside corner's cone
  // in sectors of at most 7.5°, so within a hair there)
  const L = P.union(P.rect(0, 0, 30, 10), P.rect(0, 0, 10, 30)), opts = { height: 4, angle: 30 };
  const bl = PA.taperBody(L, L, opts);
  assert.equal(bl.exact, true); assert.ok(R.closedSoup(bl.tris));
  assert.ok(worstGap(bl.tris, L, opts) < 0.01, `L: ${worstGap(bl.tris, L, opts)}`);
  const cOpts = { height: 6, angle: 15, edge: 'chamfer', size: 1.5 };
  assert.ok(worstGap(PA.taperBody(sq, sq, cOpts).tris, sq, cOpts) < 1e-4, 'a tapered chamfer: flat faces on the surface');
  // a round follows its arc in chords: measured across the arc (straight down overstates it where the arc is
  // nearly upright), within about 0.01 mm
  const rOpts = { height: 5, angle: 0, edge: 'round', size: 1 }, rb = PA.taperBody(sq, sq, rOpts).tris, rd = PA.edgeDistance(sq, 10);
  let rw = 0;
  for (let i = 0; i < rb.length; i += 9) {
    const ux = rb[i + 3] - rb[i], uy = rb[i + 4] - rb[i + 1], vx = rb[i + 6] - rb[i], vy = rb[i + 7] - rb[i + 1];
    if (ux * vy - uy * vx <= 1e-9) continue;
    const d = rd((rb[i] + rb[i + 3] + rb[i + 6]) / 3, (rb[i + 1] + rb[i + 4] + rb[i + 7]) / 3), zc = (rb[i + 2] + rb[i + 5] + rb[i + 8]) / 3;
    if (d < 1) rw = Math.max(rw, Math.abs(Math.hypot(d - 1, zc - 4) - 1));   // the arc: centre (1, 4), radius 1, in section
  }
  assert.ok(rw < 0.011, `a round top: ${rw}`);
});

test('awkward shapes come out crisp and closed', () => {
  const ring = P.difference(P.rect(-15, -10, 15, 10), P.rect(-5, -3, 5, 3));
  const circ = P.circle(0, 0, 10, 96), bar = P.rect(-15, -2, 15, 2);
  const big = P.translate(P.rect(-20, -10, 20, 10), 80, 0), plate = P.rect(-87.5, -27.5, 87.5, 27.5);
  const drawn = PA.pathOutline({ pts: [{ x: -25, y: -12 }, { x: 25, y: -12, o: [10, 8], i: [-10, -8] }, { x: 30, y: 12 }, { x: -30, y: 10 }], form: 'wall', thick: 4 });
  const cases = [
    ['a hole', ring, ring, { height: 3, angle: 25 }],
    ['a circle to a peak', circ, circ, { height: 20, angle: 40 }],
    ['a ridge', bar, bar, { height: 10, angle: 45 }],
    ['cut by the plate', P.intersection(big, plate), big, { height: 5, angle: 20 }],
    ['a traced wall band', drawn, drawn, { height: 8, angle: 12, edge: 'chamfer', size: 1.5 }],
  ];
  for (const [name, region, outline, opts] of cases) {
    const b = PA.taperBody(region, outline, opts);
    assert.equal(b.exact, true, `${name}: crisp (${R.roofStats.lastError})`);
    assert.ok(R.closedSoup(b.tris), `${name}: closed`);
  }
  near(PA.taperBody(bar, bar, { height: 10, angle: 45 }).z1, 2, 1e-9, 'the bar meets in a ridge 2 mm up');
  const cut = PA.taperBody(P.intersection(big, plate), big, { height: 5, angle: 20 });
  let xmax = -Infinity; for (let i = 0; i < cut.tris.length; i += 3) xmax = Math.max(xmax, cut.tris[i]);
  assert.ok(xmax <= 87.5 + 1e-4, 'stops at the plate edge');
});

test('when the crisp build cannot be made, the grid mesher takes over, still closed', () => {
  const sq = P.rect(-10, -10, 10, 10), keep = R.ROOF_LIMITS.maxWork;
  R.ROOF_LIMITS.maxWork = 1;
  try {
    const before = R.roofStats.fallback;
    const b = PA.taperBody(sq, sq, { height: 5, angle: 45 });
    assert.ok(R.roofStats.fallback > before); assert.notEqual(b.exact, true);
    assert.ok(R.closedSoup(b.tris), 'the grid body');
    near(b.z1, 5, 1e-6, 'its height');
  } finally { R.ROOF_LIMITS.maxWork = keep; }
});

test('a drawing that pinches to a point comes out crisp and closed', () => {
  // two lobes touching at one corner, on straight sides with a shaped top edge, so the corner has a wall's height:
  // both lobes' walls would stand on its one upright edge
  const bow = P.union(P.rect(0, 0, 10, 10), P.rect(10, 10, 20, 20));
  const eight = PA.pathOutline({ pts: [{ x: -20, y: -8 }, { x: 20, y: 8 }, { x: 20, y: -8 }, { x: -20, y: 8 }], form: 'fill' });
  for (const [name, shape, opts] of [
    ['two squares corner to corner, round top', bow, { height: 4, angle: 0, edge: 'round', size: 1 }],
    ['two squares corner to corner, chamfered top', bow, { height: 4, angle: 0, edge: 'chamfer', size: 1 }],
    ['a fill drawn crossing itself', eight, { height: 5, angle: 0, edge: 'round', size: 1.5 }],
  ]) {
    const b = PA.taperBody(shape, shape, opts);
    assert.equal(b.exact, true, `${name}: crisp (${R.roofStats.lastError})`);
    assert.ok(R.closedSoup(b.tris), `${name}: closed`);
  }
});

test('a hairline hole of the region stays a hole: only gaps inside it are filled', () => {
  // a square hole with a 0.03 micron slot running off it: as thin overall (area over perimeter) as a gap. One is a
  // 0.1 mm square with a 400 mm slot (far more area than any sliver left out), the other a 5 micron square with a
  // 1 mm slot (within the area the cover check allows): Sol 01a1cdfb. Meshed straight from the region, unthinned.
  for (const [name, outer, hole, tol] of [
    ['a 0.1 mm keyhole', P.rect(0, 0, 2, 403), P.union(P.rect(1, 1, 1.1, 1.1), P.rect(1.049985, 1.1, 1.050015, 401.1)), 1e-4],
    ['a 5 micron keyhole', P.rect(0, 0, 40, 40), P.union(P.rect(1, 1, 1.005, 1.005), P.rect(1.002485, 1.005, 1.002515, 2.005)), 1e-6],
  ]) {
    const region = P.difference(outer, hole);
    const side = PA.sideProfile({ height: 1, angle: 10 });
    const b = R.roofBody(region, outer, { z0: 0, side, dist: PA.edgeDistance(outer, side.reach + 6) });
    assert.ok(b && b.exact, `${name}: crisp (${R.roofStats.lastError})`);
    assert.ok(R.closedSoup(b.tris), `${name}: closed`);
    // the bottom is the top's pieces turned over, fills and all: its area is the region's, not the region's and the hole's
    let bottom = 0;
    const t = b.tris;
    for (let i = 0; i < t.length; i += 9) {
      if (t[i + 2] !== 0 || t[i + 5] !== 0 || t[i + 8] !== 0) continue;
      bottom -= ((t[i + 3] - t[i]) * (t[i + 7] - t[i + 1]) - (t[i + 4] - t[i + 1]) * (t[i + 6] - t[i])) / 2;
    }
    near(bottom, P.area(region), tol, `${name}: the bottom covers the region and not its hole`);
  }
});

test('a gap that runs into a hole of the region is not filled, hole and all', () => {
  // pieces made by hand (Sol 01a1cdfb): a 40 mm plate with a 5 micron square hole, a sliver of material standing on
  // the hole's edge (thin enough to be left out), and the rest in triangles. The gap the sliver leaves opens into the
  // hole, so the loop round it goes round the hole too: filled, it would close the hole.
  const { triangulate } = EX;
  const outer = P.rect(0, 0, 40, 40), region = P.difference(outer, P.rect(1, 1, 1.005, 1.005));
  const sliver = [[1.002485, 1.005], [1.002515, 1.005], [1.0025, 2.005]];
  const pieces = [sliver];
  for (const poly of P.difference(region, [[[...sliver, sliver[0]]]])) {
    const t = triangulate(poly);
    for (let m = 0; m + 2 < t.length; m += 3) pieces.push([t[m], t[m + 1], t[m + 2]]);
  }
  const side = PA.sideProfile({ height: 1, angle: 0, edge: 'chamfer', size: 0.2 });
  const b = R.roofAssemble(pieces, region, { side, dist: PA.edgeDistance(outer, side.reach + 6), weld: 1e-5 });
  assert.ok(R.closedSoup(b.tris), 'closed');
  // how many times the bottom covers the middle of the hole (a face down counts once): never
  let over = 0;
  const t = b.tris, hx = 1.0025, hy = 1.0025;
  for (let i = 0; i < t.length; i += 9) {
    if (t[i + 2] !== 0 || t[i + 5] !== 0 || t[i + 8] !== 0) continue;
    const s1 = (t[i + 3] - t[i]) * (hy - t[i + 1]) - (t[i + 4] - t[i + 1]) * (hx - t[i]);
    const s2 = (t[i + 6] - t[i + 3]) * (hy - t[i + 4]) - (t[i + 7] - t[i + 4]) * (hx - t[i + 3]);
    const s3 = (t[i] - t[i + 6]) * (hy - t[i + 7]) - (t[i + 1] - t[i + 7]) * (hx - t[i + 6]);
    if ((s1 > 0 && s2 > 0 && s3 > 0) || (s1 < 0 && s2 < 0 && s3 < 0)) over++;
  }
  assert.equal(over, 0, 'the hole is still a hole');
});

test('random drawings come out closed every time, and crisp nearly every time', () => {
  // the same kind of drawing as a person makes: a few points, some curved, filled, a wall or a line, anywhere on a
  // plate, with any taper and top edge (2026-11-11: 233 of 240 crisp over three seeds of 80)
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const plate = P.rect(-87.5, -27.5, 87.5, 27.5);
  let made = 0, crisp = 0;
  for (let n = 0; n < 16; n++) {
    const k = 3 + Math.floor(rnd() * 6), pts = [];
    for (let i = 0; i < k; i++) {
      const a = (i / k) * 2 * Math.PI + (rnd() - 0.5) * 0.6, r = 8 + rnd() * 18;
      const p = { x: Math.cos(a) * r * 1.6, y: Math.sin(a) * r * 0.9 };
      if (rnd() < 0.4) { const hx = (rnd() - 0.5) * 12, hy = (rnd() - 0.5) * 12; p.o = [hx, hy]; p.i = [-hx, -hy]; }
      pts.push(p);
    }
    const form = rnd() < 0.6 ? 'fill' : rnd() < 0.5 ? 'wall' : 'line';
    let outline = PA.pathOutline({ pts, form, thick: 1 + rnd() * 5, ends: rnd() < 0.5 ? 'round' : 'flat' });
    if (!outline.length) continue;
    outline = P.translate(outline, (rnd() - 0.5) * 140, (rnd() - 0.5) * 40);
    const region = P.intersection(outline, plate);
    if (!region.length) continue;
    const opts = { height: 2 + rnd() * 18, angle: rnd() < 0.2 ? 0 : 2 + rnd() * 50, edge: ['square', 'chamfer', 'round'][Math.floor(rnd() * 3)], size: 0.3 + rnd() * 3 };
    if (opts.angle === 0 && opts.edge === 'square') opts.edge = 'round';
    const b = PA.taperBody(region, outline, { ...opts, keep: plate });
    made++;
    assert.ok(R.closedSoup(b.tris), `drawing ${n}: closed`);
    if (b.exact) crisp++;
  }
  assert.ok(made >= 12, `${made} drawings made`);
  assert.ok(crisp >= made - 1, `${crisp} of ${made} crisp (${R.roofStats.lastError})`);
});

test('thinning an outline keeps its corners and drops points that add nothing', () => {
  const dense = [[[...Array.from({ length: 101 }, (_, i) => [i * 0.2, 0]), [20, 10], [0, 10], [0, 0]]]];
  const thin = R.simplifyOutline(dense, 0.003);
  assert.equal(thin[0][0].length, 5, 'a rectangle: four corners and the closing point');
  near(P.area(thin), 200, 1e-9, 'the same area');
  assert.equal(R.simplifyOutline(P.rect(0, 0, 1, 1), 0.003)[0][0].length, 5);
});
