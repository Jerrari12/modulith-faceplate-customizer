// Pins sharp-edged 3D textures (2026-11-06): the maps with edges (crystal, pebbles, bricks, hex domes, knurl, weave)
// are meshed from exact cells, so their cliffs and creases lie on mesh edges instead of zigzagging along a grid;
// every body closes, also once the 3MF writer welds it, over every kind of area, without falling back to the grid;
// they take far fewer triangles; the smooth maps' grid follows diagonal ridges either way; and the inspector tiles
// draw the edged maps as vector faces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;

const P = await import('../js/geometry/polys.js');
const { heightFunction } = await import('../js/geometry/heightmaps.js');
const S = await import('../js/geometry/surface.js');
const { cellMesh, textureFrame, voronoiSite, CELL_MAPS } = await import('../js/geometry/cells.js');
const T = await import('../js/geometry/text.js');
const { buildFace, newElement } = await import('../js/geometry/face.js');
const { runChecks } = await import('../js/checks/checks.js');
const { newDesign } = await import('../js/export/design.js');
const { indexTriangles } = await import('../js/export/threemf.js');
const { SIZE_BY_ID } = await import('../js/data/sizes.js');
const { mapGlyph } = await import('../js/ui/glyphs.js');

const size = SIZE_BY_ID['2W-1H'];
/** Open edges once the 3MF writer has welded the soup (what PrusaSlicer will see). */
function openWelded(tris) {
  const { tris: list } = indexTriangles(tris), edges = new Map();
  for (const [a, b, c] of list) for (const [p, q] of [[a, b], [b, c], [c, a]]) { const k = `${p}|${q}`; edges.set(k, (edges.get(k) || 0) + 1); }
  let bad = 0;
  for (const [k, n] of edges) { const [p, q] = k.split('|'); if (n !== 1 || edges.get(`${q}|${p}`) !== 1) bad++; }
  return bad;
}
/** Distance from (x, y) to the nearest edge of an axis-aligned rectangle. */
const toRectEdge = (x, y, r) => Math.min(Math.abs(x - r[0]), Math.abs(x - r[2]), Math.abs(y - r[1]), Math.abs(y - r[3]));

test('every edged map closes over every kind of area, welded too, and never falls back to the grid', async () => {
  await T.loadFont('archivo');
  const word = T.textOutline({ font: 'archivo', text: 'Rock 8', size: 14 }).poly;
  const regions = {
    plate: P.difference(P.roundRect(-88, -28, 88, 28, 3), P.circle(-60, 0, 4, 48), P.rect(20, -6, 32, 6)),
    word,
    aligned: P.rect(-24, -12, 24, 12),   // on multiples of a 4 mm texture's lattice
    ring: P.difference(P.circle(3, 1, 14, 160), P.circle(3, 1, 6, 80)),
  };
  const settings = [{ scale: 4, angle: 0, seed: 1, centre: [0, 0] }, { scale: 2.5, angle: 33, seed: 7, centre: [1.3, -2.1], invert: true }, { scale: 7, angle: 90, seed: 19, centre: [0, 0] }];
  const before = { ...S.surfaceStats };
  let runs = 0;
  for (const map of CELL_MAPS) for (const [name, region] of Object.entries(regions)) for (const st of settings) {
    const body = S.textureBody(region, { map, ...st }, { z0: 2, base: 0.4, depth: 0.6, grid: 0.4 });
    assert.ok(body && body.exact, `${map} over ${name} ${JSON.stringify(st)}: meshed exactly (${S.surfaceStats.lastError})`);
    assert.equal(openWelded(body.tris), 0, `${map} over ${name} ${JSON.stringify(st)}: closed once welded`);
    runs++;
  }
  assert.equal(S.surfaceStats.fallback - before.fallback, 0, `no fallback in ${runs} bodies`);
  // a smooth map still goes to the grid
  assert.ok(!S.textureBody(regions.aligned, { map: 'noise', scale: 4 }, { z0: 2 }).exact, 'smooth maps keep the grid');
});

