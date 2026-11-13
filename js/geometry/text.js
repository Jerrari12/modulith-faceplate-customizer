// Text: the fonts, the layout and the outlines of the text element.
//
// Fonts are TrueType files under fonts/text (all SIL Open Font License, shipped unchanged), read by opentype.js
// (vendor/opentype, MIT), which is loaded the first time a text element needs it. Loading is asynchronous and the
// face builder is not, so textOutline() throws "loading" until its font has arrived; onFontLoaded() tells the app
// to rebuild, and ensureFonts() lets an export wait for every font a design uses.
//
// A glyph's contours become polygons by flattening its curves to within 0.02 mm and resolving the font's nonzero
// fill: every contour is cut at its own crossings into simple loops, and the loops are applied largest first, those
// turning the same way as the glyph's outline added and the others taken away. That handles nested shapes (a counter
// inside a bowl inside a ring) and the overlapping strokes that fonts instanced from variable masters carry
// (Fredoka's A is two overlapping outlines and no hole; Bitter's counters have spurs that cross into the stem).
//
// Size is the CAP height in mm (the height of an H), the measure a sign maker uses. Lines are set baseline to
// baseline at lineGap x the cap height, aligned left, centre or right, and the block is centred on the element's
// position from the top of the first line's capitals to the last baseline, so typing a descender does not move it.

import * as P from './polys.js';
import { rasterize, distanceTransform, components } from '../checks/raster.js';

export const FONTS = [
  { id: 'archivo', label: 'Archivo', style: 'ExtraBold', file: 'archivo-800.ttf', css: 'fpt-archivo' },
  { id: 'plex-sans', label: 'IBM Plex Sans', style: 'SemiBold', file: 'ibm-plex-sans-600.ttf', css: 'fpt-plex-sans' },
  { id: 'plex-mono', label: 'IBM Plex Mono', style: 'SemiBold', file: 'ibm-plex-mono-600.ttf', css: 'fpt-plex-mono' },
  { id: 'fredoka', label: 'Fredoka', style: 'SemiBold', file: 'fredoka-600.ttf', css: 'fpt-fredoka' },
  { id: 'bitter', label: 'Bitter', style: 'Bold', file: 'bitter-700.ttf', css: 'fpt-bitter' },
  { id: 'bungee', label: 'Bungee', style: 'Regular', file: 'bungee-400.ttf', css: 'fpt-bungee' },
  { id: 'pacifico', label: 'Pacifico', style: 'Regular', file: 'pacifico-400.ttf', css: 'fpt-pacifico' },
];
const BY_ID = new Map(FONTS.map(f => [f.id, f]));
export const fontDef = id => BY_ID.get(id) || FONTS[0];

export const TEXT_LIMITS = { maxChars: 200, maxLines: 8, minSize: 1, maxSize: 200 };
const TOL = 0.02;        // mm: how far a flattened curve may stray from the font's own
const SEG = 0.4;         // mm: the longest straight piece before an arc bends it

// ---- loading
const LIB_URL = new URL('../../vendor/opentype/opentype.min.js', import.meta.url);
const fontUrl = def => new URL(`../../fonts/text/${def.file}`, import.meta.url);
const loaded = new Map();     // id -> { font, cap, glyphs: Map, strokes: Map }
const pending = new Map();    // id -> Promise
const failed = new Map();     // id -> message
const listeners = new Set();
let libPromise = null;

function lib() {
  if (globalThis.opentype) return Promise.resolve(globalThis.opentype);
  libPromise ||= (async () => {
    if (typeof document !== 'undefined') {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = LIB_URL.href; s.onload = resolve; s.onerror = () => reject(new Error('the font reader did not load'));
        document.head.append(s);
      });
    } else {
      // Node (the tests): the UMD build sets globalThis.opentype when run as a plain script
      const { readFile } = await import('node:fs/promises');
      new Function(await readFile(LIB_URL, 'utf8'))();
    }
    if (!globalThis.opentype) throw new Error('the font reader did not load');
    return globalThis.opentype;
  })();
  return libPromise.catch(e => { libPromise = null; throw e; });
}

