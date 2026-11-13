// Generated, colour-aware product glyphs (the planner brief §3: "every icon is generated from the build's live
// filament colours, never a pre-rendered picture"). Patterns and shapes are drawn by the same generators the
// faceplate uses; grips are their real cross-sections; SVG art and meshes show their own outlines.

import * as P from '../geometry/polys.js';
import { generatePattern } from '../geometry/patterns.js';
import { elementParts, newElement, meshBody, GRIP_STYLES, derivedOutline } from '../geometry/face.js';
import { SIZE_BY_ID } from '../data/sizes.js';
import { shade } from './render2d.js';
import { textOutline } from '../geometry/text.js';
import { imageTones } from '../geometry/image.js';
import { isFilled } from '../geometry/fill.js';
import { heightFunction, hash } from '../geometry/heightmaps.js';
import { CELL_MAPS, cellMesh } from '../geometry/cells.js';
import { tileHeights } from '../geometry/surface.js';
import { pathOutline } from '../geometry/path.js';
import { b64ToBytes } from '../geometry/image.js';

const cache = new Map();
const svgOpen = (w, h, vb) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${vb}" aria-hidden="true">`;

/** A small plate with a pattern on it. op 'cut' draws the pattern as grooves (a darker face), 'raise' in the accent. */
export function patternGlyph(kind, faceHex, accentHex, op = 'raise', w = 52, hgt = 32, params = null) {
  const key = `p|${kind}|${faceHex}|${accentHex}|${op}|${w}|${hgt}|${params ? JSON.stringify(params) : ''}`;
  if (cache.has(key)) return cache.get(key);
  const W = 60, H = 37;
  let poly = [];
  try { poly = P.intersection(generatePattern(kind, params || {}, W, H), P.rect(-W / 2, -H / 2, W / 2, H / 2)); } catch { poly = []; }
  const ink = op === 'cut' ? shade(faceHex, -0.32) : accentHex;
  const s = `${svgOpen(w, hgt, `${-W / 2} ${-H / 2} ${W} ${H}`)}<g transform="scale(1,-1)"><rect x="${-W / 2}" y="${-H / 2}" width="${W}" height="${H}" rx="2.5" fill="${faceHex}"/>` +
    `<path d="${P.pathD(poly, 2)}" fill="${ink}" fill-rule="evenodd"/></g><rect x="${-W / 2 + .3}" y="${-H / 2 + .3}" width="${W - .6}" height="${H - .6}" rx="2.3" fill="none" stroke="rgba(0,0,0,.25)" stroke-width=".6"/></svg>`;
  cache.set(key, s);
  return s;
}

/** A shape on a small plate. */
export function shapeGlyph(shape, faceHex, accentHex, op = 'raise', w = 52, hgt = 32) {
  const key = `s|${shape}|${faceHex}|${accentHex}|${op}|${w}|${hgt}`;
  if (cache.has(key)) return cache.get(key);
  const W = 60, H = 37;
  const el = newElement('shape', { shape, w: 34, h: 22, r: 5 });
  const [part] = elementParts(el, { w: W, h: H });
  const ink = op === 'cut' ? shade(faceHex, -0.32) : accentHex;
  const s = `${svgOpen(w, hgt, `${-W / 2} ${-H / 2} ${W} ${H}`)}<g transform="scale(1,-1)"><rect x="${-W / 2}" y="${-H / 2}" width="${W}" height="${H}" rx="2.5" fill="${faceHex}"/>` +
    `<path d="${P.pathD(part.poly, 2)}" fill="${ink}" stroke="${shade(ink, -0.3)}" stroke-width=".8"/></g></svg>`;
  cache.set(key, s);
  return s;
}

