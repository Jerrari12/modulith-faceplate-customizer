// Formulas in number fields (2026-11-11, after Erie Sign Studio's expressions): a value that starts with "=" is
// worked out again on every size, so "=W-12" is 12 mm narrower than the plate on all 18 of them.
//
// Names: W and H, the plate's width and height in mm on the size being built. Functions: min, max, round (to the
// nearest whole, or to a step: round(W/3, 0.5)), floor, ceil, abs, clamp(value, low, high). Operators + - * / and
// brackets, with the usual order. Nothing else: the formula is parsed here by hand (no eval, no Function), so a
// design file from anyone can carry one safely, and a mistake says what is wrong in words.

export const FORMULA_LIMITS = { length: 120, depth: 24 };
export const FORMULA_NAMES = ['W', 'H'];
const FUNCS = {
  min: { n: [1, 8], f: (...a) => Math.min(...a) },
  max: { n: [1, 8], f: (...a) => Math.max(...a) },
  round: { n: [1, 2], f: (x, step = 1) => (step > 0 ? Math.round(x / step) * step : Math.round(x)) },
  floor: { n: [1, 2], f: (x, step = 1) => (step > 0 ? Math.floor(x / step) * step : Math.floor(x)) },
  ceil: { n: [1, 2], f: (x, step = 1) => (step > 0 ? Math.ceil(x / step) * step : Math.ceil(x)) },
  abs: { n: [1, 1], f: x => Math.abs(x) },
  clamp: { n: [3, 3], f: (x, lo, hi) => Math.min(Math.max(x, lo), hi) },
};

/** A formula is a string whose first non-space character is "=". */
export const isFormula = v => typeof v === 'string' && /^\s*=/.test(v);

/** Tokens: numbers, names, operators, brackets and commas, each with where it starts (for the error messages). */
function tokens(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
    if (num) { out.push({ t: 'num', v: Number(num[1]), at: i }); i += num[1].length; continue; }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (name) { out.push({ t: 'name', v: name[0], at: i }); i += name[0].length; continue; }
    if ('+-*/(),'.includes(c)) { out.push({ t: c, at: i }); i++; continue; }
    throw new Error(`"${c}" is not part of a formula (use numbers, W, H, + - * / and brackets)`);
  }
  out.push({ t: 'end', at: src.length });
  return out;
}

/**
 * Parse a formula ("=W-12", the "=" optional) into a tree. Throws an Error whose message says what is wrong in
 * words. Names are case-insensitive: w and W are the plate width.
 */
export function parseFormula(text) {
  if (typeof text !== 'string') throw new Error('a formula is text, like =W-12');
  const src = text.replace(/^\s*=/, '');
  if (src.length > FORMULA_LIMITS.length) throw new Error(`a formula can be at most ${FORMULA_LIMITS.length} characters`);
  if (!src.trim()) throw new Error('the formula is empty: type something after the =, like =W-12');
  const tk = tokens(src);
  let p = 0, depth = 0;
  const peek = () => tk[p], take = () => tk[p++];
  const expect = (t, what) => { if (peek().t !== t) throw new Error(peek().t === 'end' ? `the formula stops before its ${what}` : `expected ${what} at "${src.slice(peek().at, peek().at + 8)}"`); return take(); };
  const deeper = () => { if (++depth > FORMULA_LIMITS.depth) throw new Error('the formula nests too deeply'); };
  function expr() {
    deeper();
    let left = term();
    while (peek().t === '+' || peek().t === '-') { const op = take().t; left = { op, a: left, b: term() }; }
    depth--;
    return left;
  }
  function term() {
    let left = unary();
    while (peek().t === '*' || peek().t === '/') { const op = take().t; left = { op, a: left, b: unary() }; }
    return left;
  }
  function unary() {
    if (peek().t === '-') { take(); deeper(); const a = unary(); depth--; return { op: 'neg', a }; }
    if (peek().t === '+') { take(); return unary(); }
    return primary();
  }
  function primary() {
    const t = peek();
    if (t.t === 'num') { take(); return { num: t.v }; }
    if (t.t === '(') { take(); const e = expr(); expect(')', 'closing bracket'); return e; }
    if (t.t === 'name') {
      take();
      const lower = t.v.toLowerCase();
      if (peek().t === '(') {
        const fn = Object.prototype.hasOwnProperty.call(FUNCS, lower) ? FUNCS[lower] : null;
        if (!fn) throw new Error(`"${t.v}" is not a function here (there are min, max, round, floor, ceil, abs, clamp)`);
        take();
        const args = [];
        if (peek().t !== ')') { args.push(expr()); while (peek().t === ',') { take(); args.push(expr()); } }
        expect(')', 'closing bracket');
        if (args.length < fn.n[0] || args.length > fn.n[1]) throw new Error(`${lower}() takes ${fn.n[0] === fn.n[1] ? fn.n[0] : `${fn.n[0]} to ${fn.n[1]}`} value${fn.n[1] === 1 ? '' : 's'}`);
        return { fn: lower, args };
      }
      const name = FORMULA_NAMES.find(n => n.toLowerCase() === lower);
      if (!name) throw new Error(`"${t.v}" is not a name a formula knows (W is the plate's width, H its height, in mm)`);
      return { name };
    }
    if (t.t === 'end') throw new Error('the formula stops in the middle');
    throw new Error(`expected a number, W, H or a bracket at "${src.slice(t.at, t.at + 8)}"`);
  }
  const tree = expr();
  if (peek().t !== 'end') throw new Error(`"${src.slice(peek().at, peek().at + 8)}" does not belong there`);
  return tree;
}

function run(node, vars) {
  if ('num' in node) return node.num;
  if ('name' in node) return vars[node.name];
  if (node.fn) return FUNCS[node.fn].f(...node.args.map(a => run(a, vars)));
  if (node.op === 'neg') return -run(node.a, vars);
  const a = run(node.a, vars), b = run(node.b, vars);
  if (node.op === '+') return a + b;
  if (node.op === '-') return a - b;
  if (node.op === '*') return a * b;
  if (node.op === '/') { if (b === 0) throw new Error('the formula divides by zero'); return a / b; }
  throw new Error('a formula the parser does not know');
}

/** Work a formula out for a plate { W, H } in mm. Throws (in words) on a mistake or a result that is not a number. */
export function evalFormula(text, vars) {
  const v = run(parseFormula(text), { W: Number(vars?.W), H: Number(vars?.H) });
  if (!Number.isFinite(v)) throw new Error('the formula does not come to a number');
  return v;
}

/** The check a field runs as you type: null when the formula is fine, else what is wrong. */
export function formulaProblem(text) {
  try { parseFormula(text); return null; } catch (e) { return e.message; }
}
