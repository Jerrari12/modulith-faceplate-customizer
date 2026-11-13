// Pins the image element (2026-11-06): a picture kept as greyscale in the design, split into nested tones by smooth
// iso-contours, cleaned of specks, and built as stepped raises, stepped cuts or colour inlays; the file format
// refuses a picture whose pixels do not add up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;

const P = await import('../js/geometry/polys.js');
const I = await import('../js/geometry/image.js');
const { buildFace, newElement } = await import('../js/geometry/face.js');
const { runChecks } = await import('../js/checks/checks.js');
const { newDesign, serializeDesign, parseDesign } = await import('../js/export/design.js');
const { SIZE_BY_ID } = await import('../js/data/sizes.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);
const size = SIZE_BY_ID['2W-1H'];

/** A greyscale picture from a function of the pixel (0 black .. 255 white), through the import path. */
function picture(w, h, fn, alpha = () => 255) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const o = 4 * (j * w + i), v = fn(i, j); rgba[o] = rgba[o + 1] = rgba[o + 2] = v; rgba[o + 3] = alpha(i, j); }
  return I.imageFromRGBA(rgba, w, h);
}
const disc = (r, w = 64) => picture(w, w, (i, j) => (Math.hypot(i + 0.5 - w / 2, j + 0.5 - w / 2) < r ? 0 : 255));
const img = (data, o = {}) => newElement('image', { data, width: data.w, steps: 1, smooth: 0, minPiece: 0, op: 'raise', ...o });

test('the stored picture: transparent is paper, the tones are stretched, and the bytes round-trip', () => {
  const d = picture(4, 1, i => [0, 255, 100, 200][i], i => (i === 0 ? 0 : 255));
  const g = I.b64ToBytes(d.g);
  assert.equal(g[0], 255, 'a transparent black pixel is white paper');
  assert.equal(Math.min(...g), 0, 'the darkest tone is stretched to black');
  assert.deepEqual(I.cleanImageData(d), d);
  assert.equal(I.cleanImageData({ ...d, w: 5 }), null, 'bytes that do not fill w x h are refused');
  assert.equal(I.cleanImageData({ w: 300, h: 1, g: d.g }), null, 'over 256 px is refused');
  assert.equal(I.cleanImageData({ w: 2, h: 2, g: '***' }), null, 'not base64 is refused');
});

test('outlines are smooth iso-contours: a disc keeps its area; a bullseye keeps its hole and its dot', () => {
  const b = I.imageTones(img(disc(20)));
  assert.equal(b.tones.length, 1);
  near(P.area(b.tones[0]), Math.PI * 400, 0.01 * Math.PI * 400, 'disc area within 1 %');
  const bb = P.bbox(b.tones[0]);
  near((bb.x0 + bb.x1) / 2, 0, 0.05, 'centred across'); near((bb.y0 + bb.y1) / 2, 0, 0.05, 'centred up and down');
  const bull = picture(64, 64, (i, j) => { const r = Math.hypot(i + 0.5 - 32, j + 0.5 - 32); return r < 5 || (r > 10 && r < 20) ? 0 : 255; });
  const t = I.imageTones(img(bull)).tones[0];
  assert.equal(t.length, 2, 'the ring and the dot');
  assert.deepEqual(t.map(p => p.length).sort(), [1, 2], 'the ring has one hole, the dot none');
  assert.ok(P.contains(t, 0, 0) && !P.contains(t, 7.5, 0) && P.contains(t, 15, 0), 'dot in, gap out, ring in');
});

