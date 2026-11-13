// Writes assets/samples/sample-dome.stl: a 30 x 20 mm elliptical dome 6 mm tall on a 1 mm plinth, Y up as a
// sculpting app would export it. Neutral test art for the Mesh import (no undercuts, prints face up).
import fs from 'node:fs';
import path from 'node:path';
import { toBinaryStl } from '../js/geometry/meshio.js';

const RX = 15, RY = 10, H = 6, PL = 1, SEG = 48, RINGS = 12;
const tris = [];
const push = (...pts) => { for (const p of pts) tris.push(p[0], p[2], -p[1]); };   // (x, y, z) z-up -> Y-up file: (x, z, -y)
// plinth: a flat elliptical disc extruded PL
const ring = k => { const a = (k / SEG) * 2 * Math.PI; return [RX * Math.cos(a), RY * Math.sin(a)]; };
for (let k = 0; k < SEG; k++) {
  const [ax, ay] = ring(k), [bx, by] = ring(k + 1);
  push([0, 0, 0], [bx, by, 0], [ax, ay, 0]);                       // bottom (facing down)
  push([ax, ay, 0], [bx, by, 0], [bx, by, PL]); push([ax, ay, 0], [bx, by, PL], [ax, ay, PL]);   // wall
}
// dome: rings from the plinth top up to the apex
const dome = (r, k) => { const a = (k / SEG) * 2 * Math.PI, phi = (r / RINGS) * Math.PI / 2; return [RX * Math.cos(phi) * Math.cos(a), RY * Math.cos(phi) * Math.sin(a), PL + H * Math.sin(phi)]; };
for (let r = 0; r < RINGS; r++) for (let k = 0; k < SEG; k++) {
  const a = dome(r, k), b = dome(r, k + 1), c = dome(r + 1, k + 1), d = dome(r + 1, k);
  if (r + 1 === RINGS) push(a, b, [0, 0, PL + H]); else { push(a, b, c); push(a, c, d); }
}
const out = path.resolve('assets', 'samples', 'sample-dome.stl');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(toBinaryStl(new Float32Array(tris))));
console.log(`wrote ${out}: ${tris.length / 9} triangles`);
