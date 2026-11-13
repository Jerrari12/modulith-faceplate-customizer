// Pins version history (2026-11-11, after Erie Sign Studio's): edits fold into 10-minute steps, an unchanged state
// adds nothing, named and downloaded versions are their own and never thinned, autosaves thin to one a day after two
// weeks and one a week after three months (200 at most), a picture or mesh is stored once however many versions
// hold it and goes with the last of them, every version comes back exactly, and the open design's history follows it
// through the browser's list, restores as one undo step, and keeps every download.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pcLib = require('../vendor/polygon-clipping/polygon-clipping.umd.js');
if (pcLib && pcLib.union) globalThis.polygonClipping = pcLib;
const store = new Map();
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };

const Hm = await import('../js/history.js');
const { newDesign, serializeDesign, parseDesign } = await import('../js/export/design.js');
const { newElement } = await import('../js/geometry/face.js');
const { bytesToB64 } = await import('../js/geometry/image.js');

const MIN = 60e3, DAY = 864e5;
// one design object per shape, serialised afresh each time (a new file time, the same design)
const made = new Map();
const design = (n, extra = {}) => { const k = JSON.stringify([n, extra]); if (!made.has(k)) made.set(k, newDesign({ name: 'Drawer', elements: Array.from({ length: n }, (_, i) => newElement('shape', { w: 10 + i })), ...extra })); return serializeDesign(made.get(k)); };
const clocked = (rules = Hm.HISTORY_RULES) => { const c = { t: Date.UTC(2026, 0, 5, 9, 0) }; const H = Hm.createHistory({ backend: Hm.memoryBackend(), now: () => c.t, rules }); return { c, H }; };

test('edits fold into 10-minute steps; an unchanged state adds nothing; a name or a download is its own version', async () => {
  const { c, H } = clocked();
  await H.record('L', design(1), { action: 'Add shape' });
  c.t += 3 * MIN; await H.record('L', design(2), { action: 'Add shape' });
  c.t += 6 * MIN; await H.record('L', design(3), { action: 'Width' });
  let list = await H.list('L');
  assert.equal(list.length, 1, 'three edits inside ten minutes are one step');
  assert.equal(list[0].edits, 3); assert.deepEqual(list[0].actions, ['Add shape', 'Width']); assert.equal(list[0].elements, 3);
  c.t += 2 * MIN; await H.record('L', design(4), { action: 'Height' });
  assert.equal((await H.list('L')).length, 2, '11 minutes after the step began, a new one starts');
  c.t += MIN; await H.record('L', design(4), { action: 'Nothing' });
  list = await H.list('L');
  assert.equal(list.length, 2); assert.equal(list[0].edits, 1, 'the same design again (a new file time) changes nothing');
  await H.record('L', design(4), { kind: 'saved', label: 'Before the grip' });
  await H.record('L', design(4), { kind: 'download', label: 'drawer-2W-1H.3mf' });
  c.t += MIN; await H.record('L', design(5), { action: 'Grip' });
  list = await H.list('L');
  assert.deepEqual(list.map(v => v.kind), ['auto', 'download', 'saved', 'auto', 'auto'], 'an edit after a saved version starts its own step');
  assert.equal(list[2].label, 'Before the grip'); assert.equal(list[1].label, 'drawer-2W-1H.3mf');
  // keep an autosave under a name: it stops being an autosave
  const kept = await H.keep(list[4].id, 'First try');
  assert.equal(kept.kind, 'saved'); assert.equal(kept.label, 'First try');
});

test('autosaves thin to one a day after two weeks and one a week after three months; named and downloaded stay', async () => {
  const { c, H } = clocked();
  const start = c.t;
  let last = c.t;
  for (let i = 0; i < 120 * 4; i++) {   // four steps a day for 120 days
    await H.record('L', design(1 + (i % 7), { symmetry: i % 2 ? 'x' : 'off' }), { action: `e${i}`, newStep: true });
    if (i === 10) await H.record('L', design(1), { kind: 'saved', label: 'old milestone' });
    if (i === 11) await H.record('L', design(1), { kind: 'download', label: 'old.3mf' });
    last = c.t;
    c.t += 6 * 3600e3;
  }
  const list = await H.list('L'), now = last;   // ages as the last thinning saw them
  const autos = list.filter(v => v.kind === 'auto');
  const recent = autos.filter(v => now - v.end <= 14 * DAY), mid = autos.filter(v => now - v.end > 14 * DAY && now - v.end <= 90 * DAY), old = autos.filter(v => now - v.end > 90 * DAY);
  assert.ok(recent.length >= 14 * 4 - 1 && recent.length <= 14 * 4 + 1, `every step of the last two weeks (${recent.length})`);
  assert.equal(new Set(mid.map(v => Hm.dayKey(v.end))).size, mid.length, 'one a day between two weeks and three months');
  assert.ok(mid.length >= 75 && mid.length <= 77, `about 76 days of them (${mid.length})`);
  assert.equal(new Set(old.map(v => Hm.weekKey(v.end))).size, old.length, 'one a week before that');
  assert.ok(old.length >= 4 && old.length <= 6, `about a month of weeks (${old.length})`);
  assert.ok(list.some(v => v.kind === 'saved' && v.label === 'old milestone') && list.some(v => v.kind === 'download'), 'named and downloaded versions are never thinned');
  assert.ok(now - start > 119 * DAY);
  // a cap on the count, newest kept
  const { c: c2, H: H2 } = clocked({ ...Hm.HISTORY_RULES, maxAuto: 5 });
  for (let i = 0; i < 8; i++) { await H2.record('L', design(i + 1), { newStep: true }); c2.t += MIN; }
  const capped = await H2.list('L');
  assert.equal(capped.length, 5); assert.equal(capped[0].elements, 8, 'the newest five');
});

