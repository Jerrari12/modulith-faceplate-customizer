// One design, eighteen sizes (2026-11-11, after Erie Sign Studio's sign types and signs): the design is the master,
// and any size may change any of an element's settings for itself, the way a sign keeps its type's spec but has its
// own text. A changed setting is an override: el.bySize[sizeId][key] holds the value that size uses, and it wins
// over the master. A number setting may also be a formula (expr.js): el.expr[key] = "=W-12" is worked out on every
// size, and el[key] keeps the value it came to on the size it was last edited on, so anything that reads the
// element directly (a glyph, a summary) still finds a sensible number.
//
// designOn(design, size) is what a size is built and checked from. setOn(...) is how the inspector and the stage
// write a setting while a size is shown: for every size (the master; this size follows it again), or for this size
// only (an override).

import { ELEMENT_DEFS } from './geometry/face.js';
import { isFormula, evalFormula, parseFormula } from './expr.js';

/** The kinds of setting a size can change for itself: numbers, choices, switches and text. */
export const OVERRIDABLE = new Set(['number', 'select', 'bool', 'textarea']);
// settings the inspector draws with its own controls, which write the master: the slot or edge an element is placed
// on (they move x, y and rotation together), the font (an export loads the fonts the master uses), the pattern,
// style, fill and colour pickers, and the stack and target pickers. They are the same on every size. So is a
// drawing's form (filled, wall or line): whether it is open or closed belongs with its points, which the pen edits
// on the master (ui/pen.js). And so is what a combine does with its pieces, and what an outline follows and makes:
// they say what the element is, not how big.
export const MASTER_ONLY = new Set(['pattern', 'style', 'anchor', 'flush', 'stackOn', 'font', 'stepColors', 'fill', 'border', 'map', 'target', 'cellColors', 'colorMode', 'form', 'operation', 'source', 'band']);
export const paramDef = (el, key) => ELEMENT_DEFS[el?.kind]?.params.find(p => p.key === key) || null;
// (a surface's outline shape is an ordinary choice; every other element's shape is drawn by its own picker)
const masterOnly = (el, key) => MASTER_ONLY.has(key) || (key === 'shape' && el?.kind !== 'surface');
export const canOverride = (el, key) => OVERRIDABLE.has(paramDef(el, key)?.type) && !masterOnly(el, key);
export const canFormula = (el, key) => paramDef(el, key)?.type === 'number';
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const clampTo = (p, v) => Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, v));

/** A formula worked out for a size, kept inside its setting's range; null when it cannot be worked out. */
export function formulaOn(el, key, size) {
  const f = el?.expr?.[key];
  if (!isFormula(f)) return null;
  try { const p = paramDef(el, key), v = evalFormula(f, { W: size.w, H: size.h }); return p ? clampTo(p, v) : v; } catch { return null; }
}

/** A setting's value on `size`: its override there, else its formula worked out there, else the stored value. */
export function valueOn(el, key, size) {
  const o = el?.bySize?.[size.id];
  if (has(o, key) && canOverride(el, key)) return o[key];
  const f = formulaOn(el, key, size);
  return f ?? el?.[key];
}

/** The element as it is on `size`: the same object when nothing about it differs there. */
export function elementOn(el, size) {
  const o = el.bySize?.[size.id], f = el.expr;
  const keys = new Set([...(f ? Object.keys(f) : []), ...(o ? Object.keys(o) : [])]);
  if (!keys.size) return el;
  const out = { ...el };
  for (const k of keys) out[k] = valueOn(el, k, size);
  return out;
}

/** The design as one size is built and checked from: the same object when no element differs there. */
export function designOn(design, size) {
  let changed = false;
  const elements = design.elements.map(e => { const r = elementOn(e, size); if (r !== e) changed = true; return r; });
  return changed ? { ...design, elements } : design;
}

/** The settings this size changes for itself (overrides that apply). */
export function overridesOn(el, size) {
  const o = el.bySize?.[size.id];
  return o ? Object.keys(o).filter(k => canOverride(el, k)) : [];
}
/** The sizes (ids) that change `key` for themselves. */
export function sizesOverriding(el, key) {
  return Object.entries(el.bySize || {}).filter(([, o]) => has(o, key)).map(([id]) => id);
}
/** Any override at all on this element, or on any element of the design. */
export const hasOverrides = el => Object.values(el.bySize || {}).some(o => Object.keys(o).length);

function dropOverride(el, key, sizeId) {
  const o = el.bySize?.[sizeId];
  if (!has(o, key)) return;
  delete o[key];
  if (!Object.keys(o).length) delete el.bySize[sizeId];
  if (!Object.keys(el.bySize).length) delete el.bySize;
}