test('in the app: a whole face with a block, textured letters and a mirrored shape, all exact and closed', async () => {
  await T.loadFont('archivo');
  const block = newElement('solid', { shape: 'box', w: 12, h: 12, out: 5, x: -50 });
  const face = newElement('surface', { map: 'crystal', scale: 3 });
  const word = newElement('text', { text: 'ROCK', size: 20, op: 'raise', height: 1, x: 25 });
  const letters = newElement('surface', { map: 'knurl', region: 'element', target: word.id, scale: 2 });
  const shp = newElement('surface', { map: 'hexdome', region: 'shape', w: 24, h: 16, x: 60, y: 8 });
  const d = newDesign({ mode: 'up', symmetry: 'x', elements: [block, face, word, letters, shp] }); d.handles.mount = 'none'; d.handles.holes = false;
  const before = { ...S.surfaceStats };
  const b = buildFace(d, size);
  const tex = b.solids.filter(s => s.kind === 'surface');
  assert.ok(tex.length >= 4, `the face, the letters, the shape and its twin (${tex.length})`);
  for (const s of tex) assert.equal(openWelded(s.tris), 0, `${s.name}${s.twin ? ' (twin)' : ''} closes once welded`);
  assert.equal(S.surfaceStats.fallback - before.fallback, 0, 'none fell back to the grid');
  assert.ok(S.surfaceStats.exact > before.exact, 'they were meshed exactly');
  assert.equal(runChecks(b, d, size).status, 'pass', 'and the plate prints clean');
});

test('crystal cliffs lie exactly on the Voronoi edges; knurl has no points but its lattice', () => {
  const R = [-20, -10, 20, 10], region = P.rect(...R);
  const opts = { map: 'crystal', scale: 4, angle: 23, seed: 5, centre: [0.5, -1] };
  const body = S.textureBody(region, opts, { z0: 2, base: 0.4, depth: 0.8, grid: 0.4 });
  assert.ok(body.exact);
  // a cliff point: one place on the top with two or more heights (a wall's vertical edge)
  const tops = new Map(), t = body.tris;
  for (let i = 0; i < t.length; i += 3) if (t[i + 2] > 2 + 1e-6) { const k = `${t[i]},${t[i + 1]}`; (tops.get(k) || tops.set(k, new Set()).get(k)).add(t[i + 2]); }
  const F = textureFrame(opts);
  let cliffs = 0, worst = 0;
  for (const [k, zs] of tops) {
    if (zs.size < 2) continue;
    const [x, y] = k.split(',').map(Number);
    if (toRectEdge(x, y, R) < 0.01) continue;   // the outline's own corners (nudged off the mesh by 0.3 µm)
    const [u, v] = F.toLocal(x, y), ds = [];
    // the sites sit on a hex lattice (rows sqrt3/2 apart), moved by the default 80% irregularity
    const r0 = Math.round(v / (Math.sqrt(3) / 2)), q0 = Math.round(u - 0.5 * r0);
    for (let r = r0 - 3; r <= r0 + 3; r++) for (let q = q0 - 3; q <= q0 + 3; q++) { const s = voronoiSite(opts.seed, q, r, 0.8); ds.push(Math.hypot(u - s[0], v - s[1])); }
    ds.sort((a, b) => a - b);
    worst = Math.max(worst, (ds[1] - ds[0]) * F.s);
    cliffs++;
  }
  assert.ok(cliffs > 50, `cliffs found (${cliffs})`);
  assert.ok(worst < 1e-5, `every cliff point equidistant from its two sites, within the float32 output (worst ${worst.toExponential(1)} mm)`);
  // knurl: away from the outline, every top point is a groove (0) or a peak (1): the creases are the mesh's edges
  const kn = S.textureBody(region, { map: 'knurl', scale: 4, angle: 11 }, { z0: 2, base: 0.4, depth: 0.8, grid: 0.4 });
  let odd = 0, seen = 0;
  for (let i = 0; i < kn.tris.length; i += 3) {
    const x = kn.tris[i], y = kn.tris[i + 1], z = kn.tris[i + 2];
    if (z <= 2 + 1e-6 || toRectEdge(x, y, R) < 0.01) continue;
    seen++;
    if (Math.abs(z - 2.4) > 1e-5 && Math.abs(z - 3.2) > 1e-5) odd++;
  }
  assert.ok(seen > 100 && odd === 0, `${odd} of ${seen} knurl points off the grooves and peaks`);
});

