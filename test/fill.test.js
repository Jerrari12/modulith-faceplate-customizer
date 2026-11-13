// Pins texture fills (2026-11-06): the raster offset that makes borders, the four textures (knurl, ripples, wood
// grain, stipple), filling shapes, text and art with a texture or an outline, pattern settings cleaned in design
// files, and slivers along the plate edge noted rather than failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;

const P = await import('../js/geometry/polys.js');
const { offsetPoly } = await import('../js/geometry/offset.js');
const { generatePattern, cleanPatternParams, patternDefaults } = await import('../js/geometry/patterns.js');
const { applyFill, FILL_OPTIONS, isFilled } = await import('../js/geometry/fill.js');
const T = await import('../js/geometry/text.js');
const { buildFace, newElement, elementParts } = await import('../js/geometry/face.js');
const { runChecks } = await import('../js/checks/checks.js');
const { newDesign, serializeDesign, parseDesign } = await import('../js/export/design.js');
const { SIZE_BY_ID } = await import('../js/data/sizes.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);
const size = SIZE_BY_ID['2W-1H'];
const checksOf = d => runChecks(buildFace(d, size), d, size).checks;

test('offsets: a rectangle shrinks and grows by exactly the distance, with round outer corners', () => {
  const r = P.rect(-10, -5, 10, 5);
  const ins = offsetPoly(r, -1), out = offsetPoly(r, 1);
  near(P.area(ins), 18 * 8, 0.05, 'inset area');
  const bo = P.bbox(out);
  near(bo.x1, 11, 0.02, 'outset reaches 1 mm out'); near(bo.y1, 6, 0.02);
  near(P.area(out), 22 * 12 - (4 - Math.PI), 0.1, 'outset corners are quarter circles');
  assert.equal(offsetPoly(P.rect(0, 0, 10, 0.6), -0.5).length, 0, 'an inset wider than half the shape swallows it');
  const ring = P.difference(P.circle(0, 0, 10, 180), P.circle(0, 0, 6, 180));
  const ri = offsetPoly(ring, -0.5);
  assert.equal(ri.length, 1); assert.equal(ri[0].length, 2, 'a ring stays a ring');
  near(P.area(ri), Math.PI * (9.5 ** 2 - 6.5 ** 2), 0.012 * P.area(ri), 'and loses half a millimetre on both sides');
});

test('textures: knurl diamonds, ripple rings, wood lines that never touch, stipple dots that never touch', () => {
  const W = 80, H = 40, box = P.rect(-W / 2, -H / 2, W / 2, H / 2);
  const share = mp => P.area(P.intersection(mp, box)) / (W * H);
  near(share(generatePattern('knurl', { pitch: 2.5, groove: 0.8 }, W, H)), (1.7 / 2.5) ** 2, 0.02, 'knurl: diamonds fill (pitch - groove)^2 / pitch^2');
  near(share(generatePattern('ripple', { pitch: 2.5, width: 1.2 }, W, H)), 1.2 / 2.5, 0.03, 'ripples: rings fill width / pitch');
  for (const seed of [1, 7, 4242]) {
    const lines = generatePattern('wood', { seed }, W, H);
    assert.equal(P.union(...lines.map(p => [p])).length, lines.length, `wood seed ${seed}: no two lines merge`);
    const dots = generatePattern('stipple', { seed }, W, H);
    assert.equal(P.union(...dots.map(p => [p])).length, dots.length, `stipple seed ${seed}: no two dots touch`);
    const centres = dots.map(p => { const b = P.bbox([p]); return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2]; });
    let closest = Infinity;
    for (let i = 0; i < centres.length; i++) for (let j = i + 1; j < centres.length; j++) closest = Math.min(closest, Math.hypot(centres[i][0] - centres[j][0], centres[i][1] - centres[j][1]));
    assert.ok(closest >= 1.1 + 0.8 - 0.05, `stipple seed ${seed}: dots at least 0.8 mm apart (closest centres ${closest.toFixed(2)})`);
  }
  assert.deepEqual(generatePattern('wood', { seed: 3 }, W, H), generatePattern('wood', { seed: 3 }, W, H), 'a seed gives the same grain every time');
  assert.notDeepEqual(generatePattern('wood', { seed: 3 }, W, H), generatePattern('wood', { seed: 4 }, W, H), 'and another seed a different one');
});

