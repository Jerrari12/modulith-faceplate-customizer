// Draws a built plate as SVG markup in millimetres (y up). Shared by the 2D stage, the size cards and the
// inspector thumbnail. Everything is a string so thumbnails stay cheap; the stage wires events by data-attributes.

import * as P from '../geometry/polys.js';
import { PITCH } from '../data/sizes.js';

const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

export function shade(hex, amt) {
  // darken (amt < 0) or lighten (amt > 0) a #rrggbb colour by a fraction
  const n = parseInt(hex.slice(1), 16);
  const f = c => Math.max(0, Math.min(255, Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt)));
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map(f).map(c => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A 3D texture as the 2D stage shows it: its top, every triangle shaded by its slope toward a light at the top left
 * and a little by its height, rendered once per mesh into an image (the y flip undone by its own scale(1,-1)).
 * null where there is no document (tests), and the stage then keeps the hatched outline.
 */
const reliefs = new WeakMap();
function reliefImage(g, hex) {
  if (typeof document === 'undefined' || !g.tris || !g.tris.length) return null;
  const hit = reliefs.get(g.tris);
  if (hit && hit.hex === hex) return hit.svg;
  const b = P.bbox(g.footprint);
  if (!b || b.w <= 0 || b.h <= 0) return null;
  let svg = null;
  try {
    const ppm = Math.min(8, 1600 / Math.max(b.w, b.h)), cw = Math.max(1, Math.ceil(b.w * ppm)), ch = Math.max(1, Math.ceil(b.h * ppm));
    const cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    const ctx = cv.getContext('2d');
    ctx.lineJoin = 'round'; ctx.lineWidth = 0.75;
    const t = g.tris, Lx = -0.55, Ly = 0.55, Lz = 0.63, zr = Math.max(1e-6, g.z1 - g.z0), fills = new Map();
    const X = x => (x - b.x0) * ppm, Y = y => (b.y1 - y) * ppm;
    for (let i = 0; i < t.length; i += 9) {
      const ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2], vx = t[i + 6] - t[i], vy = t[i + 7] - t[i + 1], vz = t[i + 8] - t[i + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, len = Math.hypot(nx, ny, nz);
      if (!len || nz / len < 0.2) continue;   // the walls and the bottom
      const lit = (nx * Lx + ny * Ly + nz * Lz) / len - Lz, zc = (t[i + 2] + t[i + 5] + t[i + 8]) / 3;
      const amt = Math.round(Math.max(-0.55, Math.min(0.45, lit * 1.8 + ((zc - g.z0) / zr - 0.5) * 0.2)) * 40) / 40;
      let col = fills.get(amt);
      if (!col) { col = shade(hex, amt); fills.set(amt, col); }
      ctx.fillStyle = col; ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.moveTo(X(t[i]), Y(t[i + 1])); ctx.lineTo(X(t[i + 3]), Y(t[i + 4])); ctx.lineTo(X(t[i + 6]), Y(t[i + 7])); ctx.closePath();
      ctx.fill(); ctx.stroke();
    }
    svg = `<image href="${cv.toDataURL('image/png')}" x="${b.x0}" y="${-b.y1}" width="${b.w}" height="${b.h}" transform="scale(1,-1)" preserveAspectRatio="none" pointer-events="none"/>`;
  } catch { svg = null; }
  reliefs.set(g.tris, { hex, svg });
  return svg;
}

/**
 * The plate itself (backer, layers, grips, holes) as a <g> in plate mm, y up.
 * colorOf(id) -> hex. opts: { selectedId, interactive }
 */
export function plateGroup(built, design, colorOf, opts = {}) {
  const { size, layers, solids, t } = built;
  const W = size.w, H = size.h;
  const backer = colorOf('backer');
  let s = `<g class="plate">`;
  s += `<rect x="${-W / 2}" y="${-H / 2}" width="${W}" height="${H}" fill="${backer}"/>`;
  const sorted = layers.slice().sort((a, b) => (a.z1 - b.z1) || (a.z0 - b.z0));
  for (const L of sorted) {
    const hex = colorOf(L.color);
    const raised = L.z1 > t + 1e-6, sunk = L.z1 < t - 1e-6;
    const fill = sunk ? shade(hex, -0.18) : raised ? hex : hex;
    const cls = ['el', L.elementId && opts.interactive && design.elements.find(e => e.id === L.elementId && e.kind !== 'pattern') ? 'movable' : '', L.elementId && L.elementId === opts.selectedId ? 'sel' : ''].filter(Boolean).join(' ');
    const stroke = raised ? shade(hex, -0.35) : sunk ? shade(hex, -0.45) : shade(hex, -0.12);
    s += `<path class="${cls}" data-el="${esc(L.elementId || '')}"${L.twin ? ' data-twin="1"' : ''} d="${P.pathD(L.poly)}" fill="${fill}" fill-rule="evenodd" stroke="${stroke}" stroke-width="${raised ? 0.25 : 0.12}" vector-effect="non-scaling-stroke"/>`;
  }
  for (const g of solids) {
    const hex = colorOf(g.color);
    const cls = ['el', 'movable', g.elementId === opts.selectedId ? 'sel' : ''].filter(Boolean).join(' ');
    const tw = g.twin ? ' data-twin="1"' : '';
    // a 3D texture or a tapered drawing on the stage shows its relief; its outline stays on top, clear but clickable
    const relief = (g.kind === 'surface' || g.kind === 'shaped') && opts.interactive ? reliefImage(g, hex) : null;
    if (relief) {
      s += relief + `<path class="${cls}" data-el="${esc(g.elementId)}"${tw} d="${P.pathD(g.footprint)}" fill="${hex}" fill-opacity="0" stroke="${shade(hex, -0.4)}" stroke-width="0.3" vector-effect="non-scaling-stroke"/>`;
      continue;
    }
    s += `<path class="${cls}" data-el="${esc(g.elementId)}"${tw} d="${P.pathD(g.footprint)}" fill="${hex}" stroke="${shade(hex, -0.4)}" stroke-width="0.3" vector-effect="non-scaling-stroke"/>`;
    // a block's flat top, drawn inside its footprint so a stack reads as steps
    if (g.top) s += `<path class="${cls}" data-el="${esc(g.elementId)}"${tw} d="${P.pathD(g.top)}" fill="${shade(hex, 0.12)}" stroke="${shade(hex, -0.25)}" stroke-width="0.2" vector-effect="non-scaling-stroke"/>`;
    s += `<path class="${cls}" data-el="${esc(g.elementId)}"${tw} d="${P.pathD(g.footprint)}" fill="url(#hatch)" stroke="none"/>`;
  }
  // with the face off the backer's own two screw holes are always open (they are in the backer), whatever the mount
  if (built.faceOn === false) for (const h of size.holes) if (!(built.holeList || []).includes(h)) s += `<circle cx="${h.x}" cy="${h.y}" r="${h.d / 2}" fill="var(--base)" stroke="${shade(backer, 0.35)}" stroke-width="0.15" vector-effect="non-scaling-stroke"/>`;
  for (const h of built.holeList || []) s += `<circle cx="${h.x}" cy="${h.y}" r="${h.d / 2}" fill="var(--base)" stroke="${shade(backer, 0.35)}" stroke-width="0.15" vector-effect="non-scaling-stroke"/>`;
  s += `<rect x="${-W / 2}" y="${-H / 2}" width="${W}" height="${H}" fill="none" stroke="rgba(0,0,0,.45)" stroke-width="0.3" vector-effect="non-scaling-stroke"/>`;
  s += '</g>';
  return s;
}

/** Full stage content: wall ghosts, plate, grid, dims, selection, issue markers. pxPerMm sizes the text. */
export function stageContent(built, design, colorOf, opts = {}) {
  const { size } = built;
  const W = size.w, H = size.h, px = 1 / (opts.pxPerMm || 4);   // mm per screen pixel
  const plate = plateGroup(built, design, colorOf, opts);
  let s = `<defs><pattern id="hatch" width="2" height="2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="2" fill="none"/><line x1="0" y1="0" x2="0" y2="2" stroke="rgba(0,0,0,.28)" stroke-width="0.5"/></pattern>` +
    `<pattern id="grid10" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M10 0H0V10" fill="none" stroke="var(--grid-major)" stroke-width="${0.9 * px}"/></pattern>` +
    `<pattern id="grid5" width="5" height="5" patternUnits="userSpaceOnUse"><path d="M5 0H0V5" fill="none" stroke="var(--grid-minor)" stroke-width="${0.8 * px}"/></pattern>` +
    `<g id="plateDef">${plate}</g></defs>`;
  if (opts.grid) {
    const gx = -W / 2 - 200, gy = -H / 2 - 200;
    s += `<rect x="${gx}" y="${gy}" width="${W + 400}" height="${H + 400}" fill="url(#grid5)"/><rect x="${gx}" y="${gy}" width="${W + 400}" height="${H + 400}" fill="url(#grid10)"/>`;
  }
  if (opts.wall) {
    const dx = PITCH.x * size.wCells, dy = PITCH.y * size.hCells;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      if (!i && !j) continue;
      s += `<use href="#plateDef" x="${i * dx}" y="${j * dy}" opacity="0.4" pointer-events="none"/>`;
    }
  }
  s += `<g class="plateLive">${plate}</g>`;
  // a combine's pieces: not printed on their own, drawn dashed so they can still be picked and moved. Only the dashed
  // edge takes the pointer (a clear strip a few pixels wide along it): a press inside the combine is the combine's
  if (opts.interactive) for (const g of built.ghosts || []) {
    const on = g.elementId === opts.selectedId, d = P.pathD(g.poly);
    s += `<path d="${d}" fill="var(--measure)" fill-opacity="${on ? 0.16 : 0.06}" fill-rule="evenodd" stroke="var(--measure)" stroke-width="${(on ? 1.6 : 1.1) * px}" stroke-dasharray="${4 * px} ${3 * px}" pointer-events="none"/>`;
    s += `<path class="el movable ghost${on ? ' sel' : ''}" data-el="${esc(g.elementId)}"${g.twin ? ' data-twin="1"' : ''} d="${d}" fill="none" stroke="transparent" stroke-width="${9 * px}" pointer-events="stroke"/>`;
  }
  // symmetry: the mirror line down the plate's centre
  if (design.symmetry === 'x') s += `<line x1="0" y1="${-H / 2 - 8 * px}" x2="0" y2="${H / 2 + 8 * px}" stroke="var(--measure)" stroke-width="${1.2 * px}" stroke-dasharray="${6 * px} ${4 * px}" opacity="0.8" pointer-events="none"/>`;
  // snap guides while dragging: the lines the element has locked to
  for (const g of opts.guides || []) {
    s += g.axis === 'x'
      ? `<line x1="${g.at}" y1="${-H / 2 - 12 * px}" x2="${g.at}" y2="${H / 2 + 12 * px}" stroke="var(--measure)" stroke-width="${1.4 * px}" pointer-events="none"/>`
      : `<line x1="${-W / 2 - 12 * px}" y1="${g.at}" x2="${W / 2 + 12 * px}" y2="${g.at}" stroke="var(--measure)" stroke-width="${1.4 * px}" pointer-events="none"/>`;
  }
  // selection outline
  if (opts.selectedId) {
    const polys = [];
    for (const L of built.layers) if (L.elementId === opts.selectedId) polys.push(L.poly);
    for (const g of built.solids) if (g.elementId === opts.selectedId) polys.push(g.footprint);
    for (const g of built.ghosts || []) if (g.elementId === opts.selectedId && !g.twin) polys.push(g.poly);
    const bb = polys.length ? P.bbox(P.union(...polys)) : null;
    if (bb) s += `<rect x="${bb.x0 - 1}" y="${bb.y0 - 1}" width="${bb.w + 2}" height="${bb.h + 2}" fill="none" stroke="var(--orange)" stroke-width="${1.6 * px}" stroke-dasharray="${5 * px} ${3 * px}" pointer-events="none"/>`;
  }
  // dimensions and the TOP marker (text is drawn un-flipped)
  if (opts.dims) {
    const fs = 11 * px, o = 6 * px, tick = 3 * px, c = 'var(--measure)';
    const txt = (x, y, t, anchor = 'middle') => `<text x="${x}" y="${-y}" transform="scale(1,-1)" font-size="${fs}" font-family="IBM Plex Mono,ui-monospace,Consolas,monospace" fill="${c}" text-anchor="${anchor}" dominant-baseline="middle" pointer-events="none">${esc(t)}</text>`;
    const y = -H / 2 - o * 2.2, x = -W / 2 - o * 2.2;
    s += `<g stroke="${c}" stroke-width="${0.8 * px}" fill="none" pointer-events="none">`;
    s += `<path d="M${-W / 2} ${y}H${W / 2}M${-W / 2} ${y - tick}V${y + tick}M${W / 2} ${y - tick}V${y + tick}"/>`;
    s += `<path d="M${x} ${-H / 2}V${H / 2}M${x - tick} ${-H / 2}H${x + tick}M${x - tick} ${H / 2}H${x + tick}"/></g>`;
    s += txt(0, y - fs * 0.9, `${W} mm`);
    s += `<g transform="translate(${x - fs * 0.9} 0) rotate(90)">${txt(0, 0, `${H} mm`)}</g>`;
    s += txt(0, H / 2 + o * 1.3, 'TOP');
  }
  // issue markers
  if (opts.issues?.length) {
    const r = 9 * px, fs = 10 * px;
    opts.issues.forEach((c, i) => {
      if (!c.geo?.at) return;
      const [x, y] = c.geo.at;
      const col = c.st === 'fail' ? 'var(--danger)' : 'var(--warning)', ink = c.st === 'fail' ? '#fff' : '#19191B';
      s += `<g class="iss" data-check="${i}" transform="translate(${x} ${y})"><circle r="${r * 1.6}" fill="${col}" opacity="0.18"/><circle r="${r}" fill="${col}" stroke="#fff" stroke-width="${1.2 * px}"/><text transform="scale(1,-1)" font-size="${fs}" font-weight="700" font-family="IBM Plex Mono,ui-monospace,Consolas,monospace" fill="${ink}" text-anchor="middle" dominant-baseline="central" pointer-events="none">${i + 1}</text></g>`;
    });
  }
  if (opts.highlight?.at) {
    const [x, y] = opts.highlight.at;
    s += `<circle cx="${x}" cy="${y}" r="${14 * px}" fill="none" stroke="var(--orange)" stroke-width="${2 * px}" pointer-events="none"><animate attributeName="r" values="${10 * px};${18 * px};${10 * px}" dur="1.2s" repeatCount="indefinite"/></circle>`;
  }
  return s;
}

/** A standalone thumbnail <svg> for a built plate, fitted into w x h pixels. */
export function thumbnailSvg(built, design, colorOf, w = 200, h = 120) {
  const W = built.size.w, H = built.size.h, m = 2;
  const sc = Math.min(w / (W + 2 * m), h / (H + 2 * m));
  const vw = w / sc, vh = h / sc;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-vw / 2} ${-vh / 2} ${vw} ${vh}" width="${w}" height="${h}">` +
    `<defs><pattern id="hatch" width="2" height="2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="2" stroke="rgba(0,0,0,.28)" stroke-width="0.5"/></pattern></defs>` +
    `<g transform="scale(1,-1)">${plateGroup(built, design, colorOf, {})}</g></svg>`;
}