test('tones nest, the picture is placed upright, specks and pin holes go', () => {
  // dark on the right: tone 1 reaches furthest left, each darker tone lies inside the one before
  const grad = picture(120, 40, i => Math.round(255 * (1 - i / 119)));
  const tones = I.imageTones(img(grad, { steps: 3 })).tones;
  const areas = tones.map(t => P.area(t));
  assert.ok(areas[0] > areas[1] && areas[1] > areas[2], `areas fall: ${areas.map(a => a.toFixed(0))}`);
  for (let k = 1; k < 3; k++) assert.ok(P.area(P.difference(tones[k], tones[k - 1])) < 0.01 * areas[k], `tone ${k + 1} lies inside tone ${k}`);
  assert.ok(P.bbox(tones[2]).x0 > 0, 'the darkest tone is on the right');
  // upright: a dark block in the top-left of the picture is top-left on the plate
  const corner = picture(40, 20, (i, j) => (i < 10 && j < 5 ? 0 : 255));
  const cb = P.bbox(I.imageTones(img(corner)).tones[0]);
  assert.ok(cb.x1 < 0 && cb.y0 > 0, 'top-left stays top-left');
  // specks: single dark pixels and single pale pixels in a dark field
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const noisy = picture(100, 100, (i, j) => { const inDisc = Math.hypot(i - 50, j - 50) < 30; return rnd() < 0.04 ? (inDisc ? 255 : 0) : (inDisc ? 0 : 255); });
  const raw = I.imageTones(img(noisy, { id: 'raw' }));
  const clean = I.imageTones(img(noisy, { minPiece: 2.5 }));   // about 2.5 mm across: clusters of pale pixels go too
  assert.ok(raw.tones[0].length > 20, `the raw picture is full of specks (${raw.tones[0].length} pieces)`);
  assert.equal(clean.tones[0].length, 1, 'smallest piece 2.5 mm leaves one piece');
  assert.equal(clean.tones[0][0].length, 1, 'and fills its pin holes');
});

test('a hard edge leaves no halo: anti-aliased edge pixels join the ink, and the picture edge is one line for every tone', () => {
  // a black disc whose edge pixels are grey by how much of them it covers (as any exported logo is)
  const cover = (i, j) => { let c = 0; for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) c += Math.hypot(i + (a + 0.5) / 4 - 40, j + (b + 0.5) / 4 - 40) < 25 ? 1 : 0; return c / 16; };
  const logo = picture(80, 80, (i, j) => Math.round(255 * (1 - cover(i, j))));
  const el = img(logo, { steps: 3, op: 'inlay', width: 40, minPiece: 1, smooth: 0, stepColors: ['c2', 'c3', 'c2'] });
  const tones = I.imageTones(el).tones;
  const a = tones.map(t => P.area(t));
  near(a[0], a[2], 0.01 * a[2], 'the palest tone is no bigger than the ink: no halo band');
  const d = newDesign({ mode: 'down', elements: [el] });
  const res = runChecks(buildFace(d, size), d, size);
  assert.ok(!res.checks.some(c => c.id === 'inlay' && c.st !== 'pass'), `no thin inlay pieces: ${res.checks.filter(c => c.id === 'inlay').map(c => c.det)}`);
  // a gradient running off the picture's edge: every tone stops on the same line there
  const grad = picture(60, 20, i => Math.round(255 * (1 - i / 59)));
  const gt = I.imageTones(img(grad, { steps: 3, minPiece: 0 })).tones.map(t => P.bbox(t));
  for (const b of gt) { near(b.y0, gt[0].y0, 1e-9, 'bottom edge shared'); near(b.y1, gt[0].y1, 1e-9, 'top edge shared'); near(b.x1, gt[0].x1, 1e-9, 'right edge shared'); }
  near(gt[0].y1 - gt[0].y0, 20, 1e-9, 'and that line is the picture edge');
});

test('the builder: raise steps up, cut steps down, inlay sets each tone in its own colour', () => {
  const grad = picture(60, 30, i => Math.round(255 * (1 - i / 59)));
  const run = o => { const el = img(grad, { steps: 3, height: 0.5, depth: 0.4, stepColors: ['c2', 'c3', 'c1'], ...o }); return { el, b: buildFace(newDesign({ mode: 'up', elements: [el] }), size) }; };
  const r = run({ op: 'raise' });
  const tops = [...new Set(r.b.layers.filter(L => L.elementId === r.el.id).map(L => +(L.z1 - 2).toFixed(6)))].sort();
  assert.deepEqual(tops, [0.5, 1, 1.5], 'three steps of 0.5 mm');
  assert.ok(r.b.layers.filter(L => L.elementId === r.el.id).every(L => L.z0 === 2), 'every step stands on the face');
  const c = run({ op: 'cut' });
  const floors = [...new Set(c.b.layers.filter(L => L.kind === 'slab').map(L => +L.z1.toFixed(6)))].sort();
  assert.ok([0.8, 1.2, 1.6].every(z => floors.includes(z)), `the face steps down 0.4 mm a tone: ${floors}`);
  const i = run({ op: 'inlay', depth: 0.6 });
  const inl = i.b.layers.filter(L => L.elementId === i.el.id);
  assert.ok(inl.every(L => L.inlay && L.z1 === 2 && Math.abs(L.z0 - 1.4) < 1e-9), 'inlaid flush, 0.6 mm thick');
  assert.deepEqual([...new Set(inl.map(L => L.color))].sort(), ['c1', 'c2', 'c3'], 'each tone in its own colour');
  for (const L of inl) for (const M of inl) if (L !== M) assert.ok(P.area(P.intersection(L.poly, M.poly)) < 0.01, 'tones do not overlap');
});