/** A grip's cross-section standing on the face line. */
export function gripGlyph(style, faceHex, accentHex, w = 52, hgt = 32) {
  const key = `g|${style}|${faceHex}|${accentHex}|${w}|${hgt}`;
  if (cache.has(key)) return cache.get(key);
  // profiles in a 40 x 24 box, face line at y = 20 (y down)
  const prof = {
    bar: 'M10 20 L10 9 L12 7 L28 7 L30 9 L30 20 Z',
    wedge: 'M15 20 L25 20 L31 7 L9 7 Z',
    ledge: 'M9 20 L23 20 L31 7 L9 7 Z',
    dome: 'M8 20 C8 6 32 6 32 20 Z',
    lip: 'M9 20 L20 20 L31 11 L31 7 L9 7 Z',
    arch: 'M5 20 L5 6.5 L6.5 5 L33.5 5 L35 6.5 L35 20 L30 20 L21 11 L19 11 L10 20 Z',
    classicpro: 'M9 20 L13.5 20 L30.4 3.8 L30.6 3.2 L30.6 1.6 L27.4 1.6 Z',
    classic: 'M9 20 L11.3 20 L24.6 6.7 L30.6 3.2 L30.6 1.6 L27.4 1.6 Z',
    edgelabel: 'M7 20 L10 20 L22 8 L31 8 L31 5 L25 5 L28 2 L22 2 Z',
  }[style] || 'M10 20 L10 8 L30 8 L30 20 Z';
  const s = `${svgOpen(w, hgt, '0 0 40 24')}<rect x="2" y="20" width="36" height="3.4" rx="1" fill="${faceHex}" stroke="rgba(0,0,0,.25)" stroke-width=".5"/>` +
    `<path d="${prof}" fill="${accentHex}" stroke="${shade(accentHex, -0.35)}" stroke-width=".8" stroke-linejoin="round"/></svg>`;
  cache.set(key, s);
  return s;
}

/** A solid block seen from the side, standing on the face line. */
export function solidGlyph(shape, faceHex, accentHex, w = 52, hgt = 32) {
  const key = `b|${shape}|${faceHex}|${accentHex}|${w}|${hgt}`;
  if (cache.has(key)) return cache.get(key);
  const prof = {
    box: 'M9 20 L9 9 L11 7 L29 7 L31 9 L31 20 Z',
    cylinder: 'M10 20 L10 8.5 C10 6.2 30 6.2 30 8.5 L30 20 Z',
    taper: 'M8 20 L13 7 L27 7 L32 20 Z',
    dome: 'M7 20 C7 4 33 4 33 20 Z',
    pyramid: 'M8 20 L20 5 L32 20 Z',
    wedge: 'M8 20 L32 20 L32 6 Z',
  }[shape] || 'M9 20 L9 7 L31 7 L31 20 Z';
  const s = `${svgOpen(w, hgt, '0 0 40 24')}<rect x="2" y="20" width="36" height="3.4" rx="1" fill="${faceHex}" stroke="rgba(0,0,0,.25)" stroke-width=".5"/>` +
    `<path d="${prof}" fill="${accentHex}" stroke="${shade(accentHex, -0.35)}" stroke-width=".8" stroke-linejoin="round"/></svg>`;
  cache.set(key, s);
  return s;
}

/** Fit a MultiPolygon list into a w x h glyph box; parts: [{ poly, fill }]. */
function polysGlyph(parts, faceHex, w, hgt) {
  const all = parts.map(p => p.poly).filter(p => p && p.length);
  if (!all.length) return `${svgOpen(w, hgt, '0 0 10 10')}</svg>`;
  const bb = P.bbox(P.union(...all));
  const pad = Math.max(bb.w, bb.h) * 0.12 + 0.5;
  const vb = `${bb.x0 - pad} ${-(bb.y1 + pad)} ${bb.w + 2 * pad} ${bb.h + 2 * pad}`;
  let s = `${svgOpen(w, hgt, vb)}<rect x="${bb.x0 - pad}" y="${-(bb.y1 + pad)}" width="${bb.w + 2 * pad}" height="${bb.h + 2 * pad}" rx="${pad}" fill="${faceHex}"/><g transform="scale(1,-1)">`;
  for (const p of parts) s += `<path d="${P.pathD(p.poly, 2)}" fill="${p.fill}" fill-rule="evenodd"/>`;
  return `${s}</g></svg>`;
}

/** A filled element drawn from its real parts (its texture or outline), centred, in its own colours. */
function filledGlyph(el, face, colorHex, w, hgt) {
  let parts = [];
  try { parts = elementParts({ ...el, anchor: 'c', x: 0, y: 0, rotation: 0, visible: true }, { w: 1e4, h: 1e4 }); } catch { parts = []; }
  return polysGlyph(parts.filter(p => p.poly?.length).map(p => ({ poly: p.poly, fill: p.op === 'cut' ? shade(face, -0.32) : colorHex(p.color || el.color) })), face, w, hgt);
}

