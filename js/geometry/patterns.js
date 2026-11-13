// Repeating pattern generators. Each returns a MultiPolygon of SOLID material in plate coordinates (origin at
// the plate centre, x right, y up) covering the whole plate; the face builder clips it to the plate outline.
//
// Anchoring: 'center' puts the pattern origin on the plate centre, 'corner' on the top-left corner. The
// Chevron series anchors its grooves to each plate's top-left corner, which is why mixed-height stacks line up
// on the 56 mm row pitch (every plate height is 13 mod 14). phaseX/phaseY shift the origin in mm.

import * as P from './polys.js';
import { normTiles, portSet, rotatePort, linkLine, bandRing, presetTiles } from './tiles.js';

function origin(ctx, params) {
  const ox = (params.anchor === 'corner' ? -ctx.W / 2 : 0) + (params.phaseX || 0);
  const oy = (params.anchor === 'corner' ? ctx.H / 2 : 0) + (params.phaseY || 0);
  // covering radius around the origin (farthest plate corner) so rotated patterns still cover the plate
  const R = Math.max(
    Math.hypot(-ctx.W / 2 - ox, -ctx.H / 2 - oy), Math.hypot(ctx.W / 2 - ox, -ctx.H / 2 - oy),
    Math.hypot(-ctx.W / 2 - ox, ctx.H / 2 - oy), Math.hypot(ctx.W / 2 - ox, ctx.H / 2 - oy));
  return { ox, oy, R };
}

/** Parallel bands of `width` every `pitch`, perpendicular to `angle` (0 = vertical bands). */
function stripes(ctx, p) {
  const { ox, oy, R } = origin(ctx, p);
  const pitch = Math.max(0.5, p.pitch), width = Math.min(Math.max(0.1, p.width), pitch);
  const polys = [];
  const k0 = Math.floor((-R - width) / pitch) - 1, k1 = Math.ceil((R + width) / pitch) + 1;
  for (let k = k0; k <= k1; k++) {
    const x = k * pitch;
    polys.push([[[x - width / 2, -R - 1], [x + width / 2, -R - 1], [x + width / 2, R + 1], [x - width / 2, R + 1], [x - width / 2, -R - 1]]]);
  }
  return P.translate(P.rotate(polys, p.angle || 0), ox, oy);
}

/**
 * Chevron, as the Chevron series defines it: strips rising toward the centre on the left half ("/"), mirrored
 * about the plate's centre line. `pitch` is the HORIZONTAL repeat along an edge (the series' 14 mm: groove
 * centres at x + y = 3.5 + 14k from the top-left corner), `groove` the gap measured perpendicular to the strips
 * (0.25 mm), so the perpendicular strip pitch is pitch * cos(angle). `offset` is where the first groove crosses
 * the top edge, in mm from the top-left corner.
 *
 * `layout`: 'chevron' (the series), 'reverse' (strips falling toward the centre), and the two slants, which run
 * one direction across the whole plate and so have no centre seam: 'slant' ("/", measured from the top-left
 * corner) and 'slantBack' ("\", its mirror, measured from the top-right corner).
 */
function chevron(ctx, p) {
  const angle = Math.max(10, Math.min(80, p.angle ?? 45));
  const cosA = Math.cos(angle * Math.PI / 180);
  const pitch = Math.max(2, p.pitch), perp = pitch * cosA;
  const groove = Math.max(0, Math.min(p.groove ?? 0.25, perp - 0.2));
  // stripes() centres a SOLID band on its origin; the series centres a GROOVE `offset` mm in from the corner
  const phaseX = (p.offset ?? 3.5) - pitch / 2 + (p.phaseX || 0);
  const strips = stripes(ctx, { pitch: perp, width: perp - groove, anchor: 'corner', angle: -angle, phaseX, phaseY: p.phaseY || 0 });
  const layout = p.layout || 'chevron';
  if (layout === 'slant') return strips;
  if (layout === 'slantBack') return P.mirrorX(strips, 0);
  let l, r;
  if (layout === 'reverse') {
    r = P.intersection(strips, P.rect(0, -ctx.H / 2 - 1, ctx.W / 2 + 1, ctx.H / 2 + 1));
    l = P.mirrorX(r, 0);
  } else {
    l = P.intersection(strips, P.rect(-ctx.W / 2 - 1, -ctx.H / 2 - 1, 0, ctx.H / 2 + 1));
    r = P.mirrorX(l, 0);
  }
  // keep the seam split (chevron series: 0.25 mm) by shrinking each half away from the centre line
  const seam = Math.max(0, p.seam || 0) / 2;
  const lClip = seam ? P.intersection(l, P.rect(-ctx.W, -ctx.H, -seam, ctx.H)) : l;
  const rClip = seam ? P.intersection(r, P.rect(seam, -ctx.H, ctx.W, ctx.H)) : r;
  return P.union(lClip, rClip);
}

/** Grid lines (solid bands both ways). Cut them for a tile look, raise them for a lattice. */
function grid(ctx, p) {
  const v = stripes(ctx, { ...p, pitch: p.pitchX, width: p.lineWidth, angle: p.angle || 0 });
  const h = stripes(ctx, { ...p, pitch: p.pitchY, width: p.lineWidth, angle: (p.angle || 0) + 90 });
  return P.union(v, h);
}

