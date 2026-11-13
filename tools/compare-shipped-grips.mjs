/* Compares the rebuilt Classic Pro and Classic grips (js/geometry/hoods.js) with the shipped faceplates, on every
 * size: the same slices through both, across the grip at several places along it and through it at several heights,
 * and the area where they disagree. A development check, not part of the app: it reads the shipped models from the
 * viewer repo's GLB Library and decodes them with the planner's meshopt decoder (both read-only).
 *
 * Usage: node tools/compare-shipped-grips.mjs [--library <dir>] [--decoder <meshopt_decoder.module.js>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const LIB = arg('--library', 'D:/Code Projects/GEN2 Visual Animator/GLB Library');
const DEC = arg('--decoder', 'D:/Code Projects/modulith-planner/vendor/three/addons/libs/meshopt_decoder.module.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(pathToFileURL(path.join(ROOT, 'test', 'x.js')));
{ const l = require(path.join(ROOT, 'vendor/polygon-clipping/polygon-clipping.umd.js')); if (l?.union) globalThis.polygonClipping = l; }
const P = await import(pathToFileURL(path.join(ROOT, 'js/geometry/polys.js')));
const { hoodShape } = await import(pathToFileURL(path.join(ROOT, 'js/geometry/hoods.js')));
const { cornerHood, CORNER_HOOD } = await import(pathToFileURL(path.join(ROOT, 'js/geometry/cornerhood.js')));
const { SIZES } = await import(pathToFileURL(path.join(ROOT, 'js/data/sizes.js')));
if (!fs.existsSync(LIB) || !fs.existsSync(DEC)) { console.log(`skipped: needs ${LIB} and ${DEC}`); process.exit(0); }
const { MeshoptDecoder } = await import(pathToFileURL(DEC));
await MeshoptDecoder.ready;

function findGlb(name) {
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { const r = walk(p); if (r) return r; } else if (e.name === `${name}.lib.glb`) return p; } return null; };
  return walk(LIB);
}
function readTris(file) {
  const b = fs.readFileSync(file), jlen = b.readUInt32LE(12), j = JSON.parse(b.slice(20, 20 + jlen).toString());
  const bin = b.slice(28 + jlen, 28 + jlen + b.readUInt32LE(20 + jlen));
  const views = j.bufferViews.map(v => {
    const x = v.extensions?.EXT_meshopt_compression;
    if (!x) return bin.slice(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength);
    const out = new Uint8Array(x.count * x.byteStride);
    MeshoptDecoder.decodeGltfBuffer(out, x.count, x.byteStride, new Uint8Array(bin.buffer, bin.byteOffset + (x.byteOffset || 0), x.byteLength), x.mode, x.filter || 'NONE');
    return Buffer.from(out.buffer);
  });
  const read = ai => {
    const a = j.accessors[ai], v = views[a.bufferView], bv = j.bufferViews[a.bufferView];
    const comps = { SCALAR: 1, VEC3: 3 }[a.type], size = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType];
    const stride = bv.extensions?.EXT_meshopt_compression?.byteStride || bv.byteStride || comps * size, out = [];
    for (let i = 0; i < a.count; i++) for (let c = 0; c < comps; c++) {
      const o = (a.byteOffset || 0) + i * stride + c * size;
      let x = { 5120: () => v.readInt8(o), 5121: () => v.readUInt8(o), 5122: () => v.readInt16LE(o), 5123: () => v.readUInt16LE(o), 5125: () => v.readUInt32LE(o), 5126: () => v.readFloatLE(o) }[a.componentType]();
      if (a.normalized) x = a.componentType === 5122 ? Math.max(x / 32767, -1) : a.componentType === 5120 ? Math.max(x / 127, -1) : x / (a.componentType === 5121 ? 255 : 65535);
      out.push(x);
    }
    return out;
  };
  const tris = [];
  for (const node of j.nodes) {
    if (node.mesh == null) continue;
    const s = node.scale || [1, 1, 1], t = node.translation || [0, 0, 0];
    for (const pr of j.meshes[node.mesh].primitives) {
      const p = read(pr.attributes.POSITION), idx = read(pr.indices);
      for (const k of idx) tris.push(p[3 * k] * s[0] + t[0], p[3 * k + 1] * s[1] + t[1], p[3 * k + 2] * s[2] + t[2]);
    }
  }
  return tris;
}
function slice(tris, axis, value) {
  const [A, B] = [[1, 2], [0, 2], [0, 1]][axis], segs = [];
  for (let i = 0; i < tris.length; i += 9) {
    const Pt = [0, 3, 6].map(o => [tris[i + o], tris[i + o + 1], tris[i + o + 2]]), d = Pt.map(p => p[axis] - value), pts = [];
    for (let e = 0; e < 3; e++) { const p = Pt[e], q = Pt[(e + 1) % 3], dp = d[e], dq = d[(e + 1) % 3]; if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) { const f = dp / (dp - dq); pts.push([p[A] + (q[A] - p[A]) * f, p[B] + (q[B] - p[B]) * f]); } }
    if (pts.length === 2) segs.push(pts);
  }
  // chain into closed loops (endpoints matched by distance, not by a rounded key, which splits points that straddle
  // a rounding boundary), then even-odd into a MultiPolygon
  const cell = 1e-3, grid = new Map(), ck = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  segs.forEach((sg, i) => sg.forEach((p, end) => { const k = ck(p[0], p[1]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push([i, end]); }));
  const used = new Set();
  const near = (p) => {
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell);
    let best = null, bd = 1e-4;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const [i, end] of grid.get(`${cx + dx},${cy + dy}`) || []) {
      if (used.has(i)) continue;
      const q = segs[i][end], dd = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (dd <= bd) { bd = dd; best = [i, end]; }
    }
    return best;
  };
  let mp = [];
  for (let i = 0; i < segs.length; i++) {
    if (used.has(i)) continue;
    used.add(i); const line = [segs[i][0], segs[i][1]];
    for (;;) { const n = near(line[line.length - 1]); if (!n) break; used.add(n[0]); line.push(segs[n[0]][1 - n[1]]); }
    const a = line[0], b = line[line.length - 1];
    if (line.length > 3 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-3) mp = mp.length ? P.xor(mp, [[line]]) : [[line]];
  }
  return mp;
}

const FAMILIES = [['classicpro', 'ClassicPro', -8.25], ['classic', 'ClassicDecor', -8.4]];
let worst = 0, skipped = 0, compared = 0;
for (const [style, fam, faceZ] of FAMILIES) {
  for (const size of SIZES) {
    const file = findGlb(`Faceplate_${fam}_${size.id}`);
    if (!file) { console.log(`${fam} ${size.id}: no model`); continue; }
    const shipped = readTris(file);
    let H = -Infinity; for (let i = 1; i < shipped.length; i += 3) H = Math.max(H, shipped[i]);
    // where the grip sits: the top 27 mm, but the bottom half of a Classic 1H
    const top = style === 'classic' && /-1H$/.test(size.id) ? 27 : H;
    const g = hoodShape({ style }, 2 * Math.max(...shipped.filter((_, i) => i % 3 === 0)));
    const ours = [...g.tris, ...(g.accent ? g.accent.tris : [])];
    for (let i = 0; i < ours.length; i += 3) { ours[i + 1] += top - 13.5; ours[i + 2] += faceZ; }
    const front = P.rect(-1e3, faceZ + 0.02, 1e3, 1e3);
    const W = size.w, lines = [];
    for (const x of [0.37, W / 4, W / 2 - 25, W / 2 - 10, W / 2 - 3]) {
      let a, b;
      try { a = P.intersection(slice(shipped, 0, x), front); b = P.intersection(slice(ours, 0, x), front); } catch (e) { lines.push(`x=${x.toFixed(1)}: could not compare (${e.message.slice(0, 40)})`); skipped++; continue; }
      let off; try { off = P.area(P.xor(a, b)); } catch (e) { lines.push(`x=${x.toFixed(1)}: could not compare`); skipped++; continue; }
      const ref = Math.max(P.area(a), 1e-9);
      worst = Math.max(worst, off / ref); compared++;
      lines.push(`x=${x.toFixed(1)}: shipped ${P.area(a).toFixed(1)} ours ${P.area(b).toFixed(1)} differ ${off.toFixed(2)} mm2 (${(100 * off / ref).toFixed(1)}%)`);
    }
    for (const dz of [1, 8, 16, 21.5]) {
      let a, b, off;
      try { a = slice(shipped, 2, faceZ + dz); b = slice(ours, 2, faceZ + dz); off = P.area(P.xor(a, b)); } catch (e) { lines.push(`z=face+${dz}: could not compare (${e.message.slice(0, 40)})`); skipped++; continue; }
      const ref = Math.max(P.area(a), 1e-9);
      worst = Math.max(worst, off / ref); compared++;
      lines.push(`z=face+${dz}: shipped ${P.area(a).toFixed(1)} ours ${P.area(b).toFixed(1)} differ ${off.toFixed(2)} mm2 (${(100 * off / ref).toFixed(1)}%)`);
    }
    console.log(`${fam} ${size.id}\n  ${lines.join('\n  ')}`);
  }
}
// EdgeLabel: the corner hood (one per 2W from the right) above the grip's 2 mm band (Z 6.5 above the back)
{
  const hood = cornerHood();
  for (const size of SIZES) {
    const file = findGlb(`Faceplate_EdgeLabel_${size.id}`);
    if (!file) { console.log(`EdgeLabel ${size.id}: no model`); continue; }
    const shipped = readTris(file);
    let back = Infinity, H = -Infinity, X = -Infinity;
    for (let i = 0; i < shipped.length; i += 3) { back = Math.min(back, shipped[i + 2]); H = Math.max(H, shipped[i + 1]); X = Math.max(X, shipped[i]); }
    const band = back + 6.5, ours = [];
    for (const dx of size.w > 2 * 88 ? [0, -CORNER_HOOD.pitch] : [0]) for (let i = 0; i < hood.tris.length; i += 3) ours.push(hood.tris[i] + X + dx, hood.tris[i + 1] + H, hood.tris[i + 2] + band);
    const lines = [];
    const above = P.rect(-1e3, band + 0.05, 1e3, 1e3);
    for (const dz of [0.3, 1.5, 4, 8, 12, 15, 17.3]) {
      let a, b, off;
      try { a = slice(shipped, 2, band + dz); b = slice(ours, 2, band + dz); off = P.area(P.xor(a, b)); } catch (e) { lines.push(`h=${dz}: could not compare`); skipped++; continue; }
      const ref = Math.max(P.area(a), 1e-9); worst = Math.max(worst, off / ref); compared++;
      lines.push(`h=${dz}: shipped ${P.area(a).toFixed(1)} ours ${P.area(b).toFixed(1)} differ ${off.toFixed(2)} mm2 (${(100 * off / ref).toFixed(1)}%)`);
    }
    for (const xc of [-8, -22, -40]) {
      let a, b, off;
      try { a = P.intersection(slice(shipped, 0, X + xc), above); b = P.intersection(slice(ours, 0, X + xc), above); off = P.area(P.xor(a, b)); } catch (e) { lines.push(`x=corner${xc}: could not compare`); skipped++; continue; }
      const ref = Math.max(P.area(a), 1e-9); worst = Math.max(worst, off / ref); compared++;
      lines.push(`x=corner${xc}: shipped ${P.area(a).toFixed(1)} ours ${P.area(b).toFixed(1)} differ ${off.toFixed(2)} mm2 (${(100 * off / ref).toFixed(1)}%)`);
    }
    console.log(`EdgeLabel ${size.id}\n  ${lines.join('\n  ')}`);
  }
}
console.log(`${compared} slices compared, ${skipped} could not be; worst disagreement: ${(100 * worst).toFixed(2)}% of the shipped slice`);
