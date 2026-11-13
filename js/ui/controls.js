// Controls shared by the inspector and the Style pane, in the planner's vocabulary: a row is a label on the left and a
// compact control on the right; numbers are steppers with a mono field; short choices (and on/off) are segmented
// tracks; colours are swatches of the design's own colour slots. Every input carries data-k so a panel can put the
// keyboard back where it was after it re-renders.

import { state, commit, preview, colorHex } from '../state.js';
import { icon } from './icons.js';
import { isFormula, formulaProblem } from '../expr.js';
import { FORMULA } from '../variants.js';

export const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

export function h(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) if (c != null) e.append(c);
  return e;
}

export function showIf(p, obj) {
  if (!p.showIf) return true;
  return Object.entries(p.showIf).every(([k, v]) => Array.isArray(v) ? v.includes(obj[k]) : obj[k] === v);
}

export function section(title, children = [], extra = null) {
  return h('div', { class: 'sect' }, [extra ? h('div', { class: 'h2row' }, [h('span', { class: 'h2', text: title }), extra]) : h('div', { class: 'h2', text: title }), ...children]);
}

export function prow(label, control, help) {
  return h('div', { class: 'prow' }, [h('div', { class: 'lbl', text: label }), h('div', { class: 'ctl' }, [control]), help ? h('small', { class: 'help', text: help }) : null]);
}

const round = (v, step) => { const d = Math.max(0, -Math.floor(Math.log10(step || 1))) + 1; return +(Math.round(v / step) * step).toFixed(Math.min(4, d)); };

/** A stepper: minus, a mono field, plus, and the unit. Typing previews live; leaving the field or a step commits. */
export function numberCtl(value, p, onInput, onChange, key) {
  const clamp = v => Math.min(p.max, Math.max(p.min, v));
  // a field that takes formulas (p.formulas) is a text field: "=W-12" is worked out on every size (expr.js); one
  // that holds a formula (p.formula) shows it, with what it comes to on this size beside it
  const formulas = !!p.formulas, formula = typeof p.formula === 'string' ? p.formula : null;
  const num = s => parseFloat(String(s).replace(',', '.'));
  const input = formulas
    ? h('input', { class: `num${formula ? ' fx' : ''}`, type: 'text', inputmode: formula ? 'text' : 'decimal', autocomplete: 'off', spellcheck: 'false', 'data-k': key, 'aria-label': p.label || key, title: 'A number, or a formula worked out on every size, like =W-12 (W and H are the plate in mm)' })
    : h('input', { class: 'num', type: 'number', min: p.min, max: p.max, step: p.step, 'data-k': key, 'aria-label': p.label || key });
  input.value = formula ?? value ?? p.default;
  input.addEventListener('input', () => {
    if (formulas && isFormula(input.value)) {
      // a formula previews when it is finished (on change); while it is typed, a mistake is marked and said
      const bad = formulaProblem(input.value);
      input.classList.toggle('bad', !!bad); input.title = bad ? `Not yet: ${bad}` : 'Leave the field to use the formula';
      return;
    }
    input.classList.remove('bad');
    const v = num(input.value); if (Number.isFinite(v)) onInput(clamp(v));
  });
  // a rebuild that removes the focused field makes the browser send it a late change; its value already reached the
  // design through input (live preview) and the commit that caused the rebuild, so a removed field never commits
  input.addEventListener('change', () => {
    if (!input.isConnected) return;
    if (formulas && isFormula(input.value)) { if (!formulaProblem(input.value)) onChange(input.value.trim()); return; }
    const v = num(input.value); const c = clamp(Number.isFinite(v) ? v : p.default); input.value = c; onChange(c);
  });
  input.addEventListener('keydown', ev => { if (ev.key === 'Enter') input.blur(); });
  // (over a formula still being typed, a step starts from the value in effect, not from the half-typed text)
  const stepBy = dir => { const v = formulas && isFormula(input.value) ? Number(value) : num(input.value); const c = clamp(round((Number.isFinite(v) ? v : p.default) + dir * (p.step || 1), p.step || 1)); input.value = c; onChange(c); };
  // while this field has the keyboard, a step button leaves it there: the step applies to what was typed and the
  // keyboard is still in the field after the rebuild
  const keep = ev => { if (document.activeElement === input) ev.preventDefault(); };
  // a formula is not stepped: type a number over it to replace it
  const stepTitle = formula ? 'A formula: edit it, or type a number to replace it' : null;
  const minus = h('button', { class: 'key sm', type: 'button', 'aria-label': 'Less', tabindex: '-1', disabled: !!formula, title: stepTitle, onmousedown: keep, onclick: () => stepBy(-1) }, [icon('minus', { size: 14 })]);
  const plus = h('button', { class: 'key sm', type: 'button', 'aria-label': 'More', tabindex: '-1', disabled: !!formula, title: stepTitle, onmousedown: keep, onclick: () => stepBy(1) }, [icon('plus', { size: 14 })]);
  const came = formula && Number.isFinite(+value) ? h('span', { class: 'fxval', title: 'What the formula comes to on this size', text: `= ${+(+value).toFixed(2)}` }) : null;
  return h('span', { class: 'stepper' }, [minus, input, plus, p.unit ? h('span', { class: 'unit', text: p.unit === 'deg' ? '°' : p.unit }) : null, came]);
}