/** A fill choice as a tile: solid, outline, or the texture itself. */
export function fillGlyph(kind, faceHex, accentHex, params, w = 52, hgt = 32) {
  const W = 60, H = 37;
  if (kind === 'solid' || kind === 'outline') {
    const body = kind === 'solid' ? `<rect x="-17" y="-11" width="34" height="22" rx="5" fill="${accentHex}"/>` : `<rect x="-16" y="-10" width="32" height="20" rx="4.5" fill="none" stroke="${accentHex}" stroke-width="2.6"/>`;
    return `${svgOpen(w, hgt, `${-W / 2} ${-H / 2} ${W} ${H}`)}<rect x="${-W / 2}" y="${-H / 2}" width="${W}" height="${H}" rx="2.5" fill="${faceHex}"/>${body}</svg>`;
  }
  return patternGlyph(kind, faceHex, accentHex, 'raise', w, hgt, params);
}

/**
 * A height map as a small shaded relief (light from the top left) in `accentHex`: about three features across.
 * The maps with edges are drawn from their exact cells (cells.js), every face a vector polygon shaded by its slope,
 * so the tile shows the same crisp facets the print will have. The smooth maps (and a picture, `{ w, h, bytes }`)
 * are shaded per pixel into a small image in the browser, and fall back to a grid of squares where there is no
 * document (tests, workers).
 */
