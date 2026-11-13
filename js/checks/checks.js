// Printability checks, modelled on the sign builder's ADA checks: each check is a small record with an id, a
// state (pass / warn / fail / info), a label, a detail sentence, a short form for the status bar and, where it
// helps, a point on the plate to highlight and the element that caused it.
//
// The rules follow the two design modes:
//  - Face Down: the decorated face goes on the bed (Essential, Chevron). Everything that stands proud of the
//    face is the first layer, so it all has to reach one plane; anything lower is bridged over, so recesses
//    must be narrow. Grips are not allowed.
//  - Face Up: the backer goes on the bed and the face prints upwards. Features need support under them,
//    undercuts become overhangs, and bridges span gaps.
// Both: nothing under z = 0 (enforced by the builder), screw holes stay clear when handle holes are on, and
// features thinner than the nozzle can lay down vanish.

import * as P from '../geometry/polys.js';
import { rasterize, regionStats, components, frameFor, distanceTransform } from './raster.js';
import { handleMount, ELEMENT_DEFS } from '../geometry/face.js';
import { linkedCells, woodWobble, stippleRoom, cleanPatternParams } from '../geometry/patterns.js';
import { isFilled } from '../geometry/fill.js';
import { GRIP_STRENGTH } from '../geometry/grips.js';
import { textStroke } from '../geometry/text.js';
import { finestFeature } from '../geometry/cells.js';

export const PRINT_LIMITS = {
  nozzle: 0.4,          // mm: a feature narrower than this does not print at all
  minWall: 0.8,         // mm: two perimeters; narrower prints as a single fragile line
  minGroove: 0.25,      // mm: the Chevron's groove; narrower closes up
  bridgeOk: 4,          // mm: a gap this wide bridges cleanly
  bridgeWarn: 12,       // mm: bridges, with a rough underside; beyond this needs support
  ledgeOk: 1,           // mm a flat ledge may stick out past its support and still print clean
  ledgeWarn: 3,         // mm: droops; beyond this it prints in mid-air
  overhangOk: 45,       // degrees from vertical
  overhangWarn: 60,
  maxHeightWarn: 25,    // mm above the face
  holeClear: 1.0,       // mm of clear face around each screw hole
  handleZone: { w: 56, h: 12 },  // mm: where a bolt-on handle's base sits
  tinyPadMm2: 2,        // mm2: a first-layer island smaller than this may not stick
  crumbMm2: 0.05,       // mm2: an inlaid crumb this small (a hairline spike the raster cuts loose) is not a piece
  meshOverhangMm2: 20,  // mm2 of down-facing surface a sculpt may carry before it needs support
  res: 0.1,             // mm per raster cell
  bedSmall: { w: 250, l: 220 }, // Core One; larger plates need the XL
};

const fmt = v => (Math.round(v * 100) / 100).toString();

/** Add a check, unless the same element already has the same check saying the same thing (a symmetry twin on a
 *  symmetric plate repeats its original word for word; a twin over an asymmetric cut does not, and is kept). */
function add(list, c) {
  if (c.elementId && list.some(o => o.id === c.id && o.elementId === c.elementId && o.det === c.det)) return c;
  list.push(c); return c;
}

/** An element counts as hidden from half its drawn area lost, wholly hidden from 95 %; specks under 0.5 mm2 are not judged. */
export const HIDDEN = { warn: 0.5, all: 0.95, minArea: 0.5 };

/**
 * The elements you will not see on this plate: half or more of one is covered by another element or falls off the
 * plate, measured from the front against the area it was drawn at. A flat element is covered by any body (bodies
 * keep their footprints, whether they come before or after it) and by any flat element after it (later wins); a body
 * only by a taller body (of the same height, a later one), not stacked on it nor it on that one: two bodies that
 * overlap both print, and the shorter one is buried in the taller. A 3D texture on an element's outline dresses
 * that element and never counts against it; patterns and textures are not judged themselves. [{ E, lost, cause, by, at }]
 */
function hiddenElements(built) {
  const D = built.drawn || [], out = [];
  out.judged = 0;
  const areaOf = list => (list.length ? P.area(list.length === 1 ? list[0] : P.union(...list)) : 0);
  // (nothing left on the plate, an element wholly off it, has no box)
  const box = mp => { const b = P.bbox(mp); return b && Number.isFinite(b.x0) ? b : null; };
  const meets = (a, b) => a && b && a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  // each element's cover is merged once, and only when its box meets something it could hide
  const merged = new Map(), boxes = new Map();
  const coverBox = L => { if (!boxes.has(L)) boxes.set(L, box([].concat(...L.cover))); return boxes.get(L); };
  const coverPoly = L => { if (!merged.has(L)) merged.set(L, P.union(...L.cover)); return merged.get(L); };
  D.forEach((E, i) => {
    if (!E.flag || !E.full.length) return;
    const area0 = areaOf(E.full);
    if (!(area0 >= HIDDEN.minArea)) return;
    out.judged++;
    const own = E.placed.length ? P.union(...E.placed) : [], reach = E.clipped.length ? P.union(...E.clipped) : own, rb = box(reach);
    const covers = D.filter((L, j) => L !== E && L.cover.length && L.target !== E.id
      && (E.body ? L.body && L.stackOn !== E.id && E.stackOn !== L.id && (L.top > E.top + 1e-6 || (L.top > E.top - 1e-6 && j > i)) : L.body || j > i)
      && meets(rb, coverBox(L)))
      .map(L => ({ L, poly: coverPoly(L) }));
    const visible = covers.length && !P.isEmpty(own) ? P.difference(own, ...covers.map(c => c.poly)) : own;
    const shown = P.area(visible), lostShare = 1 - shown / area0;
    if (lostShare < HIDDEN.warn) return;
    // the bigger of the two losses names the cause: off the plate, or under something (placed there or after it)
    const clippedArea = P.area(reach), edge = Math.max(0, area0 - clippedArea), under = Math.max(0, clippedArea - shown);
    const by = covers.map(c => ({ L: c.L, a: P.area(P.intersection(c.poly, reach)) })).sort((a, b) => b.a - a.a)[0];
    out.push({ E, lost: lostShare, edge: edge / area0, under: under / area0, cause: edge >= under ? 'edge' : 'covered', by: by && by.a > 0 ? by.L : null, at: rb ? [(rb.x0 + rb.x1) / 2, (rb.y0 + rb.y1) / 2] : undefined });
  });
  return out;
}

function statsFor(poly, frame, limits, keep = null) {
  if (P.isEmpty(poly)) return [];
  const mask = rasterize(poly, frame.x0, frame.y0, frame.w, frame.h, frame.res);
  const stats = regionStats(mask, frame.w, frame.h, frame.res, frame.x0, frame.y0);
  if (keep) markEdge(stats, mask, frame, limits, keep);
  return stats;
}

/**
 * For each thin piece, the share of its cells lying within its own width (plus a cell and a half) of the plate's
 * outline or a hole (`keep`'s edge). A sliver left where a pattern meets the edge runs ALONG it, so nearly all of it
 * lies that close; a thin line that reaches the edge crosses it, and only its end does. Only pieces under the
 * two-perimeter width are measured.
 */