export function selectCtl(value, options, onChange, key) {
  const s = h('select', { class: 'sel', 'data-k': key });
  for (const [v, label] of options) { const o = h('option', { value: v, text: label }); if (v === value) o.selected = true; s.append(o); }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

/** A segmented track (the planner's .track/.seg): the current option is .on, never orange. */
export function segCtl(value, options, onChange, key) {
  const t = h('div', { class: 'track sm', role: 'group', 'data-k': key });
  for (const [v, label, ic] of options) {
    const b = h('button', { class: `seg${v === value ? ' on' : ''}`, type: 'button', 'aria-pressed': String(v === value), onclick: () => { if (v !== value) onChange(v); } }, [ic ? icon(ic, { size: 15 }) : null, label]);
    t.append(b);
  }
  return t;
}

export function boolCtl(value, onChange, key, labels = ['Off', 'On']) {
  return segCtl(!!value, [[false, labels[0]], [true, labels[1]]], onChange, key);
}

/** The design's colour slots as swatches (the backer is left out: nothing on the face prints in it). */
export function swatchCtl(value, onChange, key, { includeBacker = false } = {}) {
  const wrap = h('div', { class: 'swatches', role: 'radiogroup', 'data-k': key });
  for (const c of state.design.colors) {
    if (c.id === 'backer' && !includeBacker) continue;
    wrap.append(h('button', { class: 'swt', type: 'button', style: `--c:${c.hex}`, title: c.name, 'aria-label': c.name, 'aria-pressed': String(c.id === value), onclick: () => { if (c.id !== value) onChange(c.id); } }));
  }
  return wrap;
}

/** The right control for a schema parameter; writes obj[p.key] and previews or commits. */
export function paramCtl(obj, p, keyPrefix = '') {
  const key = keyPrefix + p.key;
  const set = (v, live) => { obj[p.key] = v; live ? preview() : commit(p.label); };
  switch (p.type) {
    case 'number': {
      // an element shown on a size (variants.viewOn) takes formulas in its number fields
      const fOf = obj[FORMULA];
      return numberCtl(obj[p.key], fOf ? { ...p, formulas: true, formula: fOf(p.key) } : p, v => set(v, true), v => set(v, false), key);
    }
    case 'select': {
      const short = p.options.length <= 3 && p.options.every(([, l]) => l.length <= 12);
      return short ? segCtl(obj[p.key], p.options, v => set(v, false), key) : selectCtl(obj[p.key], p.options, v => set(v, false), key);
    }
    case 'bool': return boolCtl(obj[p.key], v => set(v, false), key);
    case 'color': return swatchCtl(obj[p.key], v => set(v, false), key);
    case 'textarea': {
      // typing previews live; leaving the box commits (one undo step per edit, not per key)
      const lines = String(obj[p.key] ?? '').split('\n').length;
      const t = h('textarea', { class: 'field area', rows: String(Math.min(6, Math.max(2, lines))), maxlength: String(p.maxLength || 200), spellcheck: 'false', 'data-k': key, 'aria-label': p.label || key });
      t.value = obj[p.key] ?? '';
      t.addEventListener('input', () => { obj[p.key] = t.value; t.rows = Math.min(6, Math.max(2, t.value.split('\n').length)); preview(); });
      // committed on blur, not on change: a rebuild while typing (a font arriving) swaps in a new box that the browser
      // never sends a change for, though the edit is still waiting for its undo step and autosave
      t.addEventListener('blur', () => { if (!t.isConnected) return; obj[p.key] = t.value; commit(p.label); });
      // Escape deselects the element and removes this box before it could send its change: commit the edit first
      // (a commit that changed nothing adds no undo step)
      t.addEventListener('keydown', ev => { if (ev.key === 'Escape') { obj[p.key] = t.value; commit(p.label); } });
      return t;
    }
    default: { const i = h('input', { class: 'field', type: 'text', 'data-k': key }); i.value = obj[p.key] ?? ''; i.addEventListener('change', () => set(i.value, false)); return i; }
  }
}

const FOCUSABLE = 'button, input, select, textarea, [tabindex]';

/**
 * The render function for a panel that rebuilds on every commit. Without it a click in the panel is lost whenever
 * another field holds an edit: pressing the button blurs that field, the blur commits, the rebuild replaces the button
 * under the pointer, and the click never lands. While a press that started inside the panel is down, rebuilds wait;
 * the last one runs after the click (or half a second after release, for a press that never becomes a click).
 */
export function panelRenderer(root, build) {
  let pressing = false, pending = false, timer = 0;
  const run = () => { pending = false; keepFocus(root, build); };
  const release = () => {
    clearTimeout(timer);
    if (!pressing) return;
    pressing = false;
    if (pending) setTimeout(() => { if (pending) run(); });
  };
  root.addEventListener('pointerdown', () => { pressing = true; clearTimeout(timer); }, true);
  window.addEventListener('pointerup', () => { if (pressing) { clearTimeout(timer); timer = setTimeout(release, 500); } }, true);
  window.addEventListener('click', release, true);
  window.addEventListener('pointercancel', release, true);
  return () => { if (pressing) pending = true; else run(); };
}

/**
 * Remember which control had the keyboard, re-render, and give it back. The control is found by the nearest data-k:
 * the control's own, or its group's (a track's option, a swatch, a tile, a row's button), then by its position inside
 * that group, so a keyboard user who picks an option keeps their place after the rebuild.
 */
export function keepFocus(root, renderFn) {
  const a = document.activeElement;
  const holder = a && root.contains(a) ? a.closest('[data-k]') : null;
  const k = holder && root.contains(holder) ? holder.getAttribute('data-k') : null;
  const sub = k && holder !== a ? [...holder.querySelectorAll(FOCUSABLE)].indexOf(a) : -1;
  const sel = k && holder === a && a.selectionStart != null ? [a.selectionStart, a.selectionEnd] : null;
  renderFn();
  if (!k) return;
  const nh = root.querySelector(`[data-k="${CSS.escape(k)}"]`);
  const b = nh && sub >= 0 ? nh.querySelectorAll(FOCUSABLE)[sub] : nh;
  if (b && b.focus) { b.focus({ preventScroll: true }); if (sel && b.setSelectionRange) try { b.setSelectionRange(...sel); } catch { /* number inputs refuse */ } }
}

export { colorHex };
