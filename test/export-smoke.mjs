// Writes a real 3MF for one size (the way the Export view does) so it can be opened or sliced outside the
// browser. Usage: node test/export-smoke.mjs [sizeId] [outDir]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js'); if (pcLib?.union) globalThis.polygonClipping = pcLib;
const zipLib = require('../vendor/jszip/jszip.min.js'); if (zipLib?.loadAsync) globalThis.JSZip = zipLib;

const { buildFace, newElement, faceTriangles } = await import('../js/geometry/face.js');
const { extrudeMultiPolygon } = await import('../js/geometry/extrude.js');
const { parseBacker, backerTriangles } = await import('../js/geometry/backer.js');
const { buildPrusa3MF } = await import('../js/export/threemf.js');
const { orientForPrint, BEDS, prusaBedFor } = await import('../js/export/orient.js');
const { newDesign } = await import('../js/export/design.js');
const { SIZE_BY_ID } = await import('../js/data/sizes.js');
const { runChecks } = await import('../js/checks/checks.js');

const sizeId = process.argv[2] || '2W-1H';
const outDir = process.argv[3] || path.resolve('test', 'out');
fs.mkdirSync(outDir, { recursive: true });
const size = SIZE_BY_ID[sizeId];
const design = newDesign({ name: 'Smoke chevron' });
design.elements.push(newElement('pattern', { name: 'Chevron grooves', pattern: 'chevron', op: 'cut', depth: 2, invert: true }));
design.elements.push(newElement('shape', { name: 'Badge', shape: 'circle', w: 12, op: 'raise', height: 1, color: 'c2', anchor: 'tr', x: -12, y: -10 }));

const built = buildFace(design, size);
const checks = runChecks(built, design, size);
console.log(`${sizeId}: ${built.layers.length} layers, checks ${checks.status}: ${checks.checks.filter(c => c.st !== 'pass').map(c => `${c.st} ${c.lbl}`).join('; ') || 'all pass'}`);

const bk = parseBacker(fs.readFileSync(path.resolve('assets', 'backers', `${sizeId}.bin`)).buffer.slice(0));
const bodies = [{ name: `${sizeId} Backer`, tris: backerTriangles(bk), color: 'backer' }];
const byColor = new Map();
for (const L of built.layers) { if (!byColor.has(L.color)) byColor.set(L.color, []); extrudeMultiPolygon(L.poly, L.z0, L.z1, byColor.get(L.color)); }
for (const [color, tris] of byColor) bodies.push({ name: `${sizeId} ${color}`, tris, color });
const zTop = Math.max(built.t, ...built.layers.map(L => L.z1));
const bedKey = prusaBedFor(size);
for (const b of bodies) orientForPrint(b.tris, 'down', zTop, BEDS[bedKey]);
const ini = fs.readFileSync(path.resolve(BEDS[bedKey].profile), 'utf8');
const parts = bodies.map(b => ({ name: b.name, tris: b.tris, extruder: design.colors.findIndex(c => c.id === b.color) + 1 }));
const blob = await buildPrusa3MF({ bodies: parts, name: `Smoke ${sizeId}`, profileIni: ini });
const file = path.join(outDir, `smoke-${sizeId}.3mf`);
fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
console.log(`wrote ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} KB, ${parts.length} parts, bed ${bedKey})`);