const EDGE_SHARE = 0.6;
function markEdge(stats, mask, frame, limits, keep) {
  const thin = stats.filter(s => s.maxWidth < limits.minWall);
  if (!thin.length) return;
  const { w, h } = frame, n = w * h;
  const km = rasterize(keep, frame.x0, frame.y0, w, h, frame.res);
  const dk = distanceTransform(km, w, h);          // how far each cell is inside the plate's usable face
  const { labels } = components(mask, w, h);       // the same labelling regionStats used
  const reach = new Map(thin.map(s => [s.label, s.maxWidth / frame.res + 1.5])), cells = new Map(), near = new Map();
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (!l || !reach.has(l)) continue;
    cells.set(l, (cells.get(l) || 0) + 1);
    if (dk[i] <= reach.get(l)) near.set(l, (near.get(l) || 0) + 1);
  }
  for (const s of thin) s.edge = (near.get(s.label) || 0) / (cells.get(s.label) || 1);
}
const atEdge = s => (s.edge || 0) >= EDGE_SHARE;

/** One note for the slivers along the plate edge or the holes: they will not print, and nothing visible is lost. */
function edgeNote(out, slivers, limits) {
  if (!slivers.length) return;
  const w = worstBy(slivers, s => -s.maxWidth);
  add(out, { id: 'edge', st: 'info', lbl: 'Slivers along the edge', det: `${slivers.length} sliver${slivers.length > 1 ? 's' : ''} under ${limits.minWall} mm (thinnest ${fmt(w.maxWidth)} mm) run${slivers.length > 1 ? '' : 's'} along the plate edge or a hole, where the design meets it. The thinnest will not print; that loses nothing you can see.`, short: `${slivers.length} edge sliver${slivers.length > 1 ? 's' : ''}`, geo: { at: w.at } });
}

/** Narrowest solid and narrowest gap a pattern element produces, before clipping (exact, from its parameters). */
function patternWidths(el) {
  const p = el.params || {};
  let solid = Infinity, gap = Infinity;
  switch (el.pattern) {
    // measured with the generators' own limits, so a setting the generator overrides is not reported as drawn
    case 'stripes': { const pitch = Math.max(0.5, p.pitch), width = Math.min(Math.max(0.1, p.width), pitch); solid = width; gap = pitch - width; break; }
    case 'chevron': {
      const perp = p.pitch * Math.cos((p.angle ?? 45) * Math.PI / 180);
      const seamed = (p.layout || 'chevron') === 'chevron' || p.layout === 'reverse';
      solid = perp - (p.groove ?? 0.25); gap = Math.min(p.groove ?? 0.25, seamed && p.seam > 0 ? p.seam : Infinity); break;
    }
    case 'truchet': {
      // arcs from opposite corners of a cell come closest on its diagonal: corner-to-corner minus two radii
      const { cw, ch } = linkedCells(p, 100, 100);
      solid = p.width ?? 1.6;
      gap = Math.hypot(cw, ch) - (cw + ch) / 2 - solid;
      if (p.tiles === 'angles') gap = Math.min(cw, ch) / Math.SQRT2 - solid;
      break;
    }
    case 'waves': {
      const { ch } = linkedCells(p, 100, 100);
      solid = p.width ?? 1.6; gap = ch - 2 * (p.amplitude ?? 2) - solid; break;
    }
    case 'grid': solid = p.lineWidth; gap = Math.min(p.pitchX, p.pitchY) - p.lineWidth; break;
    case 'dots': solid = p.diameter; gap = Math.min(p.pitchX, p.pitchY) - p.diameter; break;
    case 'bricks': { const w = Math.max(1, p.brickW), h = Math.max(1, p.brickH), g = Math.max(0, Math.min(p.gap, Math.min(w, h) - 0.2)); solid = Math.min(w, h) - g; gap = g; break; }
    case 'hex': { const size = Math.max(1, p.size), g = Math.max(0, Math.min(p.gap, size - 0.2)); solid = size - g; gap = g; break; }
    case 'checker': { const size = Math.max(1, p.size), g = Math.max(0, Math.min(p.gap || 0, size - 0.2)); solid = size - g; gap = g; break; }
    // the textures, measured with the generators' own limits (a ring wider than its pitch is drawn pitch - 0.2 wide)
    case 'knurl': { const pitch = Math.max(0.8, p.pitch), groove = Math.max(0.1, Math.min(p.groove, pitch - 0.2)); solid = pitch - groove; gap = groove; break; }
    case 'ripple': { const pitch = Math.max(0.8, p.pitch), width = Math.max(0.2, Math.min(p.width, pitch - 0.2)); solid = width; gap = pitch - width; break; }
    case 'wood': {
      // every line follows the same sway, so neighbours stay a pitch apart across the grain; where the grain is
      // steepest a line's vertical width narrows by the cosine of its slope, and the wobbles can bring two closer
      const slope = Math.atan(2 * Math.PI * Math.max(0, p.wave ?? 1) / Math.max(5, p.length || 30) * 1.4);
      const pitch = Math.max(0.5, p.pitch), width = Math.max(0.2, Math.min(p.width, pitch - 0.2));
      solid = width * Math.cos(slope); gap = (pitch - width - 2 * woodWobble(p)) * Math.cos(slope); break;
    }
    case 'stipple': { const s = Math.max(0.5, p.spacing), d = 2 * Math.max(0.1, Math.min(p.diameter, s - 0.2) / 2); solid = d; gap = s - d - 2 * stippleRoom(p); break; }
  }
  if (el.invert) [solid, gap] = [gap, solid];
  return { solid, gap };
}

/**
 * Exact feature / groove widths per element: [{ el, feature, groove, stroke? }] where either may be Infinity (none).
 * Text has no exact width; its letters' thinnest stroke is measured from the glyphs (stroke: true marks that, and
 * `char` names the letter it is in). The material left between cut letters is left to the raster checks.
 */
function elementWidths(design) {
  const out = [];
  for (const el of design.elements) {
    if (el.visible === false) continue;
    let solid = Infinity, gap = Infinity, extra = {};
    if (el.kind === 'pattern') ({ solid, gap } = patternWidths(el));
    else if (el.kind === 'shape') solid = el.shape === 'circle' ? el.w : Math.min(el.w, el.h);
    else if (el.kind === 'grip') solid = Math.min(el.length, el.depth);
    else if (el.kind === 'solid') solid = Math.min(el.w, el.h);
    else if (el.kind === 'text') { const st = textStroke(el); if (st && Number.isFinite(st.mm)) { solid = st.mm; extra = { stroke: true, char: st.char }; } }
    else continue;
    // a fill: an outline is as wide as its border; a texture's own pieces and gaps, and its border, count too
    if (isFilled(el)) {
      const border = Number(el.border) || 0;
      let fs = Infinity, fg = Infinity;
      if (el.fill === 'outline') fs = border > 0 ? border : Infinity;
      else { ({ solid: fs, gap: fg } = patternWidths({ pattern: el.fill, params: cleanPatternParams(el.fill, el.fillParams) })); if (border > 0) fs = Math.min(fs, border); }
      if (fs < solid) { solid = fs; extra = { fill: true }; }
      gap = Math.min(gap, fg);
    }
    if (!Number.isFinite(solid) && !Number.isFinite(gap)) continue;
    // a raise's solid is the feature and its gap the groove; a cut is the other way round; an inlay is flush, so
    // nothing closes up, but both its own pieces and the face left between them have to print in their colours
    const op = el.kind === 'grip' || el.kind === 'solid' ? 'raise' : el.op;
    if (op === 'inlay' && (el.color || design.face.color) === design.face.color) continue;   // the face's own colour: it is face
    if (op === 'cut') out.push({ el, feature: gap, groove: solid, ...extra });
    else if (op === 'inlay') out.push({ el, feature: Math.min(solid, gap), groove: Infinity, between: gap < solid, ...extra });
    else out.push({ el, feature: solid, groove: gap, ...extra });
  }
  return out;
}