/** Circles on a grid, optionally staggered every other row. */
function dots(ctx, p) {
  const { ox, oy, R } = origin(ctx, p);
  const px = Math.max(0.5, p.pitchX), py = Math.max(0.5, p.pitchY), r = Math.max(0.1, p.diameter / 2);
  const polys = [];
  const j0 = Math.floor((-R - r) / py) - 1, j1 = Math.ceil((R + r) / py) + 1;
  for (let j = j0; j <= j1; j++) {
    const off = (p.stagger && (j & 1)) ? px / 2 : 0;
    const i0 = Math.floor((-R - r - off) / px) - 1, i1 = Math.ceil((R + r - off) / px) + 1;
    for (let i = i0; i <= i1; i++) {
      const cx = i * px + off, cy = j * py;
      if (Math.hypot(cx, cy) > R + r) continue;
      polys.push(P.circle(cx, cy, r, Math.max(12, Math.min(48, Math.round(r * 8))))[0]);
    }
  }
  return P.translate(P.rotate(polys, p.angle || 0), ox, oy);
}

/** Bricks: rectangles of (w - gap) x (h - gap) on a w x h pitch, rows offset by a fraction of w. */
function bricks(ctx, p) {
  const { ox, oy, R } = origin(ctx, p);
  const w = Math.max(1, p.brickW), h = Math.max(1, p.brickH), gap = Math.max(0, Math.min(p.gap, Math.min(w, h) - 0.2));
  const frac = Math.max(0, Math.min(1, p.offset ?? 0.5));
  const polys = [];
  const j0 = Math.floor(-R / h) - 1, j1 = Math.ceil(R / h) + 1;
  for (let j = j0; j <= j1; j++) {
    const off = (j & 1) ? frac * w : 0;
    const i0 = Math.floor((-R - off) / w) - 1, i1 = Math.ceil((R - off) / w) + 1;
    for (let i = i0; i <= i1; i++) {
      const x0 = i * w + off + gap / 2, y0 = j * h + gap / 2;
      if (Math.hypot(x0, y0) > R + w + h) continue;
      polys.push(P.rect(x0, y0, x0 + w - gap, y0 + h - gap)[0]);
    }
  }
  return P.translate(P.rotate(polys, p.angle || 0), ox, oy);
}

/** Hexagons (flat-to-flat `size`) with a `gap` between them. */
function hex(ctx, p) {
  const { ox, oy, R } = origin(ctx, p);
  const size = Math.max(1, p.size), gap = Math.max(0, Math.min(p.gap, size - 0.2));
  const rIn = (size - gap) / 2, rOut = rIn / Math.cos(Math.PI / 6);      // inner radius of the drawn hex
  const pitchX = size, pitchY = size * Math.sqrt(3) / 2;                   // pointy-top hex lattice spacing
  const polys = [];
  const j0 = Math.floor(-R / pitchY) - 1, j1 = Math.ceil(R / pitchY) + 1;
  for (let j = j0; j <= j1; j++) {
    const off = (j & 1) ? pitchX / 2 : 0;
    const i0 = Math.floor((-R - off) / pitchX) - 1, i1 = Math.ceil((R - off) / pitchX) + 1;
    for (let i = i0; i <= i1; i++) {
      const cx = i * pitchX + off, cy = j * pitchY;
      if (Math.hypot(cx, cy) > R + size) continue;
      polys.push(P.regularPolygon(cx, cy, rOut, 6, 30)[0]);
    }
  }
  return P.translate(P.rotate(polys, p.angle || 0), ox, oy);
}

/** Checkerboard squares. */
function checker(ctx, p) {
  const { ox, oy, R } = origin(ctx, p);
  const s = Math.max(1, p.size), gap = Math.max(0, Math.min(p.gap || 0, s - 0.2));
  const polys = [];
  const j0 = Math.floor(-R / s) - 1, j1 = Math.ceil(R / s) + 1;
  for (let j = j0; j <= j1; j++) for (let i = j0; i <= j1; i++) {
    if ((i + j) & 1) continue;
    const x0 = i * s + gap / 2, y0 = j * s + gap / 2;
    if (Math.hypot(x0, y0) > R + 2 * s) continue;
    polys.push(P.rect(x0, y0, x0 + s - gap, y0 + s - gap)[0]);
  }
  return P.translate(P.rotate(polys, p.angle || 0), ox, oy);
}

// ---- textures: fine surfaces for fills (they work across a whole plate too)

/** A texture fine enough to make this many pieces or points would stall the polygon library for seconds: stop with
 *  a message the builder shows as a note, instead of freezing the page. */
export const TEXTURE_LIMITS = { pieces: 20000, points: 150000 };
function tooFine(label, pieces, points = 0) {
  if (pieces > TEXTURE_LIMITS.pieces || points > TEXTURE_LIMITS.points) throw new Error(`${label} is too fine for an area this big (${pieces.toLocaleString('en')} pieces); make it coarser`);
}

/**
 * The plate's box in a pattern's own frame (origin at the pattern origin, before its rotation), grown by `pad`:
 * fine textures generate only what can land on the plate, not the whole disc that covers it at any angle (on a
 * wide plate that disc is nearly three times the plate).
 */