/**
 * Write a setting while `size` is shown. scope 'all': the master value, or a formula for a number setting (stored
 * with the value it comes to here), and this size follows the master again; other sizes keep their own. scope
 * 'size': this size only (a formula is worked out here and kept as its value). Returns the value now in effect on
 * `size`. Throws on a formula with a mistake (the field says what it is) or on a formula for a setting that is not
 * a number.
 */
export function setOn(el, key, value, size, scope = 'all') {
  const formula = isFormula(value);
  if (formula && !canFormula(el, key)) throw new Error('only a number setting can take a formula');
  if (scope === 'size' && canOverride(el, key)) {
    let v = value;
    if (formula) { const p = paramDef(el, key); v = clampTo(p, evalFormula(value, { W: size.w, H: size.h })); }
    // a value the size would get anyway is not its own (a drag along one axis writes the other unchanged)
    if (v === (formulaOn(el, key, size) ?? el[key])) { dropOverride(el, key, size.id); return v; }
    el.bySize ||= {};
    el.bySize[size.id] = { ...(el.bySize[size.id] || {}), [key]: v };
    return v;
  }
  if (formula) {
    const p = paramDef(el, key), v = clampTo(p, evalFormula(value, { W: size.w, H: size.h }));   // throws on a mistake
    el.expr = { ...(el.expr || {}), [key]: value.trim() };
    el[key] = v;
  } else {
    if (has(el.expr, key)) { delete el.expr[key]; if (!Object.keys(el.expr).length) delete el.expr; }
    el[key] = value;
  }
  dropOverride(el, key, size.id);
  return valueOn(el, key, size);
}

/**
 * The element as the inspector shows it on `size`: reading a setting gives the size's value, writing one goes
 * through setOn with the scope `scopeOf()` gives (a formula with a mistake is refused and `onError` told why). Its
 * [FORMULA] method says which formula a number field should show (none when this size has its own value).
 */
export const FORMULA = Symbol('formula');
export function viewOn(el, size, scopeOf = () => 'all', onError = () => {}) {
  return new Proxy(el, {
    get(t, k) {
      if (k === FORMULA) return key => (canFormula(t, key) && !has(t.bySize?.[size.id], key) && isFormula(t.expr?.[key]) ? t.expr[key] : null);
      return typeof k === 'string' && paramDef(t, k) ? valueOn(t, k, size) : t[k];
    },
    set(t, k, v) {
      if (typeof k === 'string' && paramDef(t, k)) { try { setOn(t, k, v, size, scopeOf()); } catch (e) { onError(e); } }
      else t[k] = v;
      return true;
    },
  });
}

/**
 * Formulas and per-size values from a design file, checked: a formula only on a number setting and only when it
 * parses; a per-size value only for a size that exists, a setting a size can change, and a value of the setting's
 * kind (numbers kept inside its range). Returns { expr?, bySize? } to merge into the element.
 */
export function cleanVariants(el, raw, sizeIds, cleanText = s => String(s).slice(0, 200)) {
  const out = {};
  if (raw?.expr && typeof raw.expr === 'object') {
    const ex = {};
    for (const [k, f] of Object.entries(raw.expr)) {
      if (!canFormula(el, k) || !isFormula(f)) continue;
      // only whether it parses: one that cannot be worked out on some size (it divides by W-100, say) falls back to
      // the stored value on that size alone (formulaOn), and is kept for the rest
      try { parseFormula(f); ex[k] = f.trim(); } catch { /* a broken formula is dropped; the stored value stands */ }
    }
    if (Object.keys(ex).length) out.expr = ex;
  }
  if (raw?.bySize && typeof raw.bySize === 'object') {
    const bs = {};
    for (const [id, o] of Object.entries(raw.bySize)) {
      if (!sizeIds.has(id) || !o || typeof o !== 'object') continue;
      const keep = {};
      for (const [k, v] of Object.entries(o)) {
        const p = paramDef(el, k);
        if (!p || !canOverride(el, k)) continue;
        if (p.type === 'number') { const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN; if (Number.isFinite(n)) keep[k] = clampTo(p, n); }
        else if (p.type === 'select') { if (p.options.some(([o2]) => o2 === v)) keep[k] = v; }
        else if (p.type === 'bool') keep[k] = !!v;
        else if (p.type === 'textarea' && (typeof v === 'string' || typeof v === 'number')) keep[k] = cleanText(v);
      }
      if (Object.keys(keep).length) bs[id] = keep;
    }
    if (Object.keys(bs).length) out.bySize = bs;
  }
  return out;
}

/** This size follows the master again for `key`. */
export function resetOn(el, key, size) { dropOverride(el, key, size.id); return valueOn(el, key, size); }
/** Every size follows the master again for `key` (all its overrides go). */
export function resetEverywhere(el, key) { for (const id of Object.keys(el.bySize || {})) dropOverride(el, key, id); }
