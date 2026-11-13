// Pins formulas in number fields (2026-11-11): the usual arithmetic in the usual order, W and H as the plate's size
// in mm, a handful of functions, mistakes said in words, and nothing a design file could use to run code.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const E = await import('../js/expr.js');
const plate = { W: 175, H: 55 };
const ev = s => E.evalFormula(s, plate);

test('arithmetic, order, brackets, signs and decimals', () => {
  assert.equal(ev('=W-12'), 163);
  assert.equal(ev('= W - 12'), 163, 'spaces anywhere');
  assert.equal(ev('=2+3*4'), 14); assert.equal(ev('=(2+3)*4'), 20);
  assert.equal(ev('=10-4-3'), 3, 'left to right'); assert.equal(ev('=48/4/2'), 6);
  assert.equal(ev('=-W/2+10'), -77.5); assert.equal(ev('=--3'), 3); assert.equal(ev('=+3'), 3);
  assert.equal(ev('=.5+5.'), 5.5); assert.equal(ev('=w/5'), 35, 'names in either case');
  assert.equal(ev('W-12'), 163, 'the = is optional when parsing');
});

test('functions', () => {
  assert.equal(ev('=min(W, 100)'), 100); assert.equal(ev('=max(H, 60, 10)'), 60);
  assert.equal(ev('=round(W/3)'), 58); assert.equal(ev('=round(W/3, 0.5)'), 58.5);
  assert.equal(ev('=floor(W/3, 5)'), 55); assert.equal(ev('=ceil(H/4)'), 14);
  assert.equal(ev('=abs(H-W)'), 120); assert.equal(ev('=clamp(W/2, 10, 60)'), 60);
  assert.equal(ev('=MIN(w,h)'), 55, 'function names in either case');
});

test('mistakes are said in words', () => {
  const says = (s, re) => assert.throws(() => ev(s), e => re.test(e.message), `${s} -> ${re}`);
  says('=', /empty/); says('=W-', /stops/); says('=(W-12', /closing bracket/);
  says('=Q+1', /not a name a formula knows/); says('=W 12', /does not belong there/);
  says('=sin(W)', /not a function here/); says('=clamp(W, 1)', /takes 3 values/);
  says('=W/(H-55)', /divides by zero/); says('=W;12', /not part of a formula/);
  says(`=${'1+'.repeat(80)}1`, /at most 120/);
  says(`=${'('.repeat(30)}1${')'.repeat(30)}`, /nests too deeply/);
  assert.equal(E.formulaProblem('=W-12'), null); assert.match(E.formulaProblem('=W-'), /stops/);
});

test('nothing in a formula can reach code', () => {
  for (const s of ['=constructor', '=__proto__', '=toString()', '=constructor.constructor("x")()', '=alert(1)', '=W["x"]', '=hasOwnProperty(W)', '=valueOf()'])
    assert.throws(() => ev(s), Error, s);
  assert.ok(E.isFormula(' =W') && !E.isFormula('12') && !E.isFormula(12) && !E.isFormula(null));
});