const pictureIds = new WeakMap();
let pictureCount = 0;
export function mapGlyph(map, accentHex, w = 52, hgt = 32, { seed = 1, picture = null, invert = false, params = null, colors = null, colorMode = 'random' } = {}) {
  let pid = '';
  if (picture) { pid = pictureIds.get(picture); if (!pid) { pid = `pic${++pictureCount}`; pictureIds.set(picture, pid); } }
  // colours: the element's own and its cell colours, as #rrggbb (one colour when there are none)
  const hexes = Array.isArray(colors) && colors.length > 1 ? colors : [accentHex];
  const key = `m|${map}|${accentHex}|${w}|${hgt}|${seed}|${invert}|${pid}|${params ? JSON.stringify(params) : ''}|${hexes.join(',')}|${colorMode}`;
  if (cache.has(key)) return cache.get(key);
  const W = 60, H = 37, scale = W / 3.2;
  // brightness from the slope toward the light (rising to the lower right faces the top-left light) and the height
  const tone = (gx, gy, h) => Math.max(-0.6, Math.min(0.55, 0.3 * (gx - gy) * scale / Math.SQRT2 + (h - 0.5) * 0.3));
  let s = `${svgOpen(w, hgt, `${-W / 2} ${-H / 2} ${W} ${H}`)}`;
  const mesh = CELL_MAPS.has(map) ? cellMesh({ map, scale, angle: 0, seed, centre: [0, 0], params }, { x0: -W / 2, y0: -H / 2, x1: W / 2, y1: H / 2 }, scale / 5) : null;
  if (mesh) {
    // each cell's colour, as the texture's bodies pick it: by the tile's hash, or its mean height across the range
    const n = hexes.length, colOf = new Map();
    if (n > 1 && colorMode === 'height') {
      // as the bodies do it: each tile's mean height over its area
      const top = tileHeights(mesh);
      let lo = Infinity, hi = -Infinity;
      for (const m of top.values()) { lo = Math.min(lo, m); hi = Math.max(hi, m); }
      for (const [t, m] of top) colOf.set(t, Math.min(n - 1, Math.floor(((m - lo) / (hi - lo > 1e-6 ? hi - lo : 1)) * n)));
    }
    const hexOf = f => (n > 1 ? hexes[colorMode === 'height' ? colOf.get(f.tile) || 0 : Math.min(n - 1, Math.floor(hash(seed, f.tile & 0xffff, f.tile >>> 16, 13) * n))] : accentHex);
    s += `<g transform="scale(1,-1)" stroke-width=".3" stroke-linejoin="round">`;
    for (const f of mesh.faces) {
      const P3 = f.v.map(id => mesh.pts[id]), hs = f.h.map(h => (invert ? 1 - h : h));
      if (P3.every(p => p[0] < -W / 2) || P3.every(p => p[0] > W / 2) || P3.every(p => p[1] < -H / 2) || P3.every(p => p[1] > H / 2)) continue;
      // the face's plane from its widest triangle
      let bi = 1, bj = 2, best = -1;
      for (let i = 1; i < P3.length; i++) for (let j = i + 1; j < P3.length; j++) {
        const a = Math.abs((P3[i][0] - P3[0][0]) * (P3[j][1] - P3[0][1]) - (P3[j][0] - P3[0][0]) * (P3[i][1] - P3[0][1]));
        if (a > best) { best = a; bi = i; bj = j; }
      }
      const x1 = P3[bi][0] - P3[0][0], y1 = P3[bi][1] - P3[0][1], x2 = P3[bj][0] - P3[0][0], y2 = P3[bj][1] - P3[0][1];
      const h1 = hs[bi] - hs[0], h2 = hs[bj] - hs[0], d = x1 * y2 - x2 * y1;
      const gx = d ? (h1 * y2 - h2 * y1) / d : 0, gy = d ? (x1 * h2 - x2 * h1) / d : 0;
      const c = shade(hexOf(f), tone(gx, gy, hs.reduce((a, b) => a + b, 0) / hs.length));
      s += `<path d="M${P3.map(p => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join('L')}Z" fill="${c}" stroke="${c}"/>`;
    }
    s += '</g>';
  } else {
    const hf = heightFunction({ map, scale, seed, invert, picture, fit: 'stretch', box: { x0: -W / 2, y0: -H / 2, w: W, h: H }, params });
    // a smooth map's colours are height bands
    const bandHex = h => hexes[Math.min(hexes.length - 1, Math.floor(h * hexes.length))];
    let url = null;
    if (typeof document !== 'undefined') {
      try {
        // per pixel, at twice the tile's size, with the slope from the neighbouring samples
        const cw = 120, ch = 74, e = W / cw;
        const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
        const ctx = cv.getContext('2d'), img = ctx.createImageData(cw, ch);
        const rgbOf = hex => { const base = parseInt(hex.slice(1), 16); return [(base >> 16) & 255, (base >> 8) & 255, base & 255]; };
        const rgbs = hexes.map(rgbOf);
        for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
          const X = -W / 2 + (i + 0.5) * e, Y = H / 2 - (j + 0.5) * e, h = hf(X, Y);
          const rgb = rgbs[Math.min(rgbs.length - 1, Math.floor(h * rgbs.length))];
          const amt = tone((hf(X + e, Y) - hf(X - e, Y)) / (2 * e), (hf(X, Y + e) - hf(X, Y - e)) / (2 * e), h);
          const o = 4 * (j * cw + i);
          for (let k = 0; k < 3; k++) img.data[o + k] = amt < 0 ? rgb[k] * (1 + amt) : rgb[k] + (255 - rgb[k]) * amt;
          img.data[o + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        url = cv.toDataURL('image/png');
      } catch { url = null; }
    }
    if (url) s += `<image href="${url}" x="${-W / 2}" y="${-H / 2}" width="${W}" height="${H}" preserveAspectRatio="none"/>`;
    else {
      const cols = 30, rows = 18, cw = W / cols, ch = H / rows;
      const at = (i, j) => hf(-W / 2 + i * cw, H / 2 - j * ch);
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const amt = tone((at(i + 1, j + 0.5) - at(i, j + 0.5)) / cw, (at(i + 0.5, j) - at(i + 0.5, j + 1)) / ch, at(i + 0.5, j + 0.5));
        s += `<rect x="${(-W / 2 + i * cw).toFixed(2)}" y="${(-H / 2 + j * ch).toFixed(2)}" width="${(cw + 0.05).toFixed(2)}" height="${(ch + 0.05).toFixed(2)}" fill="${shade(bandHex(at(i + 0.5, j + 0.5)), amt)}"/>`;
      }
    }
  }
  s += `<rect x="${-W / 2 + 0.3}" y="${-H / 2 + 0.3}" width="${W - 0.6}" height="${H - 0.6}" rx="2.3" fill="none" stroke="rgba(0,0,0,.25)" stroke-width=".6"/></svg>`;
  cache.set(key, s);
  return s;
}
const pictureMemo = new WeakMap();
export function pictureOfData(data) {
  if (!data || typeof data.g !== 'string') return null;
  let p = pictureMemo.get(data);
  if (!p) { try { p = { w: data.w, h: data.h, bytes: b64ToBytes(data.g) }; } catch { p = null; } if (p) pictureMemo.set(data, p); }
  return p;
}