/** How a width finding names its element: "Kitchen is 0.3 mm wide", or for text "Kitchen's thinnest strokes (in a) are about 0.3 mm wide". */
const widthText = (w, v) => w.fill ? `${w.el.name}'s fill makes pieces ${fmt(v)} mm wide`
  : w.stroke ? `${w.el.name}'s thinnest strokes${w.char ? ` (in “${w.char}”)` : ''} are about ${fmt(v)} mm wide`
  : w.between ? `${w.el.name} leaves strips of face ${fmt(v)} mm wide between its inlaid pieces` : `${w.el.name} is ${fmt(v)} mm wide`;

/**
 * The pieces of `layerPoly` that are unsupported in their entirety: islands with no anchor to any supported
 * material, found by comparing connected components of the layer with those of its unsupported part.
 * Returns [{ at: [x, y], areaMm2 }].
 */
function islandsOf(layerPoly, unsupportedPoly, frame) {
  const lm = rasterize(layerPoly, frame.x0, frame.y0, frame.w, frame.h, frame.res);
  const um = rasterize(unsupportedPoly, frame.x0, frame.y0, frame.w, frame.h, frame.res);
  const L = components(lm, frame.w, frame.h), U = components(um, frame.w, frame.h);
  if (!U.count) return [];
  const lCells = new Int32Array(L.count + 1), uCells = new Int32Array(U.count + 1), parent = new Int32Array(U.count + 1), firstAt = new Int32Array(U.count + 1).fill(-1);
  for (let p = 0; p < frame.w * frame.h; p++) {
    const l = L.labels[p], u = U.labels[p];
    if (l) lCells[l]++;
    if (u) { uCells[u]++; if (l) parent[u] = l; if (firstAt[u] < 0) firstAt[u] = p; }
  }
  const out = [];
  for (let u = 1; u <= U.count; u++) {
    if (!parent[u] || uCells[u] < 0.98 * lCells[parent[u]]) continue;
    const p = firstAt[u], i = p % frame.w, j = (p - i) / frame.w;
    out.push({ at: [frame.x0 + (i + 0.5) * frame.res, frame.y0 + (j + 0.5) * frame.res], areaMm2: uCells[u] * frame.res * frame.res });
  }
  return out;
}

/**
 * How a block's base is held where nothing is directly under it. Each unsupported piece of the base is classed by how
 * many separate supports it touches: none (it floats), one (a ledge sticking out, judged by its length) or two or
 * more (a bridge, judged by its span: twice the farthest it gets from support, so two posts 32 mm apart give 32).
 * The frame is padded by the base's diagonal so its border, which the distance transform treats as support, is
 * always farther than any real support. Returns the worst piece of each kind: { float, ledge, bridge } in mm.
 */
function blockSupport(base, support, limits) {
  const b = P.bbox(base);
  const out = { float: null, ledge: null, bridge: null };
  if (!b) return out;
  const res = Math.max(limits.res, 0.2), m = Math.hypot(b.w, b.h) + 1;
  const W = Math.ceil((b.w + 2 * m) / res), H = Math.ceil((b.h + 2 * m) / res), x0 = b.x0 - m, y0 = b.y0 - m;
  const baseM = rasterize(base, x0, y0, W, H, res), supM = P.isEmpty(support) ? new Uint8Array(W * H) : rasterize(support, x0, y0, W, H, res);
  const away = new Uint8Array(W * H), loose = new Uint8Array(W * H), held = new Uint8Array(W * H);
  for (let i = 0; i < away.length; i++) { away[i] = supM[i] ? 0 : 1; loose[i] = baseM[i] && !supM[i] ? 1 : 0; held[i] = baseM[i] && supM[i] ? 1 : 0; }
  const dt = distanceTransform(away, W, H);
  const U = components(loose, W, H), S = components(held, W, H);
  const touch = Array.from({ length: U.count + 1 }, () => new Set()), far = new Float32Array(U.count + 1), at = new Int32Array(U.count + 1).fill(-1);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const p = j * W + i, u = U.labels[p];
    if (!u) continue;
    if (dt[p] > far[u]) { far[u] = dt[p]; at[u] = p; }
    for (const q of [p - 1, p + 1, p - W, p + W]) { const s = S.labels[q]; if (s) touch[u].add(s); }
  }
  for (let u = 1; u <= U.count; u++) {
    const p = at[u], pt = p >= 0 ? [x0 + ((p % W) + 0.5) * res, y0 + (Math.floor(p / W) + 0.5) * res] : null;
    const kind = touch[u].size === 0 ? 'float' : touch[u].size === 1 ? 'ledge' : 'bridge';
    const mm = kind === 'bridge' ? 2 * far[u] * res : far[u] * res;
    if (!out[kind] || mm > out[kind].mm) out[kind] = { mm, at: pt };
  }
  return out;
}

function worstBy(stats, pick) {
  let best = null;
  for (const s of stats) if (!best || pick(s) > pick(best)) best = s;
  return best;
}

