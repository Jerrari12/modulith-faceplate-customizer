// Design files: the unit of sharing. A design is small JSON (pattern parameters, mode, colours, handle settings,
// imported art as polygons), so it survives a cleared cache, can be sent to someone, and can be regenerated
// into geometry by any copy of the tool - or the planner, later.

import { newElement, ELEMENT_DEFS } from '../geometry/face.js';
import { cleanPatternParams } from '../geometry/patterns.js';
import { cleanTextureParams } from '../geometry/heightmaps.js';
import { isFilled } from '../geometry/fill.js';
import { cleanText } from '../geometry/text.js';
import { cleanImageData, IMAGE_LIMITS } from '../geometry/image.js';
import { SIZES } from '../data/sizes.js';
import { cleanVariants } from '../variants.js';
import { cleanPoints } from '../geometry/path.js';

export const FILE_KIND = 'modulith-faceplate-design';
const OLD_FILE_KINDS = new Set(['gen2-faceplate-design']);   // files saved before the MODULITH rename still open
export const FILE_VERSION = 1;

// Colour slots name a filament from the planner's catalogue (js/data/filament-db.js) by its label, the same key the
// planner stores; a slot without one is a custom colour. The backer default is the planner's faceplate body black.
export const DEFAULT_COLORS = [
  { id: 'backer', name: 'Elegoo PLA Black', hex: '#1c1d20', filament: 'Elegoo PLA Black' },
  { id: 'c1', name: 'Panchroma White', hex: '#f5f4ee', filament: 'Panchroma White' },
  { id: 'c2', name: 'Panchroma Silk Gold', hex: '#d9b13b', filament: 'Panchroma Silk Gold' },
  { id: 'c3', name: 'Panchroma Aqua Blue', hex: '#5cc6e0', filament: 'Panchroma Aqua Blue' },
];

export const MOUNTS = ['pair', 'knob', 'none'];

export function newDesign(overrides = {}) {
  return {
    name: 'Untitled faceplate',
    mode: 'down',
    face: { thickness: 2, color: 'c1', enabled: true },
    handles: { holes: true, mount: 'pair', knobD: 3.2 },
    symmetry: 'off',
    colors: DEFAULT_COLORS.map(c => ({ ...c })),
    elements: [],
    sizes: { enabled: SIZES.map(s => s.id), current: '2W-1H' },
    ...overrides,
  };
}

const SIZE_IDS = new Set(SIZES.map(s => s.id));

export function serializeDesign(design) {
  return JSON.stringify({ kind: FILE_KIND, version: FILE_VERSION, app: 'MODULITH Faceplate Customizer', saved: new Date().toISOString(), design }, null, 1);
}

function num(v, d) { const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN; return Number.isFinite(n) ? n : d; }
/** A short string from a file: a string or a number, else the default (String() on an object can throw: {"toString": null}). */
function str(v, d, n = 80) { return (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : d).slice(0, n); }