test('the design file keeps the picture and its tone colours, and drops an image without pixels', () => {
  const el = img(disc(10, 32), { steps: 2, op: 'inlay', stepColors: ['c3', 'c2'], invert: true, balance: 0.1 });
  const back = parseDesign(serializeDesign(newDesign({ elements: [el] }))).elements[0];
  assert.deepEqual(back.data, el.data);
  assert.deepEqual(back.stepColors, ['c3', 'c2']);
  assert.equal(back.invert, true); assert.equal(back.balance, 0.1); assert.equal(back.op, 'inlay');
  const junk = parseDesign({ elements: [{ kind: 'image', data: { w: 4, h: 4, g: 'AAAA' } }, { kind: 'image' }, { kind: 'image', data: el.data, stepColors: [{ toString: null }, 'c2'] }] }).elements;
  assert.equal(junk.length, 1, 'pictures whose pixels do not add up, or are missing, are dropped');
  assert.deepEqual(junk[0].stepColors, ['c2', 'c2'], 'a tone colour that is not a string falls back');
  const a = newElement('image'), b = newElement('image');
  a.stepColors.push('c3');
  assert.deepEqual(b.stepColors, [], 'new elements never share a default array');
});

test('checks: a stepped raise cannot print face down; inlaid tones can', () => {
  const grad = picture(60, 30, i => Math.round(255 * (1 - i / 59)));
  const raise = img(grad, { steps: 3, op: 'raise' });
  const d = newDesign({ mode: 'down', elements: [raise] });
  const res = runChecks(buildFace(d, size), d, size);
  assert.ok(res.checks.some(c => c.st === 'fail' && (c.id === 'levels' || c.id === 'bridge')), 'face down, steps at three heights fail');
  const inlay = img(grad, { steps: 3, op: 'inlay', stepColors: ['c2', 'c3', 'c2'] });
  const d2 = newDesign({ mode: 'down', elements: [inlay] });
  const res2 = runChecks(buildFace(d2, size), d2, size);
  assert.equal(res2.status, 'pass', `inlaid tones print face down: ${res2.checks.filter(c => c.st !== 'pass' && c.st !== 'info').map(c => c.det)}`);
});

test('a busy photo in four inlaid tones prints: no band too thin, no crumbs counted, tones still nested', () => {
  let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const photo = picture(256, 192, (i, j) => Math.max(0, Math.min(255, Math.round(128 + 70 * Math.sin(i / 17) * Math.cos(j / 23) + 40 * Math.sin((i + j) / 7) + 30 * (rnd() - 0.5)))));
  const el = newElement('image', { data: photo, width: 60, steps: 4, op: 'inlay', smooth: 0.3, minPiece: 1, stepColors: ['c2', 'c3', 'c2', 'c3'] });
  const tones = I.imageTones(el).tones;
  for (let k = 1; k < tones.length; k++) assert.ok(P.area(P.difference(tones[k], tones[k - 1])) < 0.01 * P.area(tones[k]) + 0.05, `tone ${k + 1} inside tone ${k}`);
  const d = newDesign({ mode: 'down', elements: [el] });
  const res = runChecks(buildFace(d, size), d, size);
  assert.equal(res.status, 'pass', res.checks.filter(c => c.st === 'fail' || c.st === 'warn').map(c => c.det).join(' | '));
});

test('Sol 01a1b291: numbers from a file are held to their ranges, a thin picture keeps its tiny width, the cache is bounded', () => {
  const el = img(disc(10, 32), { steps: 2, minPiece: 1e6, smooth: 1e6 });
  const body = I.imageTones(el);
  assert.ok(body && body.tones.length === 2, 'a huge smallest piece and smoothing still build');
  // a 1 x 64 px picture at 0.16 mm wide is 10.24 mm tall, not stretched to a 1 mm width
  const thin = picture(1, 64, () => 0);
  const tb = I.imageTones(img(thin, { width: 0.16 }));
  near(tb.height, 10.24, 1e-9, 'height follows the tiny width');
  for (let i = 0; i < 30; i++) I.imageTones(img(disc(8, 24), { id: `cache${i}` }));
  assert.ok(I.imageCacheSize() <= 12, `the cache holds at most 12 pictures (${I.imageCacheSize()})`);
});