test('far fewer triangles than the grid for the faceted maps, and a turned texture builds only what it covers', () => {
  const plate = P.roundRect(-88, -28, 88, 28, 3);
  for (const [map, factor] of [['crystal', 8], ['knurl', 15], ['bricks', 8], ['pebbles', 2.5], ['hexdome', 2]]) {
    const opts = { map, scale: 4, angle: 0, seed: 2 };
    const exact = S.textureBody(plate, opts, { z0: 2, grid: 0.4 }), grid = S.surfaceBody(plate, heightFunction(opts), { z0: 2, grid: 0.4 });
    assert.ok(exact.tris.length * factor < grid.tris.length, `${map}: ${exact.tris.length / 9} triangles against the grid's ${grid.tris.length / 9}`);
  }
  const straight = cellMesh({ map: 'weave', scale: 4, angle: 0 }, { x0: -88, y0: -28, x1: 88, y1: 28 }, 0.4).faces.length;
  const turned = cellMesh({ map: 'weave', scale: 4, angle: 30 }, { x0: -88, y0: -28, x1: 88, y1: 28 }, 0.4).faces.length;
  assert.ok(turned < straight * 1.7, `a turned weave builds over the plate, not its turned box (${turned} faces against ${straight})`);
});

test('smooth maps: the grid splits each square along the diagonal that follows the surface', () => {
  // a sharp ridge along each diagonal through the grid's corners: a square split across the ridge sags to the height
  // of its two off-ridge corners (0.69 here), one split along it keeps the ridge's full height
  const region = P.rect(-20, -20, 20, 20);
  for (const s of [1, -1]) {
    const t = S.surfaceBody(region, (x, y) => Math.max(0, 1 - Math.abs(x + s * y) / 0.9), { z0: 0, base: 0.5, depth: 1, grid: 0.4 }).tris;
    let worst = 0;
    for (let u = -15; u <= 15; u += 0.37) {
      const x = u, y = -s * u;
      for (let i = 0; i < t.length; i += 9) {
        if (t[i + 2] < 0.25 || t[i + 5] < 0.25 || t[i + 8] < 0.25) continue;   // top triangles only
        const x0 = t[i], y0 = t[i + 1], x1 = t[i + 3], y1 = t[i + 4], x2 = t[i + 6], y2 = t[i + 7];
        const d = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
        if (Math.abs(d) < 1e-12) continue;
        const a = ((x1 - x) * (y2 - y) - (x2 - x) * (y1 - y)) / d, b = ((x2 - x) * (y0 - y) - (x0 - x) * (y2 - y)) / d, c = 1 - a - b;
        if (a < -1e-9 || b < -1e-9 || c < -1e-9) continue;
        worst = Math.max(worst, Math.abs(a * t[i + 2] + b * t[i + 5] + c * t[i + 8] - 1.5));
        break;
      }
    }
    assert.ok(worst < 0.02, `the ridge along x ${s > 0 ? '+' : '-'} y = 0 keeps its height (worst sag ${worst.toFixed(3)} mm)`);
  }
});

test('Sol 01a1b3bf: a fine weave keeps its relief; an area too small to survive the weld is not reported exact', () => {
  for (const [scale, grid] of [[1.2, 0.6], [2.5, 0.6], [1.5, 0.4], [1, 0.25]]) {
    const b = S.textureBody(P.rect(-10, -10, 10, 10), { map: 'weave', scale }, { z0: 2, base: 0.4, depth: 0.6, grid });
    assert.ok(b.exact && b.z1 - 2.4 > 0.3, `weave at ${scale} mm on a ${grid} mm grid rises ${(b.z1 - 2.4).toFixed(3)} of 0.6 mm`);
  }
  const tiny = S.textureBody(P.rect(2, 2, 2.00001, 2.00001), { map: 'bricks', scale: 4 }, { z0: 2 });
  assert.ok(!tiny || !tiny.exact, 'a 10 nm square is not an exact body');
});

test('the inspector tiles draw the edged maps as vector faces', () => {
  const crystal = mapGlyph('crystal', '#d4a24c');
  assert.ok((crystal.match(/<path/g) || []).length >= 8 && !crystal.includes('<rect x="-30.00"'), 'crystal: facets as paths');
  const noise = mapGlyph('noise', '#d4a24c');
  assert.ok(noise.includes('<rect') && !noise.includes('<path'), 'noise without a document: the square grid');
});
