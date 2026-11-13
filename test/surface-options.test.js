// Pins the 3D-texture options (2026-11-11): each texture's own settings shape it and keep it closed; bricks lay in
// five bonds; terraces snap the relief to flat steps; a flat border or raised rim frames it; cells take up to four
// filaments, at random or by height, as separate closed bodies that tile the area; a tip colour prints the peaks in
// another; the checks warn of detail finer than a nozzle; and the design file keeps every setting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;

const P = await import('../js/geometry/polys.js');
const { TEXTURE_PARAMS, textureDefaults } = await import('../js/geometry/heightmaps.js');
const S = await import('../js/geometry/surface.js');
const { CELL_MAPS } = await import('../js/geometry/cells.js');
const { buildFace, newElement } = await import('../js/geometry/face.js');
const { runChecks } = await import('../js/checks/checks.js');
const { newDesign, serializeDesign, parseDesign } = await import('../js/export/design.js');
const { indexTriangles } = await import('../js/export/threemf.js');
const { SIZE_BY_ID } = await import('../js/data/sizes.js');

const size = SIZE_BY_ID['2W-1H'];
function openWelded(tris) {
  const { tris: list } = indexTriangles(tris), edges = new Map();
  for (const [a, b, c] of list) for (const [p, q] of [[a, b], [b, c], [c, a]]) { const k = `${p}|${q}`; edges.set(k, (edges.get(k) || 0) + 1); }
  let bad = 0;
  for (const [k, n] of edges) { const [p, q] = k.split('|'); if (n !== 1 || edges.get(`${q}|${p}`) !== 1) bad++; }
  return bad;
}
const sig = tris => { let h = 0; for (let i = 0; i < tris.length; i += 7) h = (h * 31 + Math.round(tris[i] * 1000)) | 0; return `${tris.length}:${h}`; };
const region = P.difference(P.roundRect(-30, -15, 30, 15, 2), P.circle(-18, 0, 3, 40));
const build = (map, params, o = {}) => S.textureBodies(region, { map, scale: 4, seed: 3, params, centre: [0.4, -0.2] }, { z0: 2, base: 0.4, depth: 1, grid: 0.4, ...o });

test('every texture setting shapes its texture, and every setting keeps the body exact and closed', () => {
  const before = { ...S.surfaceStats };
  for (const map of Object.keys(TEXTURE_PARAMS)) {
    const base = sig(build(map, textureDefaults(map))[0].tris);
    for (const p of TEXTURE_PARAMS[map]) {
      const v = p.type === 'select' ? p.options.find(([o]) => o !== p.default)[0] : p.type === 'bool' ? !p.default : (p.default === p.max ? p.min : p.max);
      const [body] = build(map, { ...textureDefaults(map), [p.key]: v });
      assert.equal(openWelded(body.tris), 0, `${map} with ${p.key} = ${v} closes`);
      if (CELL_MAPS.has(map)) assert.ok(body.exact, `${map} with ${p.key} = ${v} is exact (${S.surfaceStats.lastError})`);
      assert.notEqual(sig(body.tris), base, `${map}: ${p.key} = ${v} changes the texture`);
    }
  }
  assert.equal(S.surfaceStats.fallback - before.fallback, 0, 'nothing fell back to the grid');
});

test('bricks: five bonds in three lengths, each tiling the area exactly once', () => {
  for (const bond of ['running', 'third', 'stack', 'herringbone', 'basket']) for (const length of ['2', '3', '4']) {
    // exactBody throws if the faces cover the area more or less than once, so an exact body is a proof of the tiling
    const before = S.surfaceStats.fallback;
    const [body] = build('bricks', { ...textureDefaults('bricks'), bond, length });
    assert.ok(body.exact && S.surfaceStats.fallback === before, `${bond} ${length}:1 tiles exactly (${S.surfaceStats.lastError})`);
    assert.equal(openWelded(body.tris), 0, `${bond} ${length}:1 closes`);
  }
  assert.notEqual(sig(build('bricks', { ...textureDefaults('bricks'), bond: 'herringbone' })[0].tris), sig(build('bricks', textureDefaults('bricks'))[0].tris), 'herringbone is its own layout');
});