async function fontBytes(url) {
  if (url.protocol !== 'file:') {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.arrayBuffer();
  }
  const { readFile } = await import('node:fs/promises');
  const b = await readFile(url);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

/** Called with the font id whenever a font finishes loading (or fails to). */
export function onFontLoaded(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const tell = id => { for (const fn of listeners) { try { fn(id); } catch (e) { console.error(e); } } };

export const fontReady = id => loaded.has(fontDef(id).id);

export function loadFont(id) {
  const def = fontDef(id);
  if (loaded.has(def.id)) return Promise.resolve(loaded.get(def.id));
  if (!pending.has(def.id)) {
    pending.set(def.id, (async () => {
      try {
        const ot = await lib();
        const font = ot.parse(await fontBytes(fontUrl(def)));
        const os2 = font.tables.os2;
        const cap = os2?.sCapHeight > 0 ? os2.sCapHeight : (font.charToGlyph('H').getBoundingBox().y2 || 0.7 * font.unitsPerEm);
        const entry = { font, cap, glyphs: new Map(), strokes: new Map() };
        loaded.set(def.id, entry); failed.delete(def.id); pending.delete(def.id);
        tell(def.id);
        return entry;
      } catch (e) {
        // settled before the listeners hear of it: a rebuild they run at once must see "could not be loaded", not
        // "loading" (which would stay on the plate, with no later event to replace it)
        failed.set(def.id, e.message || String(e)); pending.delete(def.id);
        tell(def.id);
        throw e;
      }
    })());
  }
  return pending.get(def.id);
}

/** Load every font the design's visible text uses. Resolves true when any had to be loaded. */
export async function ensureFonts(design) {
  const ids = [...new Set((design?.elements || []).filter(e => e.kind === 'text' && e.visible !== false).map(e => fontDef(e.font).id))];
  const missing = ids.filter(id => !loaded.has(id));
  await Promise.allSettled(missing.map(loadFont));
  return missing.length > 0;
}

// ---- outlines
const numeric = v => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN);
const clamp = (v, a, b, d) => { const n = numeric(v); return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : d; };

/** The text as the element holds it, made safe: newlines only as \n, no other control characters, length and line
 *  count capped (a design file can come from anyone). */
export function cleanText(v) {
  // only a string or a number counts: String() on an object from a file can throw ({"toString": null})
  const s = (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '');
  return s.split('\n').slice(0, TEXT_LIMITS.maxLines).join('\n').slice(0, TEXT_LIMITS.maxChars);
}

/** Closed rings in font units from a glyph's path, curves flattened to within `tol` units. */
function flattenPath(cmds, tol) {
  const rings = [];
  let ring = null, cx = 0, cy = 0;
  const close = () => {
    if (ring) {
      const a = ring[0], b = ring[ring.length - 1];
      if (a[0] !== b[0] || a[1] !== b[1]) ring.push([a[0], a[1]]);
      if (ring.length >= 4) rings.push(ring);
    }
    ring = null;
  };
  const steps = d => Math.min(32, Math.max(1, Math.ceil(Math.sqrt(d / tol))));
  for (const c of cmds) {
    if (c.type === 'M') { close(); ring = [[c.x, c.y]]; cx = c.x; cy = c.y; continue; }
    if (!ring) { ring = [[cx, cy]]; }
    if (c.type === 'L') { ring.push([c.x, c.y]); cx = c.x; cy = c.y; }
    else if (c.type === 'Q') {
      // chord error of n uniform steps on a quadratic: |P0 - 2 P1 + P2| / (4 n^2)
      const n = steps(Math.hypot(cx - 2 * c.x1 + c.x, cy - 2 * c.y1 + c.y) / 4);
      for (let k = 1; k <= n; k++) { const t = k / n, m = 1 - t; ring.push([m * m * cx + 2 * m * t * c.x1 + t * t * c.x, m * m * cy + 2 * m * t * c.y1 + t * t * c.y]); }
      cx = c.x; cy = c.y;
    } else if (c.type === 'C') {
      // and on a cubic: 3/4 max(|P0 - 2 P1 + P2|, |P1 - 2 P2 + P3|) / n^2
      const d = Math.max(Math.hypot(cx - 2 * c.x1 + c.x2, cy - 2 * c.y1 + c.y2), Math.hypot(c.x1 - 2 * c.x2 + c.x, c.y1 - 2 * c.y2 + c.y));
      const n = steps(0.75 * d);
      for (let k = 1; k <= n; k++) {
        const t = k / n, m = 1 - t;
        ring.push([m * m * m * cx + 3 * m * m * t * c.x1 + 3 * m * t * t * c.x2 + t * t * t * c.x, m * m * m * cy + 3 * m * m * t * c.y1 + 3 * m * t * t * c.y2 + t * t * t * c.y]);
      }
      cx = c.x; cy = c.y;
    } else if (c.type === 'Z') close();
  }
  close();
  return rings;
}

/**
 * A closed ring that crosses itself, cut at its crossings into simple loops, each with its own turn. Font outlines
 * cross themselves where an instanced variable font overlaps its strokes: a lobe that turns with the outline adds
 * to it, one that turns against it (a counter's spur into a stem) is part of the stem, and only the loops' own turns
 * tell the two apart. Walks the ring with the crossings inserted; the second visit to a crossing closes a loop.
 */
export function splitLoops(ring) {
  const pts = ring.slice(0, -1), n = pts.length;
  if (n < 3) return [];
  const cuts = Array.from({ length: n }, () => []);
  let key = 0;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % n];
    const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;                   // neighbours across the closing point
      const [cx, cy] = pts[j], [dx, dy] = pts[(j + 1) % n];
      if (Math.max(cx, dx) < x0 || Math.min(cx, dx) > x1 || Math.max(cy, dy) < y0 || Math.min(cy, dy) > y1) continue;
      const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy, den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-12) continue;                    // parallel: no single crossing
      const t = ((cx - ax) * sy - (cy - ay) * sx) / den, u = ((cx - ax) * ry - (cy - ay) * rx) / den;
      if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) continue;
      const p = [ax + rx * t, ay + ry * t];
      cuts[i].push({ t, p, key }); cuts[j].push({ t: u, p, key }); key++;
    }
  }
  if (!key) return [ring];
  const seq = [];
  for (let i = 0; i < n; i++) { seq.push({ p: pts[i], key: -1 }); cuts[i].sort((a, b) => a.t - b.t); for (const c of cuts[i]) seq.push(c); }
  const loops = [], stack = [], at = new Map();
  const emit = list => { const r = list.map(v => v.p); r.push(r[0]); if (r.length >= 4) loops.push(r); };
  for (const v of seq) {
    if (v.key >= 0 && at.has(v.key)) {
      const loop = stack.splice(at.get(v.key));
      for (const w of loop) if (w.key >= 0) at.delete(w.key);
      emit(loop);
      stack.push({ p: v.p, key: -1 });                        // the crossing stays as the path's junction
    } else {
      if (v.key >= 0) at.set(v.key, stack.length);
      stack.push(v);
    }
  }
  if (stack.length >= 3) emit(stack);
  return loops;
}

