// Loads the fixed Essential backer meshes (assets/backers/<size>.bin), extracted from Joey's Essential v2602
// STLs: the 4.2 mm backer with its drawer clips and compliant mechanisms, in the face-up frame (front plane at
// z = 0, back at z = -4.2, plate centred on the origin). Format: "FPBK", uint32 nVerts, uint32 nTris,
// float32 xyz * nVerts, uint32 abc * nTris, little-endian.

const cache = new Map();

export function parseBacker(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'FPBK') throw new Error('Not a backer mesh file');
  const nV = dv.getUint32(4, true), nT = dv.getUint32(8, true);
  const positions = new Float32Array(buf.slice(12, 12 + nV * 12));
  const indices = new Uint32Array(buf.slice(12 + nV * 12, 12 + nV * 12 + nT * 12));
  return { positions, indices, nVerts: nV, nTris: nT };
}

export async function loadBacker(sizeId, baseUrl = 'assets/backers/') {
  if (cache.has(sizeId)) return cache.get(sizeId);
  const p = fetch(`${baseUrl}${sizeId}.bin`).then(r => {
    if (!r.ok) throw new Error(`Backer mesh for ${sizeId} failed to load (${r.status})`);
    return r.arrayBuffer();
  }).then(parseBacker);
  cache.set(sizeId, p);
  return p;
}

/** Expand an indexed backer into a flat, non-indexed triangle list (x,y,z per vertex) for export. */
export function backerTriangles(b) {
  const out = new Float32Array(b.nTris * 9);
  for (let t = 0, o = 0; t < b.nTris; t++) {
    for (let k = 0; k < 3; k++) {
      const v = b.indices[t * 3 + k] * 3;
      out[o++] = b.positions[v]; out[o++] = b.positions[v + 1]; out[o++] = b.positions[v + 2];
    }
  }
  return out;
}
