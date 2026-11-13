// Element actions and wording shared by the library's stack and the inspector.

import { state, commit, select, selectedElement, currentSize } from '../state.js';
import { elementOn } from '../variants.js';
import { newElement } from '../geometry/face.js';
import { PATTERNS } from '../geometry/patterns.js';
import { HOODS, HOOD_MIN_LENGTH } from '../geometry/hoods.js';
import { CORNER_HOOD } from '../geometry/cornerhood.js';
import { pathTaper, pathEdge } from '../geometry/path.js';

/** A grip's size as built: the series' grips keep their shipped section whatever the shaped styles' settings say. */
function gripSummary(el) {
  const edge = el.flush === 't' ? ' · top edge' : el.flush === 'b' ? ' · bottom edge' : '';
  if (el.style === 'edgelabel') return `corner hood · ${CORNER_HOOD.depth} × ${CORNER_HOOD.height} mm · top ${el.corner === 'left' ? 'left' : 'right'}`;
  const hood = HOODS[el.style];
  const len = el.fullWidth ? 'full width' : `${hood ? Math.max(HOOD_MIN_LENGTH, el.length) : el.length}`;
  return `${len} × ${hood ? hood.depth : el.depth} × ${hood ? hood.height : el.height} mm${edge}`;
}

/** One line on what an element is, in the mono caption under its name: as it is on the size shown (variants.js). */
export function summary(master) {
  // a copy: elementOn hands back the element itself when nothing differs on this size, and this rounds for show
  // (with no design open, as in a test, the element is described as it is stored)
  const el = { ...(state.design ? elementOn(master, currentSize()) : master) }, round = v => (typeof v === 'number' ? +v.toFixed(2) : v);
  for (const k of ['w', 'h', 'depth', 'height', 'out', 'length']) if (typeof el[k] === 'number') el[k] = round(el[k]);
  const op = e => e.op === 'cut' ? `cut ${e.depth} mm` : e.op === 'inlay' ? `inlay ${e.depth} mm` : `raise ${e.height} mm`;
  if (el.kind === 'pattern') return `${PATTERNS[el.pattern].label} · ${op(el)}`;
  if (el.kind === 'shape') return `${el.w} × ${el.h} mm · ${op(el)}`;
  if (el.kind === 'grip') return gripSummary(el);
  if (el.kind === 'solid') return `${el.w} × ${el.h} mm · ${el.out} mm out${el.stackOn ? ' · stacked' : ''}`;
  if (el.kind === 'text') { const t = String(el.text || '').replace(/\s+/g, ' ').trim(); return `“${t.length > 14 ? `${t.slice(0, 13)}…` : t}” · ${el.size} mm · ${op(el)}`; }
  if (el.kind === 'surface') return `${el.region === 'element' ? 'on an element' : el.region === 'shape' ? `${el.w} × ${el.h} mm` : 'whole face'} · ${el.depth} mm deep`;
  if (el.kind === 'image') return `${el.width} mm wide · ${el.steps} tone${el.steps === 1 ? '' : 's'} · ${op(el)}`;
  if (el.kind === 'svg') return `${el.width} mm wide · ${el.groups.length} layer${el.groups.length === 1 ? '' : 's'}`;
  if (el.kind === 'mesh') return `${el.width} mm wide · ${(el.natural?.tris || 0).toLocaleString()} tris`;
  if (el.kind === 'path' || el.kind === 'combine' || el.kind === 'offset') {
    const n = el.kind === 'combine' ? (el.parts || []).filter(id => !state.design || state.design.elements.some(e => e.id === id)).length : 0;
    const form = el.kind === 'combine' ? `${{ join: 'joined', common: 'overlap' }[el.operation] || 'cut away'} · ${n} piece${n === 1 ? '' : 's'}`
      : el.kind === 'offset' ? `${el.band === 'shape' ? 'grown' : 'band'} ${round(el.distance)} mm`
        : el.form === 'wall' ? `wall ${round(el.thick)} mm` : el.form === 'line' ? `line ${round(el.thick)} mm` : 'filled';
    const { edge, size } = pathEdge(el), raised = el.op === 'raise';
    const top = raised && size > 0 ? ` · ${edge === 'round' ? 'rounded' : 'chamfered'} ${round(size)} mm` : '';
    return `${form} · ${op(el)}${raised && pathTaper(el) > 0 ? ` · taper ${round(pathTaper(el))}°` : ''}${top}`;
  }
  return '';
}

export function deleteSelected() {
  const el = selectedElement(); if (!el) return;
  state.design.elements = state.design.elements.filter(e => e !== el);
  // (a combine that used it carries on with its other pieces)
  for (const c of state.design.elements) if (c.kind === 'combine' && Array.isArray(c.parts)) c.parts = c.parts.filter(id => id !== el.id);
  select(null);
  commit('Delete');
}

export function duplicateSelected() {
  const el = selectedElement(); if (!el) return;
  const c = JSON.parse(JSON.stringify(el));
  c.id = newElement(el.kind).id; c.name = `${el.name} copy`;
  state.design.elements.splice(state.design.elements.indexOf(el) + 1, 0, c);
  commit('Duplicate'); select(c.id);
}

/** dir +1 moves the element later (up the stack, printed over the rest), -1 earlier. */
export function moveSelected(dir) {
  const el = selectedElement(); if (!el) return;
  const a = state.design.elements, i = a.indexOf(el), j = i + dir;
  if (j < 0 || j >= a.length) return;
  [a[i], a[j]] = [a[j], a[i]];
  commit('Reorder');
}