test('terraces: every point of the top on a flat step, a whole number of steps above the base', () => {
  for (const map of ['crystal', 'noise', 'pebbles']) {
    const [body] = build(map, null, { terrace: 0.2 });
    assert.equal(openWelded(body.tris), 0, `${map} terraced closes`);
    const t = body.tris, zb = 2.4;
    let bad = 0, tops = 0;
    for (let i = 0; i < t.length; i += 9) {
      const nz = (t[i + 3] - t[i]) * (t[i + 7] - t[i + 1]) - (t[i + 4] - t[i + 1]) * (t[i + 6] - t[i]);
      if (nz <= 1e-9) continue;   // walls and the bottom
      tops++;
      for (const z of [t[i + 2], t[i + 5], t[i + 8]]) { const k = (z - zb) / 0.2; if (Math.abs(k - Math.round(k)) > 1e-3) bad++; }
    }
    assert.ok(tops > 50 && bad === 0, `${map}: ${bad} top corners off the 0.2 mm steps (of ${tops} triangles)`);
  }
});

test('a flat border or a raised rim frames the texture, the two bodies tiling the area', () => {
  for (const edge of ['border', 'rim']) {
    const parts = build('knurl', null, { edge, edgeW: 3 });
    const ring = parts.find(p => p.edge), tex = parts.find(p => !p.edge);
    assert.ok(ring && tex, `${edge}: a band and the texture`);
    for (const p of parts) assert.equal(openWelded(p.tris), 0, `${edge}: closes`);
    assert.ok(Math.abs(ring.z1 - (edge === 'rim' ? 3.4 : 2.4)) < 1e-4, `${edge}: the band's top at ${ring.z1}`);
    const sum = P.area(ring.footprint) + P.area(tex.footprint), lap = P.area(P.intersection(ring.footprint, tex.footprint));
    assert.ok(Math.abs(sum - P.area(region)) < 0.01 * P.area(region) && lap < 0.01 * P.area(region), `${edge}: they tile the area (${sum.toFixed(1)} of ${P.area(region).toFixed(1)}, overlap ${lap.toFixed(2)})`);
  }
});

test('cell colours: one closed body per filament, tiling the area, at random or by height', () => {
  for (const [map, o] of [['hexdome', { colors: 3 }], ['bricks', { colors: 2, colorMode: 'height' }], ['scales', { colors: 3, terrace: 0.2 }], ['blocks', { colors: 3, colorMode: 'height' }], ['studs', { colors: 4 }], ['noise', { colors: 3 }]]) {
    const before = S.surfaceStats.fallback;
    const parts = build(map, null, o);
    assert.equal(S.surfaceStats.fallback, before, `${map} ${JSON.stringify(o)} built exactly (${S.surfaceStats.lastError})`);
    assert.ok(parts.length >= 2, `${map}: ${parts.length} colours`);
    for (const p of parts) assert.equal(openWelded(p.tris), 0, `${map} colour ${p.colour} closes`);
    const sum = parts.reduce((s, p) => s + P.area(p.footprint), 0);
    let lap = 0;
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) lap += P.area(P.intersection(parts[i].footprint, parts[j].footprint));
    assert.ok(Math.abs(sum - P.area(region)) < 0.005 * P.area(region) && lap < 0.005 * P.area(region), `${map}: colours tile the area (${sum.toFixed(1)} of ${P.area(region).toFixed(1)}, overlap ${lap.toFixed(2)})`);
  }
  // blocks by height: the level tops in one colour, the falling sides in another
  const parts = build('blocks', null, { colors: 2, colorMode: 'height' });
  assert.equal(parts.length, 2, 'tops and sides');
  const [lo, hi] = parts.slice().sort((a, b) => a.z1 - b.z1);
  assert.ok(hi.z1 > lo.z1 - 1e-6 && P.area(hi.footprint) > 0.2 * P.area(region), 'the higher colour is the tops');
});

test('a tip colour prints the peaks: a body standing on the cut, the rest flat at the tip height', () => {
  for (const map of ['pebbles', 'crystal', 'ripple']) {
    const parts = build(map, null, { tipAt: 0.6 }), tip = parts.find(p => p.colour === 'tip'), lower = parts.find(p => p.colour === 0);
    assert.ok(tip && lower, `${map}: a lower body and a tip body`);
    for (const p of parts) assert.equal(openWelded(p.tris), 0, `${map}: closes`);
    assert.ok(Math.abs(tip.z0 - (3.0 - S.TIP_SINK)) < 1e-4, `${map}: the tip stands at base + 60% of the height, sunk ${S.TIP_SINK} mm into it (${tip.z0})`);
    assert.ok(Math.abs(lower.z1 - 3.0) < 1e-4 && tip.z1 > 3.0, `${map}: the rest stops there (${lower.z1}); the tips rise above (${tip.z1})`);
  }
});