test('a picture is stored once however many versions hold it, comes back exactly, and goes with the last of them', async () => {
  const { c, H } = clocked();
  const g = new Uint8Array(200 * 200); for (let i = 0; i < g.length; i++) g[i] = (i * 37) % 251;
  const pic = { w: 200, h: 200, g: bytesToB64(g) };
  const base = newDesign({ name: 'Picture plate', mode: 'up', elements: [newElement('surface', { map: 'picture', data: pic }), newElement('shape', { w: 10 })] });
  const withPic = (w, data = pic) => { base.elements[0].data = data; base.elements[1].w = w; return serializeDesign(base); };
  const a = await H.record('P', withPic(10), { newStep: true }); c.t += MIN;
  const b = await H.record('P', withPic(20), { newStep: true }); c.t += MIN;
  await H.record('P', withPic(30), { newStep: true });
  let n = await H.counts();
  assert.equal(n.versions, 3); assert.equal(n.blobs, 1, 'one copy of the picture for three versions');
  assert.ok(b.bytes < 2000, `each version is small (${b.bytes} bytes) with the picture shared`);
  const back = parseDesign((await H.get(a.id)).json), orig = parseDesign(withPic(10));
  assert.deepEqual(back.elements.map(e => ({ ...e })), orig.elements.map(e => ({ ...e })), 'the version comes back exactly, picture and all');
  // a step whose picture changes lets go of the old one when it folds
  c.t += 20 * MIN;
  const g2 = g.map(v => 255 - v), other = { w: 200, h: 200, g: bytesToB64(g2) };
  await H.record('P', withPic(40), { newStep: true }); c.t += MIN;
  await H.record('P', withPic(40, other), { action: 'New picture' });
  n = await H.counts();
  assert.equal(n.blobs, 2, 'the first picture (still in three versions) and the new one');
  for (const v of await H.list('P')) await H.remove(v.id);
  n = await H.counts();
  assert.deepEqual(n, { versions: 0, blobs: 0 }, 'nothing left once every version is gone');
});

test('every design this browser holds a history for, newest first', async () => {
  const { c, H } = clocked();
  await H.record('A', serializeDesign(newDesign({ name: 'Kitchen', elements: [newElement('shape')] })));
  c.t += MIN; await H.record('B', serializeDesign(newDesign({ name: 'Garage', elements: [newElement('shape')] })));
  c.t += MIN; await H.record('B', serializeDesign(newDesign({ name: 'Garage', elements: [newElement('shape'), newElement('shape')] })), { kind: 'saved', label: 'x' });
  const ls = await H.lineages();
  assert.deepEqual(ls.map(l => [l.lineage, l.name, l.count]), [['B', 'Garage', 2], ['A', 'Kitchen', 1]]);
});