/** Run every check on a built face. Returns { checks, status: 'pass'|'warn'|'fail', counts }. */
export function runChecks(built, design, size, limits = PRINT_LIMITS) {
  const out = [];
  const t = built.t;
  const mode = design.mode === 'up' ? 'up' : 'down';
  const layers = built.layers, solids = built.solids;
  const raised = layers.filter(L => L.z1 > t + 1e-6);
  const zTop = Math.max(t, ...layers.map(L => L.z1), ...solids.map(s => s.z1));
  const plateBox = P.bbox(built.plate);
  const frame = frameFor(plateBox, limits.res);
  const eps = 1e-6;

  add(out, { id: 'mode', st: 'info', lbl: mode === 'down' ? 'Face Down design' : 'Face Up design',
    det: mode === 'down' ? 'The decorated face prints on the bed, like the Essential and Chevron plates. Everything proud of the face must reach one plane, and recesses are bridged over.'
      : 'The backer prints on the bed and the face builds upwards. Grips and tall relief are fine; undercuts and unsupported features are checked as overhangs.',
    short: mode === 'down' ? 'face down' : 'face up' });

  // a note is information, except one that leaves something out of the print (a font that would not load)
  for (const n of built.notes) add(out, { id: 'note', st: n.level === 'fail' ? 'fail' : 'info', lbl: n.level === 'fail' ? 'Missing from the print' : 'Builder note', det: n.text, short: n.level === 'fail' ? 'letters missing' : 'note', elementId: n.elementId });

  // ---- handle holes and the handle's seat
  const mount = handleMount(design);
  const faceOn = built.faceOn !== false;
  if (mount === 'knob') {
    const k = built.holeList[0];
    const clear = P.circle(k.x, k.y, k.d / 2 + limits.holeClear, 32);
    const hit = P.intersection(P.union(...raised.map(L => L.poly), ...solids.map(s => s.footprint)), clear);
    if (!P.isEmpty(hit)) add(out, { id: 'holes', st: 'fail', lbl: 'Knob hole covered', det: `Relief sits within ${limits.holeClear} mm of the knob hole. The knob's screw passes through here, so keep it clear.`, short: 'knob hole covered', geo: { at: [k.x, k.y] } });
    add(out, { id: 'knob', st: 'fail', lbl: 'Knob mount not ready', det: `A centre knob also needs a reworked backer, and this export still carries the standard Essential backer, which has no centre hole. Design and preview with it; it cannot be fitted until the knob backer exists.`, short: 'knob backer needed', geo: { at: [k.x, k.y] } });
  } else if (mount === 'pair') {
    const clear = P.union(...size.holes.map(h => P.circle(h.x, h.y, h.d / 2 + limits.holeClear, 32)));
    const raisedPoly = P.union(...raised.map(L => L.poly), ...solids.map(s => s.footprint));
    const hit = P.intersection(raisedPoly, clear);
    if (!P.isEmpty(hit)) {
      const b = P.bbox(hit);
      add(out, { id: 'holes', st: 'fail', lbl: 'Screw holes covered', det: `Relief sits within ${limits.holeClear} mm of a handle screw hole. The M3 screws pass through the face here, so keep this clear or switch the handle holes off.`, short: 'screw holes covered', geo: { at: [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2] } });
    } else {
      const hx = (size.holes[0].x + size.holes[1].x) / 2, hy = (size.holes[0].y + size.holes[1].y) / 2;
      const zone = P.rect(hx - limits.handleZone.w / 2, hy - limits.handleZone.h / 2, hx + limits.handleZone.w / 2, hy + limits.handleZone.h / 2);
      const under = P.intersection(raisedPoly, zone);
      // with the face off the seat is the backer's own flat front, so nothing is cut below it
      const cutUnder = faceOn ? P.intersection(P.difference(zone, P.union(...layers.filter(L => L.z1 >= t - eps).map(L => L.poly))), built.keep) : [];
      // narrow grooves under the handle (the Chevron's 0.25 mm) are fine; a recess wider than 2 mm lets it rock
      const wideCut = !P.isEmpty(cutUnder) && P.area(cutUnder) > 1 && statsFor(cutUnder, frame, limits).some(s => s.maxWidth > 2);
      if (!P.isEmpty(under) || wideCut) {
        add(out, { id: 'seat', st: 'warn', lbl: 'Relief under the handle', det: `The bolt-on handle's base (about ${limits.handleZone.w} x ${limits.handleZone.h} mm around the screw holes) sits on relief or over a recess. It will rock or stand off unless the face is flat there.`, short: 'handle seat not flat', geo: { at: [hx, hy] } });
      } else {
        add(out, { id: 'seat', st: 'pass', lbl: 'Handle seat flat', det: 'The face is flat where a bolt-on handle sits, and both M3 screw holes are clear.', short: 'handle seat clear' });
      }
    }
  }
  if (!faceOn && mount !== 'pair') {
    add(out, { id: 'backerholes', st: 'info', lbl: 'Backer screw holes stay open', det: 'The Essential backer has the two handle screw holes in it. With the face off nothing covers them, so they stay open whatever the handle setting. Turn the face on to hide them.', short: 'backer holes open' });
  }
  if (mount === 'pair') { /* reported above */ } else if (mount === 'none' && !solids.length) {
    add(out, { id: 'seat', st: 'info', lbl: 'No handle', det: 'The handle is set to none and the design has no grip or block, so there is nothing to pull the drawer by. Add a grip, or choose the bolt-on handle in Style.', short: 'no handle or grip' });
  } else if (mount === 'none') {
    add(out, { id: 'seat', st: 'pass', lbl: 'Built-in grip', det: 'No screw holes; the drawer is pulled by what stands on the face.', short: 'grip, no holes' });
  }

  // ---- exact widths from the elements' own parameters (the raster below is too coarse for 0.25 mm grooves)
  const widths = elementWidths(design);
  const slack = 2 * frame.res;
  const narrowGroove = widths.filter(w => w.groove < limits.minGroove - 1e-9).sort((a, b) => a.groove - b.groove)[0];
  const vanishEl = widths.filter(w => w.feature < limits.nozzle - 1e-9).sort((a, b) => a.feature - b.feature)[0];
  const thinEl = !vanishEl && widths.filter(w => w.feature < limits.minWall - 1e-9).sort((a, b) => a.feature - b.feature)[0];
  if (narrowGroove) add(out, { id: 'groove', st: 'warn', lbl: 'Gaps too narrow', det: narrowGroove.stroke ? `${narrowGroove.el.name}'s cut strokes${narrowGroove.char ? ` (in “${narrowGroove.char}”)` : ''} are about ${fmt(narrowGroove.groove)} mm wide; under ${limits.minGroove} mm the slicer closes them up. Make the letters taller or choose a bolder font.` : `${narrowGroove.el.name} leaves ${fmt(narrowGroove.groove)} mm between features; under ${limits.minGroove} mm the slicer closes the gap up.`, short: `${fmt(narrowGroove.groove)} mm gap closes`, elementId: narrowGroove.el.id });
  const fixText = w => w.stroke ? ' Make the letters taller or choose a bolder font.' : '';
  if (vanishEl) add(out, { id: 'thin', st: 'fail', lbl: 'Features too thin to print', det: `${widthText(vanishEl, vanishEl.feature)}, narrower than the ${limits.nozzle} mm nozzle; ${vanishEl.stroke || vanishEl.between ? 'those parts will not print.' : 'it will not print at all.'}${fixText(vanishEl)}`, short: `${fmt(vanishEl.feature)} mm feature vanishes`, elementId: vanishEl.el.id });
  else if (thinEl) add(out, { id: 'thin', st: 'warn', lbl: 'Thin features', det: `${widthText(thinEl, thinEl.feature)}, under the ${limits.minWall} mm two-perimeter width: a single fragile extrusion line.${fixText(thinEl)}`, short: `${fmt(thinEl.feature)} mm feature is thin`, elementId: thinEl.el.id });

  // ---- inlays: each inlaid colour is a piece of its own on the face (the first layers printed face down, the top skin
  // face up), so every piece has to be wide enough to print by itself. Measured per colour, because touching inlays
  // of one filament print as one piece; an inlay in the face's own colour is part of the face, not a piece at all. An
  // element its exact width already flagged is not reported again at the same level or milder (a piece the plate
  // edge clips to a sliver can still fail where the element's own width only warned).
  const inlays = layers.filter(L => L.inlay && L.color !== design.face.color);
  if (inlays.length) {
    const failed = new Set(vanishEl ? [vanishEl.el.id] : []), flagged = new Set([vanishEl, thinEl].filter(Boolean).map(w => w.el.id));
    const byColor = new Map();
    for (const L of inlays) (byColor.get(L.color) || byColor.set(L.color, []).get(L.color)).push(L);
    let vanish = null, thin = null, nVanish = 0, nThin = 0;
    const inlaySlivers = [];
    for (const list of byColor.values()) {
      for (const s of statsFor(P.union(...list.map(L => L.poly)), frame, limits, built.keep)) {
        if (s.areaMm2 < limits.crumbMm2) continue;   // a slicer drops it without a trace, and so do we
        if (atEdge(s)) { if (s.maxWidth < limits.minWall - slack) inlaySlivers.push(s); continue; }
        const owner = list.find(L => P.contains(L.poly, s.at[0], s.at[1])) || list[0];
        if (s.maxWidth < limits.nozzle - slack) { if (failed.has(owner.elementId)) continue; nVanish++; if (!vanish || s.maxWidth < vanish.s.maxWidth) vanish = { s, L: owner }; }
        else if (s.maxWidth < limits.minWall - slack) { if (flagged.has(owner.elementId)) continue; nThin++; if (!thin || s.maxWidth < thin.s.maxWidth) thin = { s, L: owner }; }
      }
    }
    const pieces = n => `${n} inlaid piece${n > 1 ? 's' : ''}`;
    if (vanish) add(out, { id: 'inlay', st: 'fail', lbl: 'Inlay too thin to print', det: `${pieces(nVanish)} (the thinnest in ${vanish.L.name}, ${fmt(vanish.s.maxWidth)} mm) ${nVanish > 1 ? 'are' : 'is'} narrower than the ${limits.nozzle} mm nozzle and will not print in ${nVanish > 1 ? 'their' : 'its'} colour. Make ${nVanish > 1 ? 'them' : 'it'} bigger, or raise or cut ${nVanish > 1 ? 'them' : 'it'} instead. (Crumbs under ${limits.crumbMm2} mm2 are not counted.)`, short: `${fmt(vanish.s.maxWidth)} mm inlay vanishes`, elementId: vanish.L.elementId, geo: { at: vanish.s.at } });
    else if (thin) add(out, { id: 'inlay', st: 'warn', lbl: 'Thin inlay', det: `${pieces(nThin)} (the thinnest in ${thin.L.name}, ${fmt(thin.s.maxWidth)} mm) ${nThin > 1 ? 'are' : 'is'} under the ${limits.minWall} mm two-perimeter width: a single extrusion line of colour, easy to lose.`, short: `${fmt(thin.s.maxWidth)} mm inlay is thin`, elementId: thin.L.elementId, geo: { at: thin.s.at } });
    else if (!inlays.some(L => flagged.has(L.elementId))) add(out, { id: 'inlay', st: 'pass', lbl: 'Inlays print', det: `Every inlaid piece is at least ${limits.minWall} mm wide.`, short: 'inlays ok' });
    edgeNote(out, inlaySlivers, limits);
  }

  // ---- recess (everything whose top is below the highest plane)
  const topPoly = P.union(...layers.filter(L => L.z1 >= zTop - eps).map(L => L.poly));
  // with the face off and nothing on it, the bare backer is the top plane and there is no recess at all
  const bare = !faceOn && !layers.length && !solids.length;
  const recess = bare ? [] : P.difference(built.keep, topPoly, ...solids.map(s => s.footprint));
  const recessStats = statsFor(recess, frame, limits);
  const closing = recessStats.filter(s => s.maxWidth < limits.minGroove - slack);
  if (narrowGroove) { /* already reported exactly */ } else if (closing.length) {
    const w = worstBy(closing, s => -s.maxWidth);
    add(out, { id: 'groove', st: 'warn', lbl: 'Gaps too narrow', det: `${closing.length} gap${closing.length > 1 ? 's' : ''} narrower than ${limits.minGroove} mm (narrowest ${fmt(w.maxWidth)} mm). The slicer will close these up; widen them or merge the features.`, short: `${closing.length} gap${closing.length > 1 ? 's' : ''} will close`, geo: { at: w.at } });
  } else {
    add(out, { id: 'groove', st: 'pass', lbl: 'Gaps print open', det: `Every gap between features is at least ${limits.minGroove} mm wide.`, short: 'gaps ok' });
  }

  // a 3D texture finer than a 0.4 mm nozzle can draw: two perimeters need 0.8 mm
  for (const el of design.elements) {
    if (el.kind !== 'surface' || el.visible === false) continue;
    const f = finestFeature(el.map, el.scale, el.texParams);
    if (f !== null && f < 0.8) add(out, { id: 'texfine', st: 'warn', lbl: 'Texture finer than the nozzle', det: `${el.name}'s finest detail is about ${fmt(f)} mm, under the 0.8 mm that two perimeters of a 0.4 mm nozzle need, so it prints soft or not at all. A feature size of about ${fmt(Math.ceil((Number(el.scale) || 4) * 0.8 / f * 10) / 10)} mm brings it to 0.8 mm.`, short: `${fmt(f)} mm texture detail`, elementId: el.id });
  }

  if (mode === 'down') {
    if (solids.length) {
      const kindWord = { mesh: ['Meshes need Face Up', 'An imported mesh stands off the face with its own shape, which cannot print face down (its top would have to be one flat plane on the bed). Switch the design to Face Up or remove the mesh.', 'mesh in face-down mode'], solid: ['Solids need Face Up', 'A solid block stands off the face with sloped or stacked sides, which cannot print face down. Switch the design to Face Up or remove the block.', 'solid in face-down mode'], surface: ['3D textures need Face Up', 'A 3D texture lifts the surface into hills and hollows, which cannot lie flat on the bed. Switch the design to Face Up, or use a flat texture fill instead.', 'texture in face-down mode'], shaped: ['Tapered or rounded tops need Face Up', 'A drawing, combine or outline with a taper or a chamfered or rounded top stands off the face with sloping sides, which cannot print face down. Switch the design to Face Up, or set its taper angle to 0 and its top edges to Square.', 'taper in face-down mode'] }[solids[0].kind]
        || ['Grips need Face Up', 'A grip has an undercut or stands tall off the face, which cannot print face down. Switch the design to Face Up or remove the grip.', 'grip in face-down mode'];
      add(out, { id: 'grip', st: 'fail', lbl: kindWord[0], det: kindWord[1], short: kindWord[2], elementId: solids[0].elementId, geo: { at: P.bbox(solids[0].footprint) ? [(P.bbox(solids[0].footprint).x0 + P.bbox(solids[0].footprint).x1) / 2, (P.bbox(solids[0].footprint).y0 + P.bbox(solids[0].footprint).y1) / 2] : undefined } });
    }
    // bridges: recesses are spanned when the layers above them print
    const wide = recessStats.filter(s => s.maxWidth > limits.bridgeOk);
    const worst = worstBy(wide, s => s.maxWidth);
    if (!worst) {
      add(out, { id: 'bridge', st: 'pass', lbl: 'Recesses bridge cleanly', det: recessStats.length ? `The widest recess is ${fmt(worstBy(recessStats, s => s.maxWidth).maxWidth)} mm across, under the ${limits.bridgeOk} mm clean-bridge limit.` : 'The face is one flat plane on the bed.', short: 'bridges ok' });
    } else if (worst.maxWidth <= limits.bridgeWarn) {
      add(out, { id: 'bridge', st: 'warn', lbl: 'Long bridges', det: `A recess ${fmt(worst.maxWidth)} mm across will be bridged from above (clean up to ${limits.bridgeOk} mm). The underside of the bridge is the visible face here, so expect a rougher finish. Narrow it, or switch to Face Up.`, short: `${fmt(worst.maxWidth)} mm bridge`, geo: { at: worst.at } });
    } else if (zTop > t + 1e-6 && P.area(recess) > 0.5 * P.area(built.keep)) {
      add(out, { id: 'bridge', st: 'fail', lbl: faceOn ? 'Raised features float the face' : 'Raised features on the bare backer',
        det: faceOn ? `Printed face down, the raised features touch the bed and the rest of the face hangs ${fmt(zTop - t)} mm above it with nothing underneath. Face Down designs can only cut into the face; switch to Face Up for raised features, or make them cuts.`
          : 'With the face off, Face Down prints the bare backer front on the bed, and anything standing on it would be underneath. Switch to Face Up to stand features on the backer.', short: 'face floats above raised features', geo: { at: worst.at } });
    } else {
      add(out, { id: 'bridge', st: 'fail', lbl: 'Recess too wide to bridge', det: `A recess ${fmt(worst.maxWidth)} mm across cannot be bridged (limit ${limits.bridgeWarn} mm); the face above it would print in mid-air. Split it with ribs, narrow it, or switch to Face Up.`, short: `${fmt(worst.maxWidth)} mm recess`, geo: { at: worst.at } });
    }
    // every raised feature must reach the bed plane: a shorter one starts in mid-air under the face
    const lower = raised.filter(L => L.z1 < zTop - eps);
    if (lower.length) {
      const b = P.bbox(lower[0].poly);
      add(out, { id: 'levels', st: 'fail', lbl: 'Raised features at different heights', det: `${lower[0].name} tops out at ${fmt(lower[0].z1)} mm while the tallest feature reaches ${fmt(zTop)} mm. Printed face down only the tallest features touch the bed; the lower ones start in mid-air. Give every raised feature the same height, or switch to Face Up.`, short: 'raised features at two heights', elementId: lower[0].elementId, geo: { at: [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2] } });
    }
    // first layer: the pads on the bed
    const padStats = statsFor(topPoly, frame, limits, built.keep);
    const vanish = padStats.filter(s => s.maxWidth < limits.nozzle - slack && !atEdge(s));
    const thin = padStats.filter(s => s.maxWidth >= limits.nozzle - slack && s.maxWidth < limits.minWall - slack && !atEdge(s));
    if (!vanishEl && !thinEl) edgeNote(out, padStats.filter(s => s.maxWidth < limits.minWall - slack && atEdge(s)), limits);
    const tiny = padStats.filter(s => s.areaMm2 < limits.tinyPadMm2);
    if (vanishEl || thinEl) { /* reported exactly above */ } else if (vanish.length) {
      const w = worstBy(vanish, s => -s.maxWidth);
      add(out, { id: 'thin', st: 'fail', lbl: 'Features too thin to print', det: `${vanish.length} feature${vanish.length > 1 ? 's are' : ' is'} narrower than the ${limits.nozzle} mm nozzle (thinnest ${fmt(w.maxWidth)} mm) and will not print at all.`, short: `${vanish.length} vanish`, geo: { at: w.at } });
    } else if (thin.length) {
      const w = worstBy(thin, s => -s.maxWidth);
      add(out, { id: 'thin', st: 'warn', lbl: 'Thin features', det: `${thin.length} feature${thin.length > 1 ? 's are' : ' is'} under ${limits.minWall} mm wide (thinnest ${fmt(w.maxWidth)} mm): a single extrusion line, fragile and easy to lose.`, short: `${thin.length} thin`, geo: { at: w.at } });
    } else {
      add(out, { id: 'thin', st: 'pass', lbl: 'Feature widths', det: `Everything on the bed is at least ${limits.minWall} mm wide.`, short: 'widths ok' });
    }
    if (tiny.length) {
      add(out, { id: 'tiny', st: 'warn', lbl: 'Tiny first-layer islands', det: `${tiny.length} island${tiny.length > 1 ? 's' : ''} under ${limits.tinyPadMm2} mm2 start the print on their own and may not stick to the bed.`, short: `${tiny.length} tiny island${tiny.length > 1 ? 's' : ''}`, geo: { at: tiny[0].at } });
    }
  } else {
    // ---- face up: support under every layer that does not start on the backer
    let floating = null, bridging = null, island = null;
    for (const L of layers) {
      if (L.z0 <= eps) continue;
      const below = layers.filter(M => M !== L && Math.abs(M.z1 - L.z0) < 1e-4);
      const unsupported = P.difference(L.poly, ...below.map(M => M.poly));
      if (P.isEmpty(unsupported) || P.area(unsupported) < 0.05) continue;
      // a piece with nothing at all under it is an island, however small; the rest are bridges of some width
      const islands = islandsOf(L.poly, unsupported, frame);
      if (islands.length && !island) island = { ...islands[0], L, count: islands.length };
      const stats = statsFor(unsupported, frame, limits);
      const worst = worstBy(stats, s => s.maxWidth);
      if (!worst) continue;
      if (worst.maxWidth > limits.bridgeOk) { if (!floating || worst.maxWidth > floating.maxWidth) floating = { ...worst, L }; }
      else if (!bridging || worst.maxWidth > bridging.maxWidth) bridging = { ...worst, L };
    }
    if (island) {
      add(out, { id: 'support', st: 'fail', lbl: 'Feature floats in mid-air', det: `${island.count > 1 ? `${island.count} pieces of ` : ''}${island.L.name} start${island.count > 1 ? '' : 's'} ${fmt(island.L.z0)} mm up with nothing underneath at all. Put material beneath, or remove the cut under it.`, short: 'unsupported island', elementId: island.L.elementId, geo: { at: island.at } });
    } else if (floating) {
      add(out, { id: 'support', st: floating.maxWidth > limits.bridgeWarn ? 'fail' : 'warn', lbl: floating.maxWidth > limits.bridgeWarn ? 'Feature floats in mid-air' : 'Feature bridges a gap',
        det: `${floating.L.name} starts ${fmt(floating.L.z0)} mm up with nothing under a span ${fmt(floating.maxWidth)} mm across${floating.maxWidth > limits.bridgeWarn ? '. It needs material beneath it, or supports in the slicer.' : ', which the slicer will bridge with a rough underside.'}`, short: floating.maxWidth > limits.bridgeWarn ? 'unsupported feature' : `${fmt(floating.maxWidth)} mm bridge`, elementId: floating.L.elementId, geo: { at: floating.at } });
    } else if (bridging) {
      add(out, { id: 'support', st: 'pass', lbl: 'Small bridges only', det: `${bridging.L.name} spans a ${fmt(bridging.maxWidth)} mm gap, within the ${limits.bridgeOk} mm clean-bridge limit.`, short: 'support ok' });
    } else {
      add(out, { id: 'support', st: 'pass', lbl: 'Everything is supported', det: 'Every raised feature stands on the face or on another feature.', short: 'support ok' });
    }
    // grips, meshes and solid blocks, twins included: patterns and cuts are not mirrored, so a twin can stand over a
    // cut its original does not (add() drops a twin's finding when it repeats the original's word for word)
    for (const s of solids) {
      if (s.inside) continue;   // held inside another body (a grip's accent strip)
      if (s.kind === 'solid') {
        const off = P.difference(s.footprint, built.plate);
        if (!P.isEmpty(off) && P.area(off) > 0.5) {
          const b = P.bbox(off);
          add(out, { id: 'offplate', st: 'fail', lbl: 'Block runs past the plate edge', det: `${s.name} extends ${fmt(P.area(off))} mm2 beyond the plate outline on this size. Make it smaller, move it, or disable this size.`, short: 'block past the edge', elementId: s.elementId, geo: { at: [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2] } });
        }
        // what it stands on: the backer, the layers that end at its bottom, and the flat tops of bodies that end there
        const base = s.base && s.base.length ? s.base : s.footprint;
        const supports = [...layers.filter(M => Math.abs(M.z1 - s.z0) < 1e-4).map(M => M.poly), ...solids.filter(o => o !== s && o.top && Math.abs(o.z1 - s.z0) < 1e-4).map(o => o.top)];
        const under = s.z0 <= eps ? [] : P.difference(base, ...supports);
        if (!P.isEmpty(under) && P.area(under) > 0.5) {
          const b = P.bbox(under), at = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
          const held = P.intersection(base, P.union(...supports));
          const r = blockSupport(base, held, limits);
          const place = x => x?.at || at;
          if (r.float || P.isEmpty(held)) add(out, { id: 'support', st: 'fail', lbl: 'Block floats in mid-air', det: `${s.name} starts ${fmt(s.z0)} mm up with ${P.isEmpty(held) ? 'nothing under it' : 'part of its base resting on nothing'}. Set it to sit on the face or on a block, or take the lift off.`, short: 'block floats', elementId: s.elementId, geo: { at: place(r.float) } });
          else if (r.ledge && r.ledge.mm > limits.ledgeWarn) add(out, { id: 'support', st: 'fail', lbl: 'Block sticks out unsupported', det: `${s.name} reaches ${fmt(r.ledge.mm)} mm past what holds it, a flat ledge printed over air (limit ${limits.ledgeWarn} mm). Shorten it, or put a support under the end.`, short: `${fmt(r.ledge.mm)} mm ledge`, elementId: s.elementId, geo: { at: place(r.ledge) } });
          else if (r.bridge && r.bridge.mm > limits.bridgeWarn) add(out, { id: 'support', st: 'fail', lbl: 'Block bridges too far', det: `${s.name} spans ${fmt(r.bridge.mm)} mm between its supports (limit ${limits.bridgeWarn} mm). Move them closer, or add one in the middle.`, short: `${fmt(r.bridge.mm)} mm bridge`, elementId: s.elementId, geo: { at: place(r.bridge) } });
          else if (r.ledge && r.ledge.mm > limits.ledgeOk) add(out, { id: 'support', st: 'warn', lbl: 'Block sticks out a little', det: `${s.name} reaches ${fmt(r.ledge.mm)} mm past what holds it. It usually prints, with a drooping edge (clean up to ${limits.ledgeOk} mm).`, short: `${fmt(r.ledge.mm)} mm ledge`, elementId: s.elementId, geo: { at: place(r.ledge) } });
          else if (r.bridge && r.bridge.mm > limits.bridgeOk) add(out, { id: 'support', st: 'warn', lbl: 'Block bridges a gap', det: `${s.name} bridges ${fmt(r.bridge.mm)} mm between its supports. It prints, with a rougher underside (clean up to ${limits.bridgeOk} mm).`, short: `${fmt(r.bridge.mm)} mm bridge`, elementId: s.elementId, geo: { at: place(r.bridge) } });
        }
        if (s.area60 > limits.meshOverhangMm2) add(out, { id: 'overhang', st: 'fail', lbl: 'Block overhangs', det: `${s.name} has ${fmt(s.area60)} mm2 of underside facing down at more than 60 degrees from vertical. A top wider than its base prints in mid-air; bring the top-to-base ratio back to 1 or less.`, short: `${fmt(s.area60)} mm2 overhanging`, elementId: s.elementId });
        else if (s.area45 > limits.meshOverhangMm2) add(out, { id: 'overhang', st: 'warn', lbl: 'Block has steep undersides', det: `${s.name} has ${fmt(s.area45)} mm2 of underside at 45 to 60 degrees from vertical. It prints, with a rougher underside.`, short: `${fmt(s.area45)} mm2 steep`, elementId: s.elementId });
        continue;
      }
      if (s.kind === 'mesh') {
        const off = P.difference(s.footprint, built.plate);
        if (!P.isEmpty(off) && P.area(off) > 0.5) {
          const b = P.bbox(off);
          add(out, { id: 'offplate', st: 'fail', lbl: 'Mesh runs past the plate edge', det: `${s.name} extends ${fmt(P.area(off))} mm2 beyond the plate outline on this size. Make it narrower, move it, or disable this size.`, short: 'mesh past the edge', elementId: s.elementId, geo: { at: [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2] } });
        }
      }
      // only the contact base needs face under it (an undercut's overhang does not touch the face);
      // thin grooves under it bridge trivially, a recess wider than 2 mm or most of the base missing is a real gap.
      // A solid standing on the backer (z0 = 0) is always supported, but its overhangs are still checked below.
      const base = (s.base && s.base.length) ? s.base : s.footprint;
      const under = s.z0 <= eps ? [] : P.difference(base, ...layers.filter(M => Math.abs(M.z1 - s.z0) < 1e-4).map(M => M.poly));
      const gap = !P.isEmpty(under) && P.area(under) > 0.5 && (P.area(under) > 0.5 * P.area(base) || statsFor(under, frame, limits).some(r => r.maxWidth > 2));
      // a texture's tip colour stands on the texture itself, not on the face
      if (gap && s.style !== 'surface-tip') {
        const b = P.bbox(under);
        const what = s.kind === 'mesh' ? 'Mesh' : s.kind === 'surface' ? 'Texture' : s.kind === 'shaped' ? ELEMENT_DEFS[design.elements.find(e => e.id === s.elementId)?.kind]?.label || 'Drawing' : 'Grip';
        add(out, { id: 'gripbase', st: 'fail', lbl: `${what} has no face under it`, det: `${s.name} stands over a recess or off the plate. Move it onto flat face, or remove the cut beneath it.`, short: `${what.toLowerCase()} unsupported`, elementId: s.elementId, geo: { at: [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2] } });
      }
      if (s.kind === 'mesh') {
        // area-weighted: a sculpt always has a few steep facets; what matters is how much ceiling it carries
        if (s.area60 > limits.meshOverhangMm2) add(out, { id: 'overhang', st: 'fail', lbl: 'Mesh has unsupported undersides', det: `${s.name} has ${fmt(s.area60)} mm2 of surface facing down at more than 60 degrees from vertical (steepest ${fmt(s.overhang)} degrees). Those areas print in mid-air; add supports in the slicer, fill the undercut in the sculpt, or sink it with "Replaces the face".`, short: `${fmt(s.area60)} mm2 overhanging`, elementId: s.elementId, geo: { at: P.bbox(s.footprint) ? [(P.bbox(s.footprint).x0 + P.bbox(s.footprint).x1) / 2, (P.bbox(s.footprint).y0 + P.bbox(s.footprint).y1) / 2] : undefined } });
        else if (s.area45 > limits.meshOverhangMm2) add(out, { id: 'overhang', st: 'warn', lbl: 'Mesh has steep undersides', det: `${s.name} has ${fmt(s.area45)} mm2 of surface facing down at 45 to 60 degrees from vertical. It will print, with a rougher underside.`, short: `${fmt(s.area45)} mm2 steep`, elementId: s.elementId });
        continue;
      }
      if (s.overhang > limits.overhangWarn) {
        add(out, { id: 'overhang', st: 'fail', lbl: 'Undercut too steep', det: `${s.name}'s undercut leans ${fmt(s.overhang)} degrees from vertical (limit ${limits.overhangWarn}). Reduce the undercut or add height so the slope is 45 degrees or less.`, short: `${fmt(s.overhang)} deg overhang`, elementId: s.elementId, geo: { at: P.bbox(s.footprint) ? [(P.bbox(s.footprint).x0 + P.bbox(s.footprint).x1) / 2, (P.bbox(s.footprint).y0 + P.bbox(s.footprint).y1) / 2] : undefined } });
      } else if (s.overhang > limits.overhangOk) {
        add(out, { id: 'overhang', st: 'warn', lbl: 'Steep undercut', det: `${s.name}'s undercut leans ${fmt(s.overhang)} degrees from vertical. Over ${limits.overhangOk} degrees the underside gets rough; keep the undercut at or below the grip height.`, short: `${fmt(s.overhang)} deg overhang`, elementId: s.elementId });
      }
      // where the grip meets the face: printed face up, a pull parts the layers there (see GRIP_STRENGTH)
      const st = s.strength;
      if (st && st.sigma > GRIP_STRENGTH.warnMPa) {
        const fail = st.sigma > GRIP_STRENGTH.failMPa;
        add(out, { id: 'strength', st: fail ? 'fail' : 'warn', lbl: fail ? 'Grip may snap off' : 'Grip base is thin', det: `${s.name} stands on a base ${fmt(st.width)} mm wide. A firm pull (about 10 kg) at the edge your fingers hook would load the layers there to about ${fmt(st.sigma)} MPa; printed layers part at roughly 15 to 30 MPa${fail ? ', so it could break off at the face' : ', so it is on the thin side'}. Make the undercut smaller or the grip deeper: Make it sturdy in its card finds the smallest change.`, short: `${fmt(st.sigma)} MPa at the base`, elementId: s.elementId });
      }
      // an arch pull's flat span under its bar: short bridges print clean, long ones sag and then need support
      if (s.bridge > limits.bridgeWarn) add(out, { id: 'overhang', st: 'fail', lbl: 'Bridge too long', det: `${s.name} leaves a ${fmt(s.bridge)} mm flat span under its bar (limit ${limits.bridgeWarn} mm), which prints in mid-air. Make the arch narrower (wider legs, a shorter pull) or taller, or the bar thinner, so the 45° sides meet.`, short: `${fmt(s.bridge)} mm bridge`, elementId: s.elementId });
      else if (s.bridge > limits.bridgeOk) add(out, { id: 'overhang', st: 'warn', lbl: 'Long bridge', det: `${s.name} bridges ${fmt(s.bridge)} mm under its bar. It prints, with a rougher underside; under ${limits.bridgeOk} mm it is clean.`, short: `${fmt(s.bridge)} mm bridge`, elementId: s.elementId });
    }
    const grips = solids.filter(s => s.strength);
    if (grips.length && !out.some(c => c.id === 'strength')) add(out, { id: 'strength', st: 'pass', lbl: 'Grips are sturdy', det: `Every grip's base carries a firm pull (about 10 kg) at under ${GRIP_STRENGTH.warnMPa} MPa across the layers (strongest: ${fmt(Math.min(...grips.map(g => g.strength.sigma)))} MPa, weakest: ${fmt(Math.max(...grips.map(g => g.strength.sigma)))} MPa).`, short: 'grips sturdy' });
    if (solids.length && !out.some(c => c.id === 'overhang')) add(out, { id: 'overhang', st: 'pass', lbl: 'Overhangs', det: solids.some(s => s.kind === 'mesh' || s.kind === 'solid') ? `Every grip undercut is at or under ${limits.overhangOk} degrees and no mesh or block carries more than ${limits.meshOverhangMm2} mm2 of steep underside.` : `Every grip undercut is at or under ${limits.overhangOk} degrees from vertical.`, short: 'overhangs ok' });
    // thin raised features (any height)
    const raisedPoly = P.union(...raised.map(L => L.poly));
    const thinStats = statsFor(raisedPoly, frame, limits, built.keep);
    const vanish = thinStats.filter(s => s.maxWidth < limits.nozzle - slack && !atEdge(s));
    const thin = thinStats.filter(s => s.maxWidth >= limits.nozzle - slack && s.maxWidth < limits.minWall - slack && !atEdge(s));
    if (!vanishEl && !thinEl) edgeNote(out, thinStats.filter(s => s.maxWidth < limits.minWall - slack && atEdge(s)), limits);
    if (vanishEl || thinEl) { /* reported exactly above */ } else if (vanish.length) {
      const w = worstBy(vanish, s => -s.maxWidth);
      add(out, { id: 'thin', st: 'fail', lbl: 'Features too thin to print', det: `${vanish.length} raised feature${vanish.length > 1 ? 's are' : ' is'} narrower than the ${limits.nozzle} mm nozzle (thinnest ${fmt(w.maxWidth)} mm).`, short: `${vanish.length} vanish`, geo: { at: w.at } });
    } else if (thin.length) {
      const w = worstBy(thin, s => -s.maxWidth);
      add(out, { id: 'thin', st: 'warn', lbl: 'Thin features', det: `${thin.length} raised feature${thin.length > 1 ? 's are' : ' is'} under ${limits.minWall} mm wide (thinnest ${fmt(w.maxWidth)} mm): a single fragile line.`, short: `${thin.length} thin`, geo: { at: w.at } });
    } else {
      add(out, { id: 'thin', st: 'pass', lbl: 'Feature widths', det: raised.length ? `Every raised feature is at least ${limits.minWall} mm wide.` : 'No raised features.', short: 'widths ok' });
    }
  }

  // ---- what will not show: an element mostly under another, or mostly off this plate (it may print fine, so a
  // warning, and the per-size cards stop calling the design clean)
  const lost = hiddenElements(built);
  const pc = v => `${Math.round(v * 100)}%`;
  for (const h of lost) {
    const who = `${h.E.name}${h.E.label ? ` ${h.E.label}` : ''}`, geo = h.at ? { at: h.at } : undefined, under = h.by ? h.by.name : 'other elements';
    // each share is told as itself: what falls off the plate, and what is under something else (a tenth or more)
    if (h.cause === 'edge') {
      const also = h.under >= 0.1 ? `, and about ${pc(h.under)} is under ${under}` : '';
      add(out, { id: 'hidden', st: 'warn', lbl: `${h.E.name} runs off this size`, det: `About ${pc(h.edge)} of ${who} falls outside this ${fmt(size.w)} × ${fmt(size.h)} mm plate${also}. Make it smaller, or place it so it fits the smaller sizes.`, short: 'runs off the plate', elementId: h.E.id, geo });
    } else {
      const all = h.lost >= HIDDEN.all, fix = h.by && !h.by.body ? `move one of them, or put it above ${h.by.name} in the stack` : 'move one of them';
      const also = h.edge >= 0.1 ? ` (and about ${pc(h.edge)} falls off the plate)` : '';
      add(out, { id: 'hidden', st: 'warn', lbl: all ? `${h.E.name} is hidden` : `${h.E.name} is mostly hidden`, det: `${all && !also ? who : `About ${pc(h.under)} of ${who}`} is under ${under} on this size${also}, so you will not see it. To show it, ${fix}.`, short: all ? 'hidden' : 'mostly hidden', elementId: h.E.id, geo });
    }
  }
  if (!lost.length && lost.judged) add(out, { id: 'hidden', st: 'pass', lbl: 'Everything shows', det: 'No element is mostly covered by another or off this plate.', short: 'all visible' });

  // ---- height
  if (zTop - t > limits.maxHeightWarn) {
    add(out, { id: 'height', st: 'warn', lbl: 'Very tall relief', det: `The face reaches ${fmt(zTop)} mm above the backer. Check it clears the drawer above when the drawer opens and closes.`, short: `${fmt(zTop)} mm tall` });
  } else {
    add(out, { id: 'height', st: 'pass', lbl: 'Height', det: faceOn ? `Face ${fmt(t)} mm, highest point ${fmt(zTop)} mm above the backer front.` : `No face slab; the highest point is ${fmt(zTop)} mm above the backer front.`, short: `${fmt(zTop)} mm tall` });
  }

  // ---- bed fit
  if (size.w > limits.bedSmall.w || size.h > limits.bedSmall.l) {
    add(out, { id: 'bed', st: 'info', lbl: 'Needs a large bed', det: `${size.w} x ${size.h} mm does not fit a ${limits.bedSmall.w} x ${limits.bedSmall.l} mm bed. The export uses the Prusa XL profile for 3W and 4W plates.`, short: 'large bed' });
  }

  const counts = { pass: 0, warn: 0, fail: 0, info: 0 };
  for (const c of out) counts[c.st] = (counts[c.st] || 0) + 1;
  const status = counts.fail ? 'fail' : counts.warn ? 'warn' : 'pass';
  const order = { fail: 0, warn: 1, info: 2, pass: 3 };
  out.sort((a, b) => order[a.st] - order[b.st]);
  return { checks: out, status, counts, zTop };
}