/** The glyph for an element in the stack or the inspector, in the design's colours. */
export function elementGlyph(el, design, colorHex, w = 34, hgt = 34) {
  const face = colorHex(design.face.color);
  const accent = colorHex(el.color);
  if ((el.kind === 'shape' || el.kind === 'text' || el.kind === 'svg') && isFilled(el)) return filledGlyph(el, face, colorHex, w, hgt);
  switch (el.kind) {
    case 'pattern': return patternGlyph(el.pattern, face, accent, el.op, w, hgt, el.params);
    case 'shape': return shapeGlyph(el.shape, face, accent, el.op, w, hgt);
    case 'grip': return gripGlyph(el.style, face, accent, w, hgt);
    case 'solid': return solidGlyph(el.shape, face, accent, w, hgt);
    case 'svg': {
      if (!el.groups?.length) return polysGlyph([], face, w, hgt);
      return polysGlyph(el.groups.filter(g => g.visible !== false).map(g => ({ poly: g.rings, fill: (g.op || 'raise') === 'cut' ? shade(face, -0.32) : colorHex(g.color) })), face, w, hgt);
    }
    case 'text': {
      // the element's own letters; while its font loads, a capital T in the face's colours
      let poly = [];
      try { poly = textOutline(el).poly; } catch { poly = []; }
      const ink = el.op === 'cut' ? shade(face, -0.32) : accent;
      if (poly.length) return polysGlyph([{ poly, fill: ink }], face, w, hgt);
      return `${svgOpen(w, hgt, '0 0 40 24')}<rect x="2" y="2" width="36" height="20" rx="2.5" fill="${face}"/><path d="M12 7h16v3h-6.5v9h-3v-9H12z" fill="${ink}"/></svg>`;
    }
    case 'image': {
      // its tones in their colours; a cut shows them as darker shades of the face
      const body = imageTones(el);
      if (!body) return polysGlyph([], face, w, hgt);
      return polysGlyph(body.tones.map((poly, i) => ({ poly, fill: el.op === 'cut' ? shade(face, -0.12 - 0.08 * i) : colorHex(el.stepColors?.[i] || 'c2') })), face, w, hgt);
    }
    case 'surface': return mapGlyph(el.map, accent, w, hgt, { seed: el.seed, invert: el.invert, picture: el.map === 'picture' ? pictureOfData(el.data) : null, params: el.texParams,
      colors: Array.isArray(el.cellColors) && el.cellColors.length ? [accent, ...el.cellColors.slice(0, 3).map(colorHex)] : null, colorMode: el.colorMode });
    case 'combine': case 'offset': {
      // what it comes to on the size shown (shown even while it is hidden)
      let poly = [];
      try { poly = derivedOutline(el, design, SIZE_BY_ID[design.sizes?.current] || SIZE_BY_ID['2W-1H']); } catch { poly = []; }
      return polysGlyph(poly.length ? [{ poly, fill: el.op === 'cut' ? shade(face, -0.32) : accent }] : [], face, w, hgt);
    }
    case 'path': {
      // the drawing's own outline; a cut shows as a darker shade of the face
      let poly = [];
      try { poly = pathOutline(el); } catch { poly = []; }
      return polysGlyph(poly.length ? [{ poly, fill: el.op === 'cut' ? shade(face, -0.32) : accent }] : [], face, w, hgt);
    }
    case 'mesh': {
      const b = meshBody(el);
      return polysGlyph(b ? [{ poly: b.footprint, fill: accent }] : [], face, w, hgt);
    }
    default: return '';
  }
}

export { GRIP_STYLES };