test('in the app: the open design\'s history follows its entry, restores as one undo step, and keeps downloads', async () => {
  const S = await import('../js/state.js');
  const { history } = Hm;
  store.clear();
  S.setDesign(newDesign({ name: 'Hall', elements: [newElement('shape', { w: 20 })] })); S.setKept(null);
  const L = S.lineage();
  S.state.design.elements[0].w = 30; S.commit('Width');
  S.state.design.elements[0].w = 40; S.commit('Width');
  await history.flush();
  let list = await history.list(L);
  assert.equal(list.length, 1, 'the opening and two edits, one step');
  assert.ok(list[0].actions.includes('Width'));
  await S.saveVersion('Wide');
  await S.noteDownload('hall-2W-1H.3mf');
  list = await history.list(L);
  assert.deepEqual(list.map(v => v.kind), ['download', 'saved', 'auto']);
  // bring the first state back: one undo step away from what was open
  const first = (await history.list(L)).at(-1);
  S.state.design.elements[0].w = 50; S.commit('Width');
  const old = await history.get(first.id);
  await S.restoreVersion(old.json, 'Brought back');
  assert.equal(S.state.design.elements[0].w, 40, 'the version came back (its newest state: 40 mm)');
  S.undo();
  assert.equal(S.state.design.elements[0].w, 50, 'Ctrl+Z returns to what was open');
  // the entry carries the lineage: another design and back, and the history continues
  assert.ok(S.saveLocal());
  const entry = S.savedDesigns()[0];
  assert.equal(entry.hist, L);
  S.fresh();
  assert.notEqual(S.lineage(), L, 'a new design starts its own history');
  assert.ok(S.loadLocal(entry.id));
  assert.equal(S.lineage(), L, 'reopening it continues its history');
});

test('Sol 01a1cb9b: two tabs adding the same picture at once count it twice; an entry kept before histories is its own lineage', async () => {
  const backend = Hm.memoryBackend();
  const A = Hm.createHistory({ backend }), B = Hm.createHistory({ backend });   // two tabs: one storage, two queues
  const g = new Uint8Array(160 * 160).map((_, i) => (i * 13) % 241);
  const d = newDesign({ name: 'Two tabs', mode: 'up', elements: [newElement('surface', { map: 'picture', data: { w: 160, h: 160, g: bytesToB64(g) } })] });
  const json = serializeDesign(d);
  const [a] = await Promise.all([A.record('T', json, { kind: 'saved', label: 'A' }), B.record('T', json, { kind: 'saved', label: 'B' })]);
  assert.equal((await A.counts()).blobs, 1);
  await A.remove(a.id);
  const left = (await B.list('T'))[0];
  assert.equal(JSON.parse((await B.get(left.id)).json).design.elements[0].data.g, bytesToB64(g), 'the other version still has its picture');
  // an entry from before histories, its design restored at boot (no setKept this visit)
  const S = await import('../js/state.js');
  store.set('fpc:saved', JSON.stringify([{ id: 'd_before', name: 'Old one', saved: new Date().toISOString(), json: serializeDesign(newDesign({ name: 'Old one' })) }]));
  S.prefs.set('keptId', 'd_before'); S.prefs.set('histId', null);
  assert.equal(S.lineage(), 'd_before', 'the same lineage setKept would give it');
});

test('Sol 01a1cb9b (2): two tabs removing one version, or folding one step, release a shared picture once', async () => {
  const pic = seed => { const g = new Uint8Array(150 * 150).map((_, i) => (i * seed) % 239); return { w: 150, h: 150, g: bytesToB64(g) }; };
  const plate = (data, w = 20) => serializeDesign(newDesign({ name: 'Shared', mode: 'up', elements: [newElement('surface', { map: 'picture', data }), newElement('shape', { w })] }));
  const P = pic(11), Q = pic(17);
  // removing the same version from two tabs at once
  let backend = Hm.memoryBackend();
  let A = Hm.createHistory({ backend }), B = Hm.createHistory({ backend });
  const v1 = await A.record('S', plate(P, 10), { kind: 'saved', label: 'one' });
  const v2 = await A.record('S', plate(P, 30), { kind: 'saved', label: 'two' });
  await Promise.all([A.remove(v1.id), B.remove(v1.id)]);
  assert.equal(JSON.parse((await B.get(v2.id)).json).design.elements[0].data.g, P.g, 'the other version keeps its picture');
  // folding the same step from two tabs at once, while a named version also holds the old picture
  backend = Hm.memoryBackend();
  const clock = { t: Date.UTC(2026, 0, 5, 9) };
  A = Hm.createHistory({ backend, now: () => clock.t }); B = Hm.createHistory({ backend, now: () => clock.t });
  const named = await A.record('F', plate(P, 10), { kind: 'saved', label: 'keep me' });
  clock.t += 60e3; await A.record('F', plate(P, 20), { action: 'Width' });
  clock.t += 60e3;
  await Promise.all([A.record('F', plate(Q, 25), { action: 'Picture' }), B.record('F', plate(Q, 25), { action: 'Picture' })]);
  assert.equal(JSON.parse((await A.get(named.id)).json).design.elements[0].data.g, P.g, 'the named version keeps the old picture');
  const step = (await A.list('F'))[0];
  assert.equal(JSON.parse((await A.get(step.id)).json).design.elements[0].data.g, Q.g, 'the step holds the new one');
  for (const v of await A.list('F')) await A.remove(v.id);
  assert.deepEqual(await A.counts(), { versions: 0, blobs: 0 }, 'and every count comes out even');
});