/** Resolve a glyph's nonzero fill from its rings: every ring cut into simple loops, then the loops applied largest
 *  first, those turning like the glyph's outline added and the others taken away. */
export function resolveNonzero(rings) {
  const signed = rings.flatMap(splitLoops).map(r => ({ r, a: P.ringArea(r) })).filter(x => Math.abs(x.a) > 1e-9);
  if (!signed.length) return [];
  signed.sort((p, q) => Math.abs(q.a) - Math.abs(p.a));
  const outer = Math.sign(signed[0].a);
  let mp = [];
  for (const { r, a } of signed) mp = Math.sign(a) === outer ? P.union(mp, [[r]]) : P.difference(mp, [[r]]);
  return mp;
}

/** A glyph as a MultiPolygon in font units, cached per glyph and flattening grain. */
function glyphPoly(entry, g, tolUnits) {
  const grain = 2 ** Math.floor(Math.log2(Math.max(0.05, tolUnits)));
  const key = `${g.index}|${grain}`;
  let mp = entry.glyphs.get(key);
  if (mp) return mp;
  const rings = flattenPath(g.path?.commands || [], grain);
  try { mp = resolveNonzero(rings); } catch { mp = resolveNonzero(rings.map(r => r.map(([x, y]) => [Math.round(x * 64) / 64, Math.round(y * 64) / 64]))); }
  entry.glyphs.set(key, mp);
  return mp;
}

/** Points no more than `seg` apart along a closed ring (so a bend curves its straight edges). */
function densify(ring, seg) {
  const out = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / seg));
    for (let k = 0; k < n; k++) out.push([ax + (bx - ax) * k / n, ay + (by - ay) * k / n]);
  }
  out.push([out[0][0], out[0][1]]);
  return out;
}