/** Parse and normalise a design file (or a bare design object). Throws on anything that is not a design. */
export function parseDesign(text) {
  const raw = typeof text === 'string' ? JSON.parse(text) : text;
  const d = raw && (raw.kind === FILE_KIND || OLD_FILE_KINDS.has(raw.kind)) ? raw.design : raw;
  if (!d || typeof d !== 'object' || !Array.isArray(d.elements)) throw new Error('Not a faceplate design file');
  const out = newDesign();
  out.name = str(d.name, out.name, 120);
  out.mode = d.mode === 'up' ? 'up' : 'down';
  out.face = { thickness: num(d.face?.thickness, 2), color: str(d.face?.color, 'c1', 40), enabled: d.face?.enabled !== false };
  // the same rule as handleMount(): an explicit knob or none wins, otherwise holes: false still means none
  const mount = d.handles?.mount === 'knob' || d.handles?.mount === 'none' ? d.handles.mount : (d.handles?.holes === false ? 'none' : 'pair');
  out.handles = { holes: mount === 'pair', mount, knobD: Math.max(2, Math.min(10, num(d.handles?.knobD, 3.2))) };
  out.symmetry = d.symmetry === 'x' ? 'x' : 'off';
  if (Array.isArray(d.colors) && d.colors.length) out.colors = d.colors.slice(0, 8).map((c, i) => ({
    id: str(c.id, `c${i}`, 40), name: str(c.name, `Colour ${i + 1}`), hex: /^#[0-9a-f]{6}$/i.test(c.hex) ? c.hex : '#888888',
    ...(typeof c.filament === 'string' && c.filament ? { filament: c.filament.slice(0, 80) } : {}),
  }));
  if (!out.colors.some(c => c.id === 'backer')) out.colors.unshift(DEFAULT_COLORS[0]);
  out.elements = d.elements.filter(e => e && ELEMENT_DEFS[e.kind]).map(e => {
    const el = newElement(e.kind);
    for (const p of ELEMENT_DEFS[e.kind].params) {
      if (e[p.key] === undefined) continue;
      if (p.type === 'number') el[p.key] = num(e[p.key], p.default);
      else if (p.type === 'select') el[p.key] = p.options.some(([v]) => v === e[p.key]) ? e[p.key] : p.default;
      else if (p.type === 'bool') el[p.key] = !!e[p.key];
      else if (p.type === 'textarea') el[p.key] = cleanText(e[p.key]);
      else if (p.type === 'colors') el[p.key] = Array.isArray(e[p.key]) ? e[p.key].slice(0, IMAGE_LIMITS.maxSteps).map(v => (typeof v === 'string' ? v.slice(0, 40) : 'c2')) : p.default.slice();
      // any other setting is a short string; String() on an object from a file can throw ({"toString": null})
      else el[p.key] = typeof e[p.key] === 'string' ? e[p.key].slice(0, 80) : typeof e[p.key] === 'number' ? String(e[p.key]) : p.default;
    }
    el.id = str(e.id, el.id); el.name = str(e.name, el.name); el.visible = e.visible !== false;
    if (e.kind === 'pattern') el.params = cleanPatternParams(el.pattern, e.params);
    // a texture fill's settings, cleaned like a pattern's; solid and outline carry none
    if ('fillParams' in el) el.fillParams = isFilled(el) && el.fill !== 'outline' ? cleanPatternParams(el.fill, e.fillParams) : {};
    if (e.kind === 'svg') {
      // a design file can come from anyone: keep only the fields the tool reads, colours as #rrggbb
      const hex = v => /^#[0-9a-f]{6}$/i.test(v) ? v : '#888888';
      el.groups = (Array.isArray(e.groups) ? e.groups : []).filter(g => g && Array.isArray(g.rings)).map(g => ({
        name: str(g.name, ''), fill: hex(g.fill), rings: g.rings, color: str(g.color, 'c2', 40),
        op: g.op === 'cut' || g.op === 'inlay' ? g.op : 'raise', height: num(g.height, 1), depth: num(g.depth, 0.6), visible: g.visible !== false,
      }));
      el.natural = e.natural && Number.isFinite(+e.natural.w) && Number.isFinite(+e.natural.h) ? { w: +e.natural.w, h: +e.natural.h } : null;
    }
    if (e.kind === 'surface' && e.data) el.data = cleanImageData(e.data) || undefined;   // a picture height map, if any
    if (e.kind === 'surface') el.texParams = cleanTextureParams(el.map, e.texParams);   // the texture's own settings, cleaned
    // formulas (=W-12) and the settings a size changes for itself (variants.js), checked like everything else here
    Object.assign(el, cleanVariants(el, e, SIZE_IDS, cleanText));
    if (e.kind === 'combine') el.parts = (Array.isArray(e.parts) ? e.parts : []).filter(id => typeof id === 'string' && id).map(id => id.slice(0, 80)).slice(0, 32);   // ids; ones that name nothing are skipped when it builds
    if (e.kind === 'path') {
      el.pts = cleanPoints(e.pts);
      if (el.pts.length < 2) return null;   // a drawing needs at least a line's two ends
    }
    if (e.kind === 'image') {
      el.data = cleanImageData(e.data);
      if (!el.data) return null;   // a picture without its pixels is nothing
    }
    if (e.kind === 'mesh') {
      if (!e.data || typeof e.data.v !== 'string' || typeof e.data.i !== 'string') return null;   // a mesh without its geometry is nothing
      el.data = { v: e.data.v, i: e.data.i, nv: num(e.data.nv, 0), nt: num(e.data.nt, 0) };
      el.natural = e.natural || null;
    }
    return el;
  }).filter(Boolean);
  const valid = new Set(SIZES.map(s => s.id));
  out.sizes = {
    enabled: Array.isArray(d.sizes?.enabled) ? d.sizes.enabled.filter(id => valid.has(id)) : SIZES.map(s => s.id),
    current: valid.has(d.sizes?.current) ? d.sizes.current : '2W-1H',
  };
  if (!out.sizes.enabled.length) out.sizes.enabled = SIZES.map(s => s.id);
  return out;
}
