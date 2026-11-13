// Mesh import for sculpted art (Nomad Sculpt, Blender, anything that writes STL or OBJ) and the packing that
// keeps a mesh inside a design file. No three.js here so the parsers run in Node tests too.
//
// A parsed mesh is { positions: Float32Array (xyz per vertex), indices: Uint32Array (3 per triangle) }.

const td = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

/** Weld exactly-equal vertices (to 1e-4 mm) of a flat triangle list into an indexed mesh. */
export function weld(tris) {
  const map = new Map(), pos = [], idx = [];
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1], z = tris[i + 2];
    const k = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let v = map.get(k);
    if (v === undefined) { v = pos.length / 3; map.set(k, v); pos.push(x, y, z); }
    idx.push(v);
  }
  // drop degenerate triangles
  const out = [];
  for (let i = 0; i < idx.length; i += 3) { const a = idx[i], b = idx[i + 1], c = idx[i + 2]; if (a !== b && b !== c && a !== c) out.push(a, b, c); }
  return { positions: new Float32Array(pos), indices: new Uint32Array(out) };
}

function parseAsciiStl(text) {
  const tris = [];
  const re = /vertex\s+([-+\deE.]+)\s+([-+\deE.]+)\s+([-+\deE.]+)/g;
  let m;
  while ((m = re.exec(text))) tris.push(+m[1], +m[2], +m[3]);
  if (tris.length % 9) tris.length -= tris.length % 9;
  return tris;
}

/** STL, binary or ASCII, from an ArrayBuffer. */
export function parseStl(buf) {
  const bytes = new Uint8Array(buf);
  const head = td ? td.decode(bytes.subarray(0, Math.min(bytes.length, 512))) : String.fromCharCode(...bytes.subarray(0, 80));
  const nFaces = bytes.length >= 84 ? new DataView(buf).getUint32(80, true) : 0;
  const binaryLength = 84 + nFaces * 50;
  if (bytes.length >= 84 && binaryLength === bytes.length) {
    const dv = new DataView(buf);
    const tris = new Float32Array(nFaces * 9);
    for (let f = 0, o = 84; f < nFaces; f++, o += 50) {
      for (let k = 0; k < 9; k++) tris[f * 9 + k] = dv.getFloat32(o + 12 + k * 4, true);
    }
    return weld(tris);
  }
  if (/^\s*solid/i.test(head) || /facet\s+normal/i.test(head)) {
    const text = td ? td.decode(bytes) : String.fromCharCode(...bytes);
    const tris = parseAsciiStl(text);
    if (!tris.length) throw new Error('No triangles found in the STL');
    return weld(tris);
  }
  throw new Error('Not a binary or ASCII STL (size does not match its triangle count)');
}

/** Wavefront OBJ: v and f records only; polygons are fan-triangulated; negative indices allowed. */
export function parseObj(text) {
  const verts = [], idx = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('v ')) {
      const p = line.split(/\s+/);
      verts.push(+p[1], +p[2], +p[3]);
    } else if (line.startsWith('f ')) {
      const p = line.split(/\s+/).slice(1).map(tok => { const n = parseInt(tok.split('/')[0], 10); return n < 0 ? verts.length / 3 + n : n - 1; });
      for (let i = 1; i + 1 < p.length; i++) idx.push(p[0], p[i], p[i + 1]);
    }
  }
  if (!idx.length) throw new Error('No faces found in the OBJ');
  const tris = new Float32Array(idx.length * 3);
  for (let i = 0; i < idx.length; i++) { const v = idx[i] * 3; tris[i * 3] = verts[v]; tris[i * 3 + 1] = verts[v + 1]; tris[i * 3 + 2] = verts[v + 2]; }
  return weld(tris);
}

/** Pick a parser by file name. */
export function parseMeshFile(name, buf) {
  if (/\.obj$/i.test(name)) return parseObj(td ? td.decode(new Uint8Array(buf)) : String.fromCharCode(...new Uint8Array(buf)));
  if (/\.stl$/i.test(name)) return parseStl(buf);
  throw new Error('Only STL and OBJ files can be imported');
}

export function meshBounds(mesh) {
  const p = mesh.positions;
  const b = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < b.x0) b.x0 = p[i]; if (p[i] > b.x1) b.x1 = p[i];
    if (p[i + 1] < b.y0) b.y0 = p[i + 1]; if (p[i + 1] > b.y1) b.y1 = p[i + 1];
    if (p[i + 2] < b.z0) b.z0 = p[i + 2]; if (p[i + 2] > b.z1) b.z1 = p[i + 2];
  }
  return b;
}

// ---- base64 packing for design files (positions as float32, indices as uint32)
function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64) {
  if (typeof Buffer !== 'undefined') { const b = Buffer.from(b64, 'base64'); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice(); }
  const s = atob(b64); const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function packMesh(mesh) {
  return { v: toBase64(new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength)), i: toBase64(new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength)), nv: mesh.positions.length / 3, nt: mesh.indices.length / 3 };
}

export function unpackMesh(packed) {
  const v = fromBase64(packed.v), i = fromBase64(packed.i);
  return { positions: new Float32Array(v.buffer, v.byteOffset, v.byteLength / 4), indices: new Uint32Array(i.buffer, i.byteOffset, i.byteLength / 4) };
}

/** Expand an indexed mesh to a flat triangle array. */
export function flatten(mesh) {
  const out = new Float32Array(mesh.indices.length * 3);
  for (let i = 0; i < mesh.indices.length; i++) { const v = mesh.indices[i] * 3; out[i * 3] = mesh.positions[v]; out[i * 3 + 1] = mesh.positions[v + 1]; out[i * 3 + 2] = mesh.positions[v + 2]; }
  return out;
}

/** Binary STL bytes for a flat triangle array (used to make sample files). */
export function toBinaryStl(tris, header = 'MODULITH Faceplate Customizer sample') {
  const nT = Math.floor(tris.length / 9);
  const buf = new ArrayBuffer(84 + nT * 50), dv = new DataView(buf);
  for (let i = 0; i < Math.min(80, header.length); i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, nT, true);
  for (let t = 0, o = 84; t < nT; t++, o += 50) {
    const a = tris.subarray ? tris.subarray(t * 9, t * 9 + 9) : tris.slice(t * 9, t * 9 + 9);
    const ux = a[3] - a[0], uy = a[4] - a[1], uz = a[5] - a[2], vx = a[6] - a[0], vy = a[7] - a[1], vz = a[8] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const L = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(o, nx / L, true); dv.setFloat32(o + 4, ny / L, true); dv.setFloat32(o + 8, nz / L, true);
    for (let k = 0; k < 9; k++) dv.setFloat32(o + 12 + k * 4, a[k], true);
    dv.setUint16(o + 48, 0, true);
  }
  return buf;
}