/**
 * Bend a laid-out block round a circle whose arc through the origin is the block's centre line. deg > 0 arches it
 * up (text over the top of a circle), deg < 0 curves it down. The radius is held at least 5 % beyond the block's
 * far side from the centre, so letters never turn inside out; returns the angle actually used.
 */
function bendPoly(mp, deg, width, yLo, yHi) {
  let th = Math.abs(deg) * Math.PI / 180;
  if (th < 1e-6 || width <= 0) return { mp, deg: 0 };
  const up = deg > 0;
  const reach = up ? -yLo : yHi;                     // how far the letters stretch toward the centre
  let R = width / th;
  if (R < 1.05 * reach) { R = 1.05 * reach; th = width / R; }
  const warp = ([x, y]) => { const a = x / R, r = up ? R + y : R - y; return up ? [r * Math.sin(a), r * Math.cos(a) - R] : [r * Math.sin(a), R - r * Math.cos(a)]; };
  const bent = mp.map(poly => poly.map(ring => densify(ring, SEG).map(warp)));
  // a full ring can bring the two ends together: union cleans any overlap into one outline
  let out;
  try { out = P.unionPieces([bent]); } catch { out = bent; }
  return { mp: out, deg: Math.sign(deg) * th * 180 / Math.PI };
}

const layouts = new Map();
const LAYOUT_CACHE = 64;

/**
 * The element's text as a MultiPolygon in mm, centred on its own origin (before placement), with what the builder
 * and the checks need: { poly, width, height, glyphs (the inked glyphs used), missing (characters the font lacks),
 * bend (the arc actually used, in degrees) }. Throws while the font is loading, or if it could not be loaded.
 */
export function textOutline(el) {
  const def = fontDef(el.font);
  const entry = loaded.get(def.id);
  if (!entry) {
    if (failed.has(def.id) && !pending.has(def.id)) throw Object.assign(new Error(`the ${def.label} font could not be loaded (${failed.get(def.id)}), so its letters are missing`), { code: 'font-failed' });
    loadFont(def.id).catch(() => { /* reported through failed */ });
    throw Object.assign(new Error(`loading the ${def.label} font`), { code: 'font-loading' });
  }
  const text = cleanText(el.text);
  const size = clamp(el.size, TEXT_LIMITS.minSize, TEXT_LIMITS.maxSize, 10);
  const spacing = clamp(el.spacing, -50, 100, 0), lineGap = clamp(el.lineGap, 0.5, 10, 1.6), bend = clamp(el.bend, -360, 360, 0);
  const align = el.align === 'left' || el.align === 'right' ? el.align : 'centre';
  const sig = JSON.stringify([def.id, text, size, spacing, lineGap, align, bend]);
  const hit = layouts.get(sig);
  if (hit) { layouts.delete(sig); layouts.set(sig, hit); return hit; }

  const { font, cap } = entry;
  const s = size / cap;                   // mm per font unit
  const tolUnits = TOL / s, track = spacing / s, gap = lineGap * cap;
  const lines = text.split('\n');
  const used = new Map(), missing = new Set();
  const set = lines.map(line => {
    for (const ch of line) if (ch.trim() && font.charToGlyphIndex(ch) === 0) missing.add(ch);
    const glyphs = font.stringToGlyphs(line);
    const items = [];
    let x = 0;
    glyphs.forEach((g, i) => {
      if (g.index !== 0) items.push({ g, x });
      x += g.advanceWidth || 0;
      if (i < glyphs.length - 1) x += font.getKerningValue(g.index, glyphs[i + 1].index) + track;
    });
    return { items, width: Math.max(0, x) };
  });
  const maxW = Math.max(0, ...set.map(l => l.width));
  const blockH = cap + (lines.length - 1) * gap;
  const pieces = [];
  set.forEach((L, k) => {
    const x0 = align === 'left' ? -maxW / 2 : align === 'right' ? maxW / 2 - L.width : -L.width / 2;
    const y0 = blockH / 2 - cap - k * gap;
    for (const { g, x } of L.items) {
      const gp = glyphPoly(entry, g, tolUnits);
      if (!gp.length) continue;
      used.set(g.index, g);
      pieces.push(P.transform(gp, ([u, v]) => [(x0 + x + u) * s, (y0 + v) * s]));
    }
  });
  let poly = pieces.length ? P.unionPieces(pieces) : [];
  let used_bend = 0;
  if (bend && poly.length) {
    const b = P.bbox(poly);
    const r = bendPoly(poly, bend, maxW * s, b.y0, b.y1);
    poly = r.mp; used_bend = r.deg;
  }
  const out = { poly, width: maxW * s, height: blockH * s, glyphs: [...used.values()], missing: [...missing], bend: used_bend, font: def.id, size };
  layouts.set(sig, out);
  if (layouts.size > LAYOUT_CACHE) layouts.delete(layouts.keys().next().value);
  return out;
}