test('a texture across a whole plate prints clean: edge slivers are a note, not a failure', () => {
  for (const pattern of ['knurl', 'ripple', 'wood', 'stipple']) for (const op of ['cut', 'raise']) {
    const d = newDesign({ mode: op === 'raise' ? 'up' : 'down', elements: [newElement('pattern', { pattern, op, depth: 0.6, height: 0.6 })] });
    d.handles.mount = 'none'; d.handles.holes = false;
    const bad = checksOf(d).filter(c => c.st === 'fail' || (c.st === 'warn' && c.id !== 'tiny' && c.id !== 'seat'));
    assert.deepEqual(bad.map(c => c.lbl), [], `${pattern} ${op}: ${bad.map(c => c.det).join(' | ')}`);
  }
  // a genuinely thin line that crosses the edge still fails: a 0.15 mm stripe running off the top of the plate
  const art = newElement('svg', { width: 40 });
  art.groups = [{ name: 'line', fill: '#000000', rings: P.rect(-0.075, 0, 0.075, 40), color: 'c2', op: 'raise', height: 1, depth: 0.6, visible: true }];
  art.natural = { w: 40, h: 40 };
  art.y = 10;
  const d = newDesign({ mode: 'up', elements: [art] });
  d.handles.mount = 'none'; d.handles.holes = false;
  assert.ok(checksOf(d).some(c => c.id === 'thin' && c.st === 'fail'), 'a thin line crossing the edge is not an edge sliver');
});

test('fills: a texture inside a border, an outline, crumbs dropped, and the texture moves with the element', () => {
  const shape = newElement('shape', { shape: 'roundrect', w: 40, h: 24, r: 5, fill: 'hex', fillParams: { size: 4, gap: 0.8 }, border: 1, op: 'raise' });
  const local = P.roundRect(-20, -12, 20, 12, 5);
  const filled = applyFill(local, shape, 'test-hex');
  assert.ok(P.area(P.difference(filled, local)) < 0.01, 'the fill stays inside the outline');
  const rim = P.difference(local, offsetPoly(local, -1));
  assert.ok(P.area(P.difference(rim, filled)) < 0.05, 'the 1 mm border is all there');
  assert.ok(P.area(filled) < 0.9 * P.area(local) && P.area(filled) > 0.4 * P.area(local), 'the inside is textured, not solid');
  for (const poly of filled) assert.ok(P.area([poly]) >= 0.3, 'no crumb under 0.3 mm2 is left');
  const outline = applyFill(local, { ...shape, fill: 'outline', border: 1.5 }, 'test-outline');
  near(P.area(outline), P.area(local) - P.area(offsetPoly(local, -1.5)), 0.05, 'an outline is the rim alone');
  assert.ok(outline[0].length === 2, 'a ring with the middle open');
  // placed: the same texture moved with the element
  const at = { ...shape, x: 30, y: -5 };
  const [part] = elementParts(at, size);
  const [origin] = elementParts({ ...shape }, size);
  near(P.area(P.xor(P.translate(origin.poly, 30, -5), part.poly)), 0, 0.05, 'the texture moves with the shape');
  assert.equal(applyFill(local, { ...shape, fill: 'solid' }, 'x'), local, 'solid is the shape itself');
});

test('filled text: letters keep their border, the twin still reads, and the checks name the fill', async () => {
  await T.loadFont('archivo');
  // clear of the screw holes (x = +/- 22): a hole takes a different bite out of a 45 degree texture on each side
  const el = newElement('text', { text: 'Tea', size: 16, op: 'inlay', fill: 'stripes', fillParams: { pitch: 2, width: 1, angle: 45 }, border: 0.8, x: 55 });
  const b = buildFace(newDesign({ symmetry: 'x', elements: [el] }), size);
  const own = b.layers.find(L => L.elementId === el.id && !L.twin), twin = b.layers.find(L => L.elementId === el.id && L.twin);
  const solid = T.textOutline(el).poly;
  assert.ok(P.area(own.poly) < 0.9 * P.area(solid), 'striped letters carry less than solid ones');
  near(P.area(P.xor(P.translate(own.poly, -110, 0), twin.poly)), 0, 0.05, 'the twin is the same striped letters, moved');
  // a hairline outline: the checks say the fill is what is too thin
  const thin = newElement('text', { text: 'Tea', size: 16, op: 'inlay', fill: 'outline', border: 0.3 });
  const d = newDesign({ elements: [thin] });
  const c = checksOf(d).find(x => x.id === 'thin' && x.elementId === thin.id);
  assert.ok(c && c.st === 'fail' && /fill makes pieces 0.3 mm wide/.test(c.det), `${c?.det}`);
});