function localBox(ctx, ox, oy, deg, pad) {
  const a = -(deg || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [X, Y] of [[-ctx.W / 2, -ctx.H / 2], [ctx.W / 2, -ctx.H / 2], [ctx.W / 2, ctx.H / 2], [-ctx.W / 2, ctx.H / 2]]) {
    const dx = X - ox, dy = Y - oy, x = dx * c - dy * s, y = dx * s + dy * c;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

/**
 * Knurling: two sets of grooves crossing at +/- `angle` from vertical, leaving raised diamonds. The diamonds are
 * written directly: in coordinates u = x cos a + y sin a and v = x cos a - y sin a every diamond is a square cell
 * of the groove lattice, shrunk by half a groove each side (clipping the grooves out of a sheet took half a second).
 */
function knurl(ctx, p) {
  const { ox, oy, R } = origin(ctx, p);
  const pitch = Math.max(0.8, p.pitch), groove = Math.max(0.1, Math.min(p.groove, pitch - 0.2));
  const a = Math.max(5, Math.min(85, p.angle ?? 30)) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const xy = (u, v) => [(u + v) / (2 * ca), (u - v) / (2 * sa)];
  const reach = R + 2 * pitch / Math.min(ca, sa), box = localBox(ctx, ox, oy, 0, 2 * pitch / Math.min(ca, sa));
  const n = Math.ceil(reach / pitch) + 1, polys = [];
  for (let k = -n; k <= n; k++) for (let m = -n; m <= n; m++) {
    const u0 = k * pitch + groove / 2, u1 = (k + 1) * pitch - groove / 2, v0 = m * pitch + groove / 2, v1 = (m + 1) * pitch - groove / 2;
    const c = xy((u0 + u1) / 2, (v0 + v1) / 2);
    if (c[0] < box.x0 || c[0] > box.x1 || c[1] < box.y0 || c[1] > box.y1) continue;
    const ring = [xy(u0, v0), xy(u1, v0), xy(u1, v1), xy(u0, v1)];
    ring.push(ring[0]);
    polys.push([P.ringArea(ring) < 0 ? ring.reverse() : ring]);
    if (polys.length > TEXTURE_LIMITS.pieces) tooFine('Knurl', polys.length, 5 * polys.length);
  }
  return P.translate(polys, ox, oy);
}

/** Ripples: rings of `width` every `pitch` round the origin, like a dropped stone. */
function ripple(ctx, p) {
  const { ox, oy, R } = origin(ctx, p);
  const pitch = Math.max(0.8, p.pitch), width = Math.max(0.2, Math.min(p.width, pitch - 0.2));
  const seg = r => Math.max(24, Math.min(720, Math.ceil(2 * Math.PI * r / 0.35)));
  const polys = [];
  const r0 = p.centre === false ? pitch / 2 : 0;          // a dot in the middle, or a ring there
  let points = 0;
  for (let k = 0; r0 + k * pitch - width / 2 <= R + 1; k++) {
    const rc = r0 + k * pitch, ri = rc - width / 2, ro = rc + width / 2;
    points += seg(ro) + seg(Math.max(0.1, ri));
    tooFine('Ripples', k + 1, points);
    if (ri <= 0.05) { polys.push(P.circle(ox, oy, ro, seg(ro))[0]); continue; }
    polys.push([P.circle(ox, oy, ro, seg(ro))[0][0], P.circle(ox, oy, ri, seg(ri))[0][0].slice().reverse()]);
  }
  return polys;
}

/**
 * Wood grain: lines of `width` every `pitch`, all following one slow wave (so neighbours never touch) plus a small
 * wobble of their own, from the seed. `wave` is the grain's sway in mm, `length` its wavelength.
 */
function woodWave(p) {
  const s = Math.round(p.seed || 0), r = k => cellRandom(s, k, 0);
  const L = Math.max(5, p.length || 30);
  const parts = [[1, L, r(1)], [0.45, L * 0.37, r(2)], [0.2, L * 0.13, r(3)]];
  return x => parts.reduce((y, [a, l, ph]) => y + a * Math.sin(2 * Math.PI * (x / l + ph)), 0) / 1.65;
}
export const woodWobble = p => Math.max(0, Math.min(0.25, (Math.max(0.5, p.pitch) - Math.max(0.2, p.width)) / 4));
function wood(ctx, p) {
  const { ox, oy, R } = origin(ctx, p);
  const pitch = Math.max(0.5, p.pitch), width = Math.max(0.2, Math.min(p.width, pitch - 0.2));
  const sway = Math.max(0, p.wave ?? 1), base = woodWave(p), s = Math.round(p.seed || 0);
  const wob = woodWobble(p), step = 0.6, box = localBox(ctx, ox, oy, p.angle, 1);
  const polys = [];
  const k0 = Math.floor((box.y0 - sway - wob - width) / pitch) - 1, k1 = Math.ceil((box.y1 + sway + wob + width) / pitch) + 1;
  const xs = [];
  for (let x = box.x0; x < box.x1 + step; x += step) xs.push(x);
  tooFine('Wood grain', k1 - k0 + 1, 2 * xs.length * (k1 - k0 + 1));
  for (let k = k0; k <= k1; k++) {
    const ph = cellRandom(s, k, 7), fr = 0.6 + cellRandom(s, k, 8);
    const y = x => k * pitch + sway * base(x) + wob * Math.sin(2 * Math.PI * (x * fr / 9 + ph));
    const top = [], bot = [];
    for (const x of xs) { const c = y(x); top.push([x, c + width / 2]); bot.push([x, c - width / 2]); }
    polys.push([[...top, ...bot.reverse(), top[0]]]);
  }
  return P.translate(P.rotate(polys, p.angle || 0), ox, oy);
}

/** Stipple: dots on a jittered grid (`spacing` apart, moved up to `jitter` of the room they have), from the seed. */
export const stippleRoom = p => Math.max(0, (Math.max(0.5, p.spacing) - Math.max(0.2, p.diameter) - 0.8) / 2) * Math.max(0, Math.min(1, p.jitter ?? 1));
function stipple(ctx, p) {
  const { ox, oy, R } = origin(ctx, p);
  const s = Math.max(0.5, p.spacing), r = Math.max(0.1, Math.min(p.diameter, s - 0.2) / 2), seed = Math.round(p.seed || 0);
  const room = stippleRoom(p), box = localBox(ctx, ox, oy, p.angle, r + room + s);
  const dots = Math.round((box.x1 - box.x0) * (box.y1 - box.y0) / (s * s)), perDot = Math.max(12, Math.min(36, Math.round(r * 10)));
  tooFine('Stipple', dots, dots * perDot);
  const polys = [];
  for (let j = Math.floor(box.y0 / s); j <= Math.ceil(box.y1 / s); j++) for (let i = Math.floor(box.x0 / s); i <= Math.ceil(box.x1 / s); i++) {
    const a = 2 * Math.PI * cellRandom(seed, i, j), d = room * Math.sqrt(cellRandom(seed, j, i + 31337));
    const cx = i * s + d * Math.cos(a), cy = j * s + d * Math.sin(a);
    if (Math.hypot(cx, cy) > R + r) continue;
    polys.push(P.circle(cx, cy, r, Math.max(12, Math.min(36, Math.round(r * 10))))[0]);
  }
  return P.translate(P.rotate(polys, p.angle || 0), ox, oy);
}

// ---- linked patterns: drawn on the wall's own grid, so a plate's lines meet its neighbours'
//
// Plates sit on an 88 x 56 mm pitch with a 1 mm gap, each centred in its pitch box. These patterns divide every
// pitch box into cells (88 / cellsX by 56 / cellsY) and give every cell a tile whose lines end on fixed points of
// the cell's edges, the edge midpoints. Whatever tile a cell draws, and
// whatever seed a plate uses, its lines leave every edge exactly where the neighbouring plate's lines arrive, so
// any two plates on the wall join up. cellsY is kept even so 0.5H and 1.5H plates still end on a cell edge.

const PITCH_X = 88, PITCH_Y = 56;

function wallBox(ctx) {
  const wc = Math.max(1, Math.round((ctx.W + 1) / PITCH_X));
  const hc = Math.max(0.5, Math.round((ctx.H + 1) / PITCH_Y * 2) / 2);
  return { PW: PITCH_X * wc, PH: PITCH_Y * hc };
}

/** Cell sizes and counts for a linked pattern on this plate. */
export function linkedCells(params, W, H) {
  const k = Math.max(2, Math.round(params.cellsX || 9));
  const m = Math.max(2, 2 * Math.round((params.cellsY || 6) / 2));
  const { PW, PH } = wallBox({ W, H });
  const cw = PITCH_X / k, ch = PITCH_Y / m, x0 = -PW / 2, y1 = PH / 2;
  // the cells to draw: every cell that touches the plate (on a real plate, exactly the cells of its pitch box)
  const i0 = Math.floor((-W / 2 - x0) / cw), i1 = Math.ceil((W / 2 - x0) / cw) - 1;
  const j0 = Math.floor((y1 - H / 2) / ch), j1 = Math.ceil((y1 + H / 2) / ch) - 1;
  return { cw, ch, x0, y1, i0, i1, j0, j1 };
}

/** A repeatable random number in [0, 1) for a cell. */
function cellRandom(seed, i, j) {
  let h = Math.imul(seed | 0, 0x9E3779B1) ^ Math.imul(i + 7919, 0x85EBCA77) ^ Math.imul(j + 104729, 0xC2B2AE3D);
  h = Math.imul(h ^ (h >>> 16), 0x7FEB352D); h = Math.imul(h ^ (h >>> 15), 0x846CA68B); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function plateSeed(p, W, H) {
  const s = Math.round(p.seed || 0);
  return p.perSize === false ? s : s ^ Math.imul(Math.round(W * 4), 0x27D4EB2D) ^ Math.imul(Math.round(H * 4), 0x165667B1);
}

/** A band of width w along a quarter (or any) elliptical arc around (cx, cy). Each end runs JOIN mm past the cell
 *  edge, so a band and its neighbour's overlap instead of meeting edge to edge (which the clipper handles badly). */
const JOIN = 0.05;
function arcBand(cx, cy, rx, ry, a0, a1, w, n = 12) {
  const da = JOIN / Math.max(0.5, Math.min(rx, ry));
  a0 -= da; a1 += da;
  const outer = [], inner = [];
  for (let s = 0; s <= n; s++) {
    const a = a0 + (a1 - a0) * s / n, c = Math.cos(a), si = Math.sin(a);
    outer.push([cx + (rx + w / 2) * c, cy + (ry + w / 2) * si]);
    inner.push([cx + (rx - w / 2) * c, cy + (ry - w / 2) * si]);
  }
  return P.polygon([...outer, ...inner.reverse()]);
}

/** A band of width w along a straight segment, extended by `ext` past each end. */
function lineBand(x0, y0, x1, y1, w, ext = 0) {
  const L = Math.hypot(x1 - x0, y1 - y0) || 1, ux = (x1 - x0) / L, uy = (y1 - y0) / L, nx = -uy * w / 2, ny = ux * w / 2;
  const ax = x0 - ux * ext, ay = y0 - uy * ext, bx = x1 + ux * ext, by = y1 + uy * ext;
  return P.polygon([[ax + nx, ay + ny], [ax - nx, ay - ny], [bx - nx, by - ny], [bx + nx, by + ny]]);
}

/**
 * A band of width w from P to Q, two points on cell edges, whose ends are cut along those edges (and JOIN beyond
 * them) instead of square to the band. The neighbouring cell's band crosses the same edge with the same width
 * centred on the same point, so an angled run and its neighbour meet in a clean mitre. pOnH / qOnH: the point
 * lies on a horizontal edge (else a vertical one).
 */
function edgeBand(px, py, qx, qy, pOnH, qOnH, w) {
  const L = Math.hypot(qx - px, qy - py) || 1, dx = (qx - px) / L, dy = (qy - py) / L, nx = -dy * w / 2, ny = dx * w / 2;
  const cut = (ox, oy, onH, ex, ey, away) => onH
    ? (() => { const Y = ey + JOIN * Math.sign(away); const s = (Y - oy) / dy; return [ox + dx * s, Y]; })()
    : (() => { const X = ex + JOIN * Math.sign(away); const s = (X - ox) / dx; return [X, oy + dy * s]; })();
  const a1 = cut(px + nx, py + ny, pOnH, px, py, pOnH ? py - qy : px - qx), a2 = cut(px + nx, py + ny, qOnH, qx, qy, qOnH ? qy - py : qx - px);
  const b2 = cut(px - nx, py - ny, qOnH, qx, qy, qOnH ? qy - py : qx - px), b1 = cut(px - nx, py - ny, pOnH, px, py, pOnH ? py - qy : px - qx);
  return P.polygon([a1, a2, b2, b1]);
}

/** Truchet-style tiles: arcs between edge midpoints, a circuit of arcs and crossings, or angled straight runs. */
function truchet(ctx, p) {
  const { cw, ch, x0, y1, i0, i1, j0, j1 } = linkedCells(p, ctx.W, ctx.H);
  const w = Math.max(0.2, Math.min(p.width ?? 1.6, 0.8 * Math.min(cw, ch)));
  const seed = plateSeed(p, ctx.W, ctx.H), tiles = p.tiles || 'arcs', cross = Math.max(0, Math.min(1, p.cross ?? 0.3));
  const H = Math.PI / 2, polys = [];
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const a = x0 + i * cw, b = a + cw, top = y1 - j * ch, bot = top - ch, r = cellRandom(seed, i, j);
    if (tiles === 'angles') {
      // straight 45-degree runs between neighbouring edge midpoints: angular, and joined like the arcs
      const mx = (a + b) / 2, my = (top + bot) / 2;
      if (r < 0.5) polys.push(edgeBand(mx, top, a, my, true, false, w), edgeBand(b, my, mx, bot, false, true, w));
      else polys.push(edgeBand(mx, top, b, my, true, false, w), edgeBand(a, my, mx, bot, false, true, w));
      continue;
    }
    if (tiles === 'circuit' && r < cross) {
      polys.push(lineBand(a, (top + bot) / 2, b, (top + bot) / 2, w, JOIN), lineBand((a + b) / 2, bot, (a + b) / 2, top, w, JOIN));
      continue;
    }
    const flip = tiles === 'circuit' ? (cellRandom(seed + 1, i, j) < 0.5) : (r < 0.5);
    if (flip) polys.push(arcBand(a, top, cw / 2, ch / 2, -H, 0, w), arcBand(b, bot, cw / 2, ch / 2, H, 2 * H, w));
    else polys.push(arcBand(b, top, cw / 2, ch / 2, 2 * H, 3 * H, w), arcBand(a, bot, cw / 2, ch / 2, 0, H, w));
  }
  return P.unionPieces(polys);
}

/**
 * Tiles drawn in the tile editor (tiles.js): each cell takes one of the set's tiles at random, by weight, turned a
 * random quarter when `rotate` is on, and draws its links as bands. Every link meets the cell edge square at a port,
 * so the lines join from cell to cell and from plate to plate whatever was drawn.
 */
function customTiles(ctx, p) {
  const set = portSet(p.ports);
  // a blank tile is kept: weighted, it leaves cells empty on purpose (a sparser pattern)
  const tiles = normTiles(p.tiles, set).filter(tl => tl.weight > 0);
  if (!tiles.length) return [];
  const { cw, ch, x0, y1, i0, i1, j0, j1 } = linkedCells(p, ctx.W, ctx.H);
  const w = Math.max(0.2, Math.min(p.width ?? 1.6, (set === 'thirds' ? 0.28 : 0.8) * Math.min(cw, ch)));
  const seed = plateSeed(p, ctx.W, ctx.H), total = tiles.reduce((s, tl) => s + tl.weight, 0);
  const polys = [];
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const a = x0 + i * cw, bot = y1 - (j + 1) * ch;
    let r = cellRandom(seed, i, j) * total, tile = tiles[tiles.length - 1];
    for (const tl of tiles) { if (r < tl.weight) { tile = tl; break; } r -= tl.weight; }
    const turn = p.rotate === false ? 0 : Math.floor(cellRandom(seed + 7, i, j) * 4);
    for (const [pa, pb] of tile.links) {
      const line = linkLine(set, rotatePort(set, pa, turn), rotatePort(set, pb, turn), tile.style, a, bot, cw, ch, 20, w);
      polys.push(P.polygon(bandRing(line, w, a, bot, cw, ch, JOIN)));
    }
    if (tile.dot > 0) polys.push(P.circle(a + cw / 2, bot + ch / 2, tile.dot * Math.min(cw, ch) / 2, 32));
  }
  return P.unionPieces(polys);
}

/** Rows of waves: one wave per cell across, so a row runs on into the plate beside it. */
function waves(ctx, p) {
  const { cw, ch, x0, y1, j0, j1 } = linkedCells(p, ctx.W, ctx.H);
  const w = Math.max(0.2, Math.min(p.width ?? 1.6, 0.8 * ch));
  const A = Math.max(0, Math.min(p.amplitude ?? 2, (ch - w) / 2 - 0.15));
  const xa = -ctx.W / 2 - 1, xb = ctx.W / 2 + 1, steps = Math.ceil((xb - xa) / (cw / 24));
  const polys = [];
  for (let j = j0; j <= j1; j++) {
    const yc = y1 - (j + 0.5) * ch, phase = p.stagger && (j & 1) ? Math.PI : 0;
    const up = [], down = [];
    for (let s = 0; s <= steps; s++) {
      const x = xa + (xb - xa) * s / steps, k = 2 * Math.PI / cw;
      const y = yc + A * Math.sin(k * (x - x0) + phase), dy = A * k * Math.cos(k * (x - x0) + phase);
      const L = Math.hypot(1, dy), nx = -dy / L * w / 2, nyv = 1 / L * w / 2;
      up.push([x + nx, y + nyv]); down.push([x - nx, y - nyv]);
    }
    polys.push(P.polygon([...up, ...down.reverse()]));
  }
  return P.unionPieces(polys);
}

const linkedGrid = (xLabel, yLabel, xDefault, yDefault) => [
  { key: 'cellsX', label: xLabel, type: 'number', min: 2, max: 22, step: 1, unit: '', default: xDefault, help: 'Counted across every 88 mm of wall, so the cells line up from plate to plate.' },
  { key: 'cellsY', label: yLabel, type: 'number', min: 2, max: 16, step: 2, unit: '', default: yDefault, help: 'Counted down every 56 mm. Even only, so 0.5H and 1.5H plates end on a cell edge.' },
];

// (the settings marked adv sit under More settings on the card: fine-tuning, not the first thing to change)
const anchorParam = { key: 'anchor', label: 'Pattern origin', type: 'select', options: [['center', 'Plate centre'], ['corner', 'Top-left corner']], default: 'center', adv: true, help: 'Where the pattern is measured from: the centre of the plate, the same on every size, or its top-left corner.' };
const phaseParams = [
  { key: 'phaseX', label: 'Pattern offset X', type: 'number', min: -200, max: 200, step: 0.25, unit: 'mm', default: 0, adv: true, help: 'Slides the pattern sideways inside the area it fills. The area itself stays where it is.' },
  { key: 'phaseY', label: 'Pattern offset Y', type: 'number', min: -200, max: 200, step: 0.25, unit: 'mm', default: 0, adv: true, help: 'Slides the pattern up or down inside the area it fills. The area itself stays where it is.' },
];
const angleParam = { key: 'angle', label: 'Angle', type: 'number', min: -180, max: 180, step: 1, unit: 'deg', default: 0 };

export const PATTERNS = {
  // Stripes start as fine horizontal ribs, 3 mm every 7 mm, with a gap on the centre line: band centres at
  // 3.5 + 7k mm from the plate centre. Plate half-heights are 28k - 0.5 mm (or 13.575 for the half height), so every
  // top and bottom edge falls 1.5 mm into a gap and no size is left with a sliver, and the ribs line up across
  // plates stacked on the 56 mm grid. Angle, pitch and width reach any other look.
  stripes: {
    label: 'Stripes', gen: stripes,
    params: [
      { key: 'pitch', label: 'Pitch', type: 'number', min: 1, max: 100, step: 0.25, unit: 'mm', default: 7 },
      { key: 'width', label: 'Band width', type: 'number', min: 0.2, max: 100, step: 0.05, unit: 'mm', default: 3 },
      { ...angleParam, default: 90 }, anchorParam, ...phaseParams.map(p => (p.key === 'phaseY' ? { ...p, default: 3.5 } : p)),
    ],
  },
  chevron: {
    label: 'Chevron', gen: chevron,
    params: [
      { key: 'layout', label: 'Layout', type: 'select', options: [['chevron', 'Chevron (meets in the middle)'], ['reverse', 'Reversed chevron'], ['slant', 'Slant / (no seam)'], ['slantBack', 'Slant \\ (no seam)']], default: 'chevron' },
      { key: 'pitch', label: 'Repeat along edge', type: 'number', min: 2, max: 100, step: 0.25, unit: 'mm', default: 14 },
      { key: 'groove', label: 'Groove width', type: 'number', min: 0, max: 20, step: 0.05, unit: 'mm', default: 0.25 },
      { key: 'angle', label: 'Angle', type: 'number', min: 10, max: 80, step: 1, unit: 'deg', default: 45 },
      { key: 'seam', label: 'Centre seam', type: 'number', min: 0, max: 5, step: 0.05, unit: 'mm', default: 0.25, showIf: { layout: ['chevron', 'reverse'] }, adv: true },
      { key: 'offset', label: 'First groove', type: 'number', min: 0, max: 100, step: 0.25, unit: 'mm', default: 3.5, adv: true, help: 'Where the first groove meets the top edge, measured from the corner the strips start at.' },
      ...phaseParams,
    ],
  },
  grid: {
    label: 'Grid lines', gen: grid,
    params: [
      { key: 'pitchX', label: 'Pitch X', type: 'number', min: 1, max: 100, step: 0.25, unit: 'mm', default: 11 },
      { key: 'pitchY', label: 'Pitch Y', type: 'number', min: 1, max: 100, step: 0.25, unit: 'mm', default: 11 },
      { key: 'lineWidth', label: 'Line width', type: 'number', min: 0.2, max: 20, step: 0.05, unit: 'mm', default: 1 },
      angleParam, anchorParam, ...phaseParams,
    ],
  },
  dots: {
    label: 'Dots', gen: dots,
    params: [
      { key: 'pitchX', label: 'Pitch X', type: 'number', min: 1, max: 100, step: 0.25, unit: 'mm', default: 8 },
      { key: 'pitchY', label: 'Pitch Y', type: 'number', min: 1, max: 100, step: 0.25, unit: 'mm', default: 8 },
      { key: 'diameter', label: 'Diameter', type: 'number', min: 0.4, max: 60, step: 0.1, unit: 'mm', default: 4 },
      { key: 'stagger', label: 'Stagger rows', type: 'bool', default: true },
      angleParam, anchorParam, ...phaseParams,
    ],
  },
  bricks: {
    label: 'Bricks', gen: bricks,
    params: [
      { key: 'brickW', label: 'Brick width', type: 'number', min: 2, max: 150, step: 0.25, unit: 'mm', default: 22 },
      { key: 'brickH', label: 'Brick height', type: 'number', min: 2, max: 150, step: 0.25, unit: 'mm', default: 11 },
      { key: 'gap', label: 'Mortar gap', type: 'number', min: 0, max: 20, step: 0.05, unit: 'mm', default: 1 },
      { key: 'offset', label: 'Row offset', type: 'number', min: 0, max: 1, step: 0.05, unit: 'x', default: 0.5 },
      angleParam, anchorParam, ...phaseParams,
    ],
  },
  hex: {
    label: 'Hex tiles', gen: hex,
    params: [
      { key: 'size', label: 'Hex size', type: 'number', min: 2, max: 100, step: 0.25, unit: 'mm', default: 12 },
      { key: 'gap', label: 'Gap', type: 'number', min: 0, max: 20, step: 0.05, unit: 'mm', default: 1 },
      angleParam, anchorParam, ...phaseParams,
    ],
  },
  truchet: {
    label: 'Linked tiles', gen: truchet, linked: true,
    params: [
      { key: 'tiles', label: 'Tiles', type: 'select', options: [['arcs', 'Arcs'], ['circuit', 'Circuit'], ['angles', 'Angles']], default: 'arcs' },
      ...linkedGrid('Cells per 1W', 'Cells per 1H', 9, 6),
      { key: 'width', label: 'Line width', type: 'number', min: 0.4, max: 10, step: 0.05, unit: 'mm', default: 1.6 },
      { key: 'cross', label: 'Crossings', type: 'number', min: 0, max: 1, step: 0.05, unit: 'x', default: 0.3, showIf: { tiles: 'circuit' }, adv: true, help: 'The share of cells that cross straight over instead of turning.' },
      { key: 'seed', label: 'Seed', type: 'number', min: 0, max: 9999, step: 1, unit: '', default: 1, adv: true },
      { key: 'perSize', label: 'A different layout on each size', type: 'bool', default: true, adv: true, help: 'On, every size gets its own random layout, still joined to its neighbours. Off, every size uses the same random choices.' },
    ],
  },
  tiles: {
    label: 'Your tiles', gen: customTiles, linked: true, editor: true,
    params: [
      ...linkedGrid('Cells per 1W', 'Cells per 1H', 9, 6),
      { key: 'width', label: 'Line width', type: 'number', min: 0.4, max: 10, step: 0.05, unit: 'mm', default: 1.6 },
      { key: 'rotate', label: 'Turn tiles at random', type: 'bool', default: true, help: 'Each cell turns its tile a random quarter, for more variety from fewer tiles.' },
      { key: 'seed', label: 'Seed', type: 'number', min: 0, max: 9999, step: 1, unit: '', default: 1, adv: true },
      { key: 'perSize', label: 'A different layout on each size', type: 'bool', default: true, adv: true, help: 'On, every size gets its own random layout, still joined to its neighbours. Off, every size uses the same random choices.' },
    ],
    // drawn in the tile editor rather than set with a control: which ports a tile has, and the tiles themselves
    extra: () => presetTiles('circuit'),
  },
  waves: {
    label: 'Linked waves', gen: waves, linked: true,
    params: [
      ...linkedGrid('Waves per 1W', 'Rows per 1H', 4, 6),
      { key: 'amplitude', label: 'Amplitude', type: 'number', min: 0, max: 20, step: 0.1, unit: 'mm', default: 2 },
      { key: 'width', label: 'Line width', type: 'number', min: 0.4, max: 10, step: 0.05, unit: 'mm', default: 1.6 },
      { key: 'stagger', label: 'Alternate rows', type: 'bool', default: false },
    ],
  },
  knurl: {
    label: 'Knurl', gen: knurl, texture: true,
    params: [
      { key: 'pitch', label: 'Pitch', type: 'number', min: 0.8, max: 20, step: 0.1, unit: 'mm', default: 2.5 },
      { key: 'groove', label: 'Groove width', type: 'number', min: 0.1, max: 5, step: 0.05, unit: 'mm', default: 0.8 },
      { key: 'angle', label: 'Groove angle', type: 'number', min: 5, max: 85, step: 1, unit: 'deg', default: 30, help: 'Each set of grooves leans this far from vertical; 45 makes square diamonds.' },
      anchorParam, ...phaseParams,
    ],
  },
  ripple: {
    label: 'Ripples', gen: ripple, texture: true,
    params: [
      { key: 'pitch', label: 'Pitch', type: 'number', min: 0.8, max: 30, step: 0.1, unit: 'mm', default: 2.5 },
      { key: 'width', label: 'Ring width', type: 'number', min: 0.2, max: 20, step: 0.05, unit: 'mm', default: 1.2 },
      { key: 'centre', label: 'Dot in the middle', type: 'bool', default: true },
      anchorParam, ...phaseParams,
    ],
  },
  wood: {
    label: 'Wood grain', gen: wood, texture: true,
    params: [
      { key: 'pitch', label: 'Line pitch', type: 'number', min: 0.5, max: 20, step: 0.1, unit: 'mm', default: 2.4 },
      { key: 'width', label: 'Line width', type: 'number', min: 0.2, max: 10, step: 0.05, unit: 'mm', default: 1 },
      { key: 'wave', label: 'Sway', type: 'number', min: 0, max: 20, step: 0.1, unit: 'mm', default: 1.2 },
      { key: 'length', label: 'Sway length', type: 'number', min: 5, max: 200, step: 1, unit: 'mm', default: 32, adv: true },
      { ...angleParam, default: 0 },
      { key: 'seed', label: 'Seed', type: 'number', min: 0, max: 9999, step: 1, unit: '', default: 1, adv: true },
      anchorParam, ...phaseParams,
    ],
  },
  stipple: {
    label: 'Stipple', gen: stipple, texture: true,
    params: [
      { key: 'spacing', label: 'Spacing', type: 'number', min: 0.5, max: 30, step: 0.1, unit: 'mm', default: 2.8 },
      { key: 'diameter', label: 'Dot size', type: 'number', min: 0.2, max: 20, step: 0.05, unit: 'mm', default: 1.1 },
      { key: 'jitter', label: 'Scatter', type: 'number', min: 0, max: 1, step: 0.05, unit: 'x', default: 1, adv: true, help: 'How far each dot strays from its grid point, as a share of the room it has. Dots never touch.' },
      { key: 'seed', label: 'Seed', type: 'number', min: 0, max: 9999, step: 1, unit: '', default: 1, adv: true },
      anchorParam, ...phaseParams,
    ],
  },
  checker: {
    label: 'Checkerboard', gen: checker,
    params: [
      { key: 'size', label: 'Square', type: 'number', min: 1, max: 100, step: 0.25, unit: 'mm', default: 11 },
      { key: 'gap', label: 'Gap', type: 'number', min: 0, max: 20, step: 0.05, unit: 'mm', default: 0 },
      angleParam, anchorParam, ...phaseParams,
    ],
  },
};

export function patternDefaults(kind) {
  const def = PATTERNS[kind];
  const out = {};
  for (const p of def.params) out[p.key] = p.default;
  if (def.extra) Object.assign(out, def.extra());
  return out;
}

/**
 * Pattern parameters from anywhere (a design file someone sent) made safe: only the pattern's own keys, numbers that
 * are finite numbers held to the parameter's own range (a shift of 1e20 mm would make a generator's loop counter
 * too big to step), choices that are among the options, switches as true or false; anything else falls back to the
 * default. A pattern's extras (the tile editor's tiles and ports) pass through, and are cleaned where used.
 */
export function cleanPatternParams(kind, raw) {
  const def = PATTERNS[kind];
  const out = patternDefaults(kind);
  if (!def || !raw || typeof raw !== 'object') return out;
  for (const p of def.params) {
    const v = raw[p.key];
    if (v === undefined) continue;
    if (p.type === 'number') { const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN; if (Number.isFinite(n)) out[p.key] = Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, n)); }
    else if (p.type === 'select') { if (p.options.some(([o]) => o === v)) out[p.key] = v; }
    else if (p.type === 'bool') out[p.key] = !!v;
  }
  if (def.extra) for (const k of Object.keys(def.extra())) if (raw[k] !== undefined) out[k] = raw[k];
  return out;
}

/** Generate a pattern's solid polygons for a plate of W x H mm. */
export function generatePattern(kind, params, W, H) {
  const def = PATTERNS[kind];
  if (!def) throw new Error(`Unknown pattern ${kind}`);
  const p = { ...patternDefaults(kind), ...params };
  return def.gen({ W, H }, p);
}