test('in the app: colours and a tip as solids of their own filaments; the tip needs no face under it; fine detail warns', () => {
  const tex = newElement('surface', { map: 'hexdome', cellColors: ['c3', 'c4'], tipOn: true, tipColor: 'c1', tipAt: 75, edge: 'rim', edgeW: 2 });
  const d = newDesign({ mode: 'up', elements: [tex] }); d.handles.mount = 'none'; d.handles.holes = false;
  const b = buildFace(d, size), mine = b.solids.filter(s => s.elementId === tex.id);
  const colours = new Set(mine.map(s => s.color));
  assert.ok(['c2', 'c3', 'c4', 'c1'].every(c => colours.has(c)), `its filaments: ${[...colours].join(', ')}`);
  assert.ok(mine.some(s => s.style === 'surface-tip'), 'a tip solid');
  const checks = runChecks(b, d, size);
  assert.ok(!checks.checks.some(c => c.id === 'gripbase'), 'the tip stands on the texture, not the face');
  assert.ok(!checks.checks.some(c => c.id === 'texfine'), 'a 4 mm hex dome is not too fine');
  const fine = newElement('surface', { map: 'weave', scale: 1.5 });
  const d2 = newDesign({ mode: 'up', elements: [fine] }); d2.handles.mount = 'none'; d2.handles.holes = false;
  const warn = runChecks(buildFace(d2, size), d2, size).checks.find(c => c.id === 'texfine');
  assert.ok(warn && warn.st === 'warn' && /0\.5 mm/.test(warn.det), `a 1.5 mm weave's 0.5 mm strands warn (${warn && warn.det})`);
});

test("the design file keeps a texture's settings and options, and cleans junk", () => {
  const el = newElement('surface', { map: 'bricks', texParams: { bond: 'herringbone', length: '3', gap: 20, chamfer: 0, vary: 40 }, terrace: 0.3, edge: 'rim', edgeW: 4, cellColors: ['c3'], colorMode: 'height', tipOn: true, tipColor: 'c4', tipAt: 55 });
  const back = parseDesign(serializeDesign(newDesign({ elements: [el] }))).elements[0];
  assert.deepEqual(back.texParams, el.texParams, 'the bond, length, mortar, chamfer and variation');
  for (const k of ['terrace', 'edge', 'edgeW', 'colorMode', 'tipOn', 'tipColor', 'tipAt']) assert.equal(back[k], el[k], k);
  assert.deepEqual(back.cellColors, ['c3'], 'the cell colours');
  const junk = parseDesign({ elements: [{ kind: 'surface', map: 'bricks', texParams: { bond: 'zigzag', length: 9, gap: 'lots', chamfer: 500, evil: { toString: null } } }] }).elements[0];
  assert.deepEqual(junk.texParams, { ...textureDefaults('bricks'), chamfer: 40 }, 'unknown choices dropped, numbers clamped, strangers ignored');
});

test("a plateau on a terrace level keeps that level, and a tile's height is its mean over its area (Sol 01a1cbf7)", async () => {
  const { cutLevels } = await import('../js/geometry/cells.js');
  // floored steps: a ramp up to 0.5, a plateau at 0.5, a ramp on up to 1, terraced at 0.5
  const m = { pts: [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [1, 1], [2, 1], [3, 1]], cells: 1, faces: [
    { v: [0, 1, 5, 4], h: [0, 0.5, 0.5, 0], cell: 0, tile: 1 },
    { v: [1, 2, 6, 5], h: [0.5, 0.5, 0.5, 0.5], cell: 0, tile: 2 },
    { v: [2, 3, 7, 6], h: [0.5, 1, 1, 0.5], cell: 0, tile: 3 }] };
  const terraced = cutLevels(m, [0.5], { values: [0, 0.5] }), at = t => terraced.faces.filter(f => f.tile === t).map(f => f.h[0]);
  assert.deepEqual(at(2), [0.5], 'the plateau stays on its level');
  assert.deepEqual(at(1), [0], 'the ramp below it floors to the base');
  assert.deepEqual(at(3), [0.5], 'the ramp above it floors to the level');
  assert.deepEqual(cutLevels(m, [0.5]).faces.filter(f => f.tile === 2).map(f => f.band), [0], 'a plain cut (the tip) keeps it below the level');
  const trap = { pts: [[0, 0], [2, 0], [1, 1], [0, 1]], cells: 1, faces: [{ v: [0, 1, 2, 3], h: [0, 0, 1, 1], cell: 0, tile: 7 }] };
  assert.ok(Math.abs(S.tileHeights(trap).get(7) - 4 / 9) < 1e-12, "a trapezoid rising with y averages 4/9 over its area, not its corners' 1/2");
});