// ---- stroke width, for the checks
/** 8-connected components of a mask (material pairs with a 4-connected background: a staircase edge stays whole). */
function count8(mask, w, h, stack) {
  const seen = new Uint8Array(w * h);
  let count = 0;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || seen[s]) continue;
    count++;
    let sp = 0; stack[sp++] = s; seen[s] = 1;
    while (sp) {
      const p = stack[--sp], i = p % w, j = (p - i) / w;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const x = i + di, y = j + dj;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const q = y * w + x;
        if (mask[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
      }
    }
  }
  return count;
}

/**
 * The thinnest stroke of a shape, in the units of `mp`: the narrowest width at which opening the shape by a disc
 * (what a nozzle of that width can trace) changes its topology - a stroke breaks in two, a counter opens into
 * another, or a piece vanishes. Tapered ends and sharp corners only shrink under an opening, so they do not count;
 * a hairline crossbar does. Searched between 1 cell and `maxCells`; returns Infinity when nothing breaks by then.
 */
export function polyStroke(mp, res, maxCells = 30) {
  const b = P.bbox(mp);
  if (!b) return Infinity;
  const pad = maxCells + 3;
  const w = Math.ceil(b.w / res) + 2 * pad, h = Math.ceil(b.h / res) + 2 * pad;
  const inside = rasterize(mp, b.x0 - pad * res, b.y0 - pad * res, w, h, res);
  const n = w * h;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = inside[i] ? 0 : 1;
  const stack = new Int32Array(n + 1);          // count8 pushes each cell at most once
  const baseIn = count8(inside, w, h, stack), baseOut = components(out, w, h).count;
  if (!baseIn) return Infinity;
  const dt = distanceTransform(inside, w, h);
  const away = new Uint8Array(n), opened = new Uint8Array(n), rest = new Uint8Array(n);
  const breaks = rho => {
    for (let i = 0; i < n; i++) away[i] = inside[i] && dt[i] >= rho ? 0 : 1;
    const dc = distanceTransform(away, w, h);     // distance to the nearest disc centre
    for (let i = 0; i < n; i++) { opened[i] = inside[i] && dc[i] <= rho ? 1 : 0; rest[i] = opened[i] ? 0 : 1; }
    return count8(opened, w, h, stack) !== baseIn || components(rest, w, h).count !== baseOut;
  };
  if (!breaks(maxCells)) return Infinity;
  let lo = 0.5, hi = maxCells;
  for (let k = 0; k < 8; k++) { const mid = (lo + hi) / 2; if (breaks(mid)) hi = mid; else lo = mid; }
  // a centre with distance d to the nearest empty cell spans about 2d - 1 cells of material
  return Math.max(1, 2 * hi - 1) * res;
}

const STROKE_RES = 1 / 120;   // of the cap height

/** A glyph's thinnest stroke as a share of the cap height (Infinity for a glyph with nothing thin in it). */
function glyphStroke(entry, g) {
  if (entry.strokes.has(g.index)) return entry.strokes.get(g.index);
  const gp = glyphPoly(entry, g, entry.cap / 400);
  const v = gp.length ? polyStroke(P.scale(gp, 1 / entry.cap), STROKE_RES) : Infinity;
  entry.strokes.set(g.index, v);
  return v;
}

/** The element's thinnest stroke in mm and the character it is in, or null (no font yet, no ink). */
export function textStroke(el) {
  const def = fontDef(el.font), entry = loaded.get(def.id);
  if (!entry) return null;
  let t;
  try { t = textOutline(el); } catch { return null; }
  let best = Infinity, ch = '';
  for (const g of t.glyphs) {
    const v = glyphStroke(entry, g);
    if (v < best) { best = v; ch = g.unicode != null ? String.fromCodePoint(g.unicode) : ''; }
  }
  return Number.isFinite(best) ? { mm: best * t.size, char: ch } : { mm: Infinity, char: '' };
}