test('the design file keeps a fill and cleans it; pattern settings from a file are cleaned too', () => {
  const el = newElement('shape', { fill: 'knurl', fillParams: { pitch: 3, groove: 0.9 }, border: 1.2 });
  const back = parseDesign(serializeDesign(newDesign({ elements: [el] }))).elements[0];
  assert.equal(back.fill, 'knurl'); assert.equal(back.border, 1.2);
  assert.equal(back.fillParams.pitch, 3); assert.equal(back.fillParams.groove, 0.9);
  const junk = parseDesign({ elements: [
    { kind: 'shape', fill: 'lava', fillParams: { pitch: 2 } },
    { kind: 'text', fill: 'wood', fillParams: { pitch: 'wide', seed: '12', evil: { toString: null }, anchor: 'nowhere' } },
    { kind: 'pattern', pattern: 'dots', params: { diameter: 3, stagger: 'yes', angle: { toString: null }, extra: 1 } },
  ] }).elements;
  assert.equal(junk[0].fill, 'solid', 'an unknown fill falls back to solid'); assert.deepEqual(junk[0].fillParams, {});
  assert.equal(junk[1].fillParams.pitch, patternDefaults('wood').pitch, 'a bad number falls back');
  assert.equal(junk[1].fillParams.seed, 12, 'a numeric string counts');
  assert.ok(!('evil' in junk[1].fillParams), 'unknown keys are dropped');
  assert.equal(junk[1].fillParams.anchor, 'center', 'a bad choice falls back');
  assert.deepEqual(junk[2].params, { ...patternDefaults('dots'), diameter: 3, stagger: true }, 'pattern settings: kept, cleaned, or defaulted');
  assert.ok(FILL_OPTIONS.every(([k]) => !['truchet', 'tiles', 'waves'].includes(k)), 'linked patterns are not fills');
  assert.ok(!isFilled({ fill: 'truchet' }), 'and do not count as one');
  const tiles = cleanPatternParams('tiles', { tiles: [{ links: [[0, 1]] }], ports: 'mid', width: 2 });
  assert.ok(Array.isArray(tiles.tiles) && tiles.ports === 'mid' && tiles.width === 2, 'the tile editor keeps its tiles');
});

test('a texture too fine for its area stops with a note instead of stalling the page', () => {
  for (const [pattern, params] of [['stipple', { spacing: 0.5, diameter: 0.2 }], ['knurl', { pitch: 0.8, groove: 0.2 }], ['wood', { pitch: 0.5, width: 0.2 }]]) {
    const el = newElement('pattern', { pattern, params, op: 'cut' });
    const t0 = Date.now();
    const b = buildFace(newDesign({ elements: [el] }), SIZE_BY_ID['4W-2H']);
    assert.ok(Date.now() - t0 < 3000, `${pattern} gave up quickly (${Date.now() - t0} ms)`);
    assert.ok(b.notes.some(n => /too fine/.test(n.text)), `${pattern}: ${b.notes.map(n => n.text)}`);
  }
  const ok = buildFace(newDesign({ elements: [newElement('pattern', { pattern: 'stipple', op: 'cut' })] }), SIZE_BY_ID['4W-2H']);
  assert.ok(!ok.notes.some(n => /too fine/.test(n.text)), 'the default stipple fits the largest plate');
});

test('Sol 01a1b359: numbers from a file are held to their ranges; texture widths use the generators own limits', () => {
  const huge = cleanPatternParams('knurl', { phaseX: 1e20, pitch: -5, groove: 1e9 });
  assert.equal(huge.phaseX, 200, 'a huge shift is held to its range'); assert.equal(huge.pitch, 0.8); assert.equal(huge.groove, 5);
  const el = newElement('shape', { w: 30, h: 20, fill: 'knurl', fillParams: { phaseX: 1e20 }, op: 'raise' });
  const t0 = Date.now();
  const d = parseDesign(serializeDesign(newDesign({ mode: 'up', elements: [el] })));
  buildFace(d, size);
  assert.ok(Date.now() - t0 < 3000, 'a crafted shift does not stall the build');
  // ripples 2 mm apart, 3 mm wide: drawn 1.8 mm wide with a 0.2 mm gap, and checked as drawn (no negative gap)
  const rip = newElement('pattern', { pattern: 'ripple', params: { pitch: 2, width: 3 }, op: 'raise', height: 0.6 });
  const g = checksOf(newDesign({ mode: 'up', elements: [rip] })).find(c => c.id === 'groove' && c.elementId === rip.id);
  assert.ok(g && /0.2 mm/.test(g.det) && !/-/.test(g.short), `the gap is the drawn 0.2 mm: ${g?.det}`);
  // and the older patterns the same way: stripes wider than their pitch are drawn as a solid sheet, no negative gap
  const sheet = newElement('pattern', { pattern: 'stripes', params: { pitch: 4, width: 9 }, op: 'raise' });
  const sg = checksOf(newDesign({ mode: 'up', elements: [sheet] })).filter(c => c.elementId === sheet.id);
  assert.ok(!sg.some(c => /-\d/.test(c.det)), `no negative widths: ${sg.map(c => c.det)}`);
});
