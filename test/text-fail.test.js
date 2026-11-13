// A font that cannot be read (Sol 01a1b23d): the builder must report it as missing from the print, including in a
// rebuild the app runs from inside the font-loaded event, never stay on "loading". Its own file, because it swaps
// in a font reader that always fails before any font loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;
globalThis.opentype = { parse: () => { throw new Error('not a font file'); } };

const T = await import('../js/geometry/text.js');
const { buildFace, newElement } = await import('../js/geometry/face.js');
const { runChecks } = await import('../js/checks/checks.js');
const { newDesign } = await import('../js/export/design.js');
const { SIZE_BY_ID } = await import('../js/data/sizes.js');

test('a font that fails to load fails the checks, even for a rebuild run inside the font event', async () => {
  const el = newElement('text', { text: 'Lost', font: 'bungee' });
  const d = newDesign({ elements: [el] }), size = SIZE_BY_ID['2W-1H'];
  const seen = [];
  T.onFontLoaded(() => { seen.push(buildFace(d, size).notes.map(n => `${n.level}: ${n.text}`)); });
  assert.ok(buildFace(d, size).notes.some(n => /loading the Bungee font/.test(n.text)), 'loading first');
  await T.ensureFonts(d);
  assert.equal(seen.length, 1, 'the listener heard once');
  assert.ok(seen[0].some(s => /^fail: .*could not be loaded/.test(s)), `inside the event the build says it failed: ${seen[0]}`);
  const b = buildFace(d, size);
  const res = runChecks(b, d, size);
  assert.ok(res.checks.some(c => c.st === 'fail' && c.lbl === 'Missing from the print'), 'and the checks fail');
});
