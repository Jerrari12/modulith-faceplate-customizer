// Binary STL from flat triangle arrays (x,y,z x3 per triangle).

export function stlBuffer(trisList) {
  let nT = 0;
  for (const t of trisList) nT += Math.floor(t.length / 9);
  const buf = new ArrayBuffer(84 + nT * 50);
  const dv = new DataView(buf);
  const header = 'MODULITH Faceplate Customizer binary STL';
  for (let i = 0; i < Math.min(80, header.length); i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, nT, true);
  let off = 84;
  for (const tris of trisList) {
    for (let i = 0; i + 8 < tris.length; i += 9) {
      const ax = tris[i], ay = tris[i + 1], az = tris[i + 2], bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5], cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
      dv.setFloat32(off, nx, true); dv.setFloat32(off + 4, ny, true); dv.setFloat32(off + 8, nz, true); off += 12;
      for (const [x, y, z] of [[ax, ay, az], [bx, by, bz], [cx, cy, cz]]) { dv.setFloat32(off, x, true); dv.setFloat32(off + 4, y, true); dv.setFloat32(off + 8, z, true); off += 12; }
      dv.setUint16(off, 0, true); off += 2;
    }
  }
  return buf;
}

export function stlBlob(trisList) {
  return new Blob([stlBuffer(trisList)], { type: 'application/octet-stream' });
}
