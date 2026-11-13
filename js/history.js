// Version history (2026-11-11, after Erie Sign Studio's): every change to a design is kept in this browser, so any
// earlier state can be looked at and brought back, and nothing is lost to a slip of the mouse weeks later.
//
// The rules, Erie's: edits fold into 10-minute steps (a step that started less than ten minutes ago takes the newest
// state); after two weeks one step a day is kept, after three months one a week, and at most 200 such steps per
// design. A version you name, and every version you downloaded, are kept until you delete them.
//
// A design's history follows it by a lineage id, which its entry in the browser's list carries, never by its name
// (two designs may share a name, and a design is renamed freely).
//
// Storage: IndexedDB, because a design holding a picture or a mesh would fill localStorage in a handful of saves.
// The big strings inside a design (pictures, meshes) are stored once, under their SHA-256, and shared by every
// version that holds them; the rest of each version is compact JSON. Where there is no IndexedDB (tests, a browser
// that refuses it) the history lives in memory for the session.

export const HISTORY_RULES = { foldMs: 10 * 60e3, dailyAfterMs: 14 * 864e5, weeklyAfterMs: 90 * 864e5, maxAuto: 200, blobMin: 2048, actions: 12 };
export const HISTORY_KINDS = { auto: 'Autosave', saved: 'Saved', download: 'Downloaded' };

export function newLineage() { return `h_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; }

// ---- the rules, as pure functions

/** A local calendar day and a Monday-to-Sunday week, as numbers (two times share a key when they share the day). */
export function dayKey(t) { const d = new Date(t); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }
export function weekKey(t) { const d = new Date(t); return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5 + 3) / 7); }

/** Whether a new autosave folds into `last` (the design's newest version) rather than starting a step of its own. */
export function foldsInto(last, now, rules = HISTORY_RULES) {
  return !!last && last.kind === 'auto' && now >= last.start && now - last.start < rules.foldMs;
}

/**
 * The autosaves to drop: past two weeks, all but the newest of each day; past three months, all but the newest of
 * each week; then all but the newest maxAuto. Named and downloaded versions are never dropped.
 */
export function thinPlan(versions, now, rules = HISTORY_RULES) {
  const autos = versions.filter(v => v.kind === 'auto').sort((a, b) => b.end - a.end);
  const drop = new Set(), days = new Set(), weeks = new Set();
  for (const v of autos) {
    const age = now - v.end;
    if (age > rules.weeklyAfterMs) { const k = weekKey(v.end); if (weeks.has(k)) drop.add(v.id); else weeks.add(k); }
    else if (age > rules.dailyAfterMs) { const k = dayKey(v.end); if (days.has(k)) drop.add(v.id); else days.add(k); }
  }
  autos.filter(v => !drop.has(v.id)).slice(rules.maxAuto).forEach(v => drop.add(v.id));
  return [...drop];
}

// ---- packing: big strings out to shared blobs, and back

async function sha256(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** A design file as compact JSON with its big strings replaced by { $blob: hash }; `found` maps hash -> string. */
async function pack(json, rules) {
  const obj = JSON.parse(json);
  delete obj.saved;   // the time a file was written: every version has its own times
  const big = new Set();
  const collect = v => {
    if (typeof v === 'string') { if (v.length >= rules.blobMin) big.add(v); }
    else if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object' || typeof x === 'string') collect(x); }
    else if (v && typeof v === 'object') for (const k in v) collect(v[k]);
  };
  collect(obj);
  const hashOf = new Map();
  for (const s of big) hashOf.set(s, await sha256(s));
  const swap = v => {
    if (typeof v === 'string') return hashOf.has(v) ? { $blob: hashOf.get(v) } : v;
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) if (v[i] && typeof v[i] === 'object' || typeof v[i] === 'string') v[i] = swap(v[i]); return v; }
    if (v && typeof v === 'object') { for (const k in v) v[k] = swap(v[k]); return v; }
    return v;
  };
  const body = JSON.stringify(swap(obj));
  const found = new Map();
  for (const [s, h] of hashOf) found.set(h, s);
  return { body, found, meta: obj.design || obj };
}

async function unpack(body, getBlob) {
  const obj = JSON.parse(body);
  const need = new Set();
  const isRef = v => v && typeof v === 'object' && !Array.isArray(v) && typeof v.$blob === 'string' && Object.keys(v).length === 1;
  const collect = v => {
    if (isRef(v)) need.add(v.$blob);
    else if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object') collect(x); }
    else if (v && typeof v === 'object') for (const k in v) collect(v[k]);
  };
  collect(obj);
  const data = new Map();
  for (const h of need) {
    const s = await getBlob(h);
    if (typeof s !== 'string') throw new Error('a picture or mesh this version holds is missing from the browser\'s storage');
    data.set(h, s);
  }
  const swap = v => {
    if (isRef(v)) return data.get(v.$blob);
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) if (v[i] && typeof v[i] === 'object') v[i] = swap(v[i]); return v; }
    if (v && typeof v === 'object') { for (const k in v) v[k] = swap(v[k]); return v; }
    return v;
  };
  return JSON.stringify(swap(obj));
}

// ---- storage backends
//
// Every change to a version is one step of the storage, version and blob counts together: adding a version counts
// its blobs, changing one (a fold, a name) reads the stored version and moves the counts by what really changed,
// deleting one releases its blobs only when it was still there. IndexedDB runs overlapping readwrite transactions
// one at a time across every tab, so two tabs can never both count from the same number, nor both release one
// version (Sol 01a1cb9b). The reads (lists, the newest version, a blob) are single requests.

/** The count changes a version change makes: +1 for each blob it now holds, -1 for each it held. */
function refDeltas(add, drop) {
  const d = new Map();
  for (const h of add || []) d.set(h, (d.get(h) || 0) + 1);
  for (const h of drop || []) d.set(h, (d.get(h) || 0) - 1);
  return [...d].filter(([, n]) => n);
}

export function memoryBackend() {
  const versions = new Map(), blobs = new Map();
  let next = 1;
  const copy = v => (v ? JSON.parse(JSON.stringify(v)) : v);
  const apply = (deltas, found) => {
    for (const [h, n] of deltas) {
      const b = blobs.get(h), refs = (b ? b.refs : 0) + n;
      if (refs <= 0) blobs.delete(h);
      else if (b || found?.has(h)) blobs.set(h, { hash: h, data: b ? b.data : found.get(h), refs });
      else throw new Error('a version names a picture the browser does not have');
    }
  };
  return {
    kind: 'memory',
    async get(id) { return copy(versions.get(id)); },
    async byLineage(l) { return [...versions.values()].filter(v => v.lineage === l).map(copy); },
    async latest(l) { let out = null; for (const v of versions.values()) if (v.lineage === l && (!out || v.end > out.end || (v.end === out.end && v.id > out.id))) out = v; return copy(out); },
    async lineages() { return [...new Set([...versions.values()].map(v => v.lineage))]; },
    async getBlob(h) { const b = blobs.get(h); return b ? b.data : undefined; },
    async blobRec(h) { const b = blobs.get(h); return b ? { ...b } : undefined; },
    async addVersion(v, found) { const id = next++; apply(refDeltas(v.blobs), found); versions.set(id, copy({ ...v, id })); return id; },
    /** `fn(stored)` gives the new version; null when the version is gone (another tab removed it). */
    async updateVersion(id, fn, found) {
      const cur = versions.get(id);
      if (!cur) return null;
      const nextV = { ...fn(copy(cur)), id };
      apply(refDeltas(nextV.blobs, cur.blobs), found);
      versions.set(id, copy(nextV));
      return copy(nextV);
    },
    async deleteVersion(id) { const cur = versions.get(id); if (!cur) return false; versions.delete(id); apply(refDeltas([], cur.blobs)); return true; },
    async counts() { return { versions: versions.size, blobs: blobs.size }; },
  };
}

export function idbBackend(name = 'fpc-history') {
  const opened = new Promise((resolve, reject) => {
    const r = indexedDB.open(name, 2);
    r.onupgradeneeded = () => {
      const db = r.result, t = r.transaction;
      const vs = db.objectStoreNames.contains('versions') ? t.objectStore('versions') : db.createObjectStore('versions', { keyPath: 'id', autoIncrement: true });
      if (!vs.indexNames.contains('lineage')) vs.createIndex('lineage', 'lineage');
      // (lineage, end): the newest version of a design in one step, without reading the others
      if (!vs.indexNames.contains('lineageEnd')) vs.createIndex('lineageEnd', ['lineage', 'end']);
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'hash' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const req = async (store, mode, make) => {
    const db = await opened;
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode), q = make(t.objectStore(store));
      let out;
      q.onsuccess = () => { out = q.result; };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error || q.error);
      t.onabort = () => reject(t.error || new Error('the browser refused to store the version'));
    });
  };
  /** One readwrite transaction over versions and blobs; `work(versions, blobs, done)` sets the result with done(). */
  const change = async work => {
    const db = await opened;
    return new Promise((resolve, reject) => {
      const t = db.transaction(['versions', 'blobs'], 'readwrite');
      let out = null;
      work(t.objectStore('versions'), t.objectStore('blobs'), v => { out = v; });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('the browser refused to store the version'));
    });
  };
  // the counts, inside the caller's transaction: each blob read and written by requests of that same transaction
  const apply = (bs, deltas, found) => {
    for (const [h, n] of deltas) {
      const g = bs.get(h);
      g.onsuccess = () => {
        const b = g.result, refs = (b ? b.refs : 0) + n;
        if (refs <= 0) { if (b) bs.delete(h); }
        else if (b || found?.has(h)) bs.put({ hash: h, data: b ? b.data : found.get(h), refs });
        else throw new Error('a version names a picture the browser does not have');   // aborts the transaction
      };
    }
  };
  return {
    kind: 'indexeddb',
    get: id => req('versions', 'readonly', s => s.get(id)),
    byLineage: l => req('versions', 'readonly', s => s.index('lineage').getAll(l)),
    async latest(l) {
      const db = await opened;
      return new Promise((resolve, reject) => {
        let out;
        const t = db.transaction('versions', 'readonly');
        const c = t.objectStore('versions').index('lineageEnd').openCursor(IDBKeyRange.bound([l, -Infinity], [l, Infinity]), 'prev');
        c.onsuccess = () => { out = c.result ? c.result.value : null; };
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
      });
    },
    async lineages() {
      const db = await opened;
      return new Promise((resolve, reject) => {
        const out = [], t = db.transaction('versions', 'readonly'), c = t.objectStore('versions').index('lineage').openKeyCursor(null, 'nextunique');
        c.onsuccess = () => { const cur = c.result; if (cur) { out.push(cur.key); cur.continue(); } };
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
      });
    },
    getBlob: async h => (await req('blobs', 'readonly', s => s.get(h)))?.data,
    blobRec: h => req('blobs', 'readonly', s => s.get(h)),
    addVersion: (v, found) => change((vs, bs, done) => {
      const { id, ...rest } = v;
      const a = vs.add(rest);
      a.onsuccess = () => { done(a.result); apply(bs, refDeltas(rest.blobs), found); };
    }),
    updateVersion: (id, fn, found) => change((vs, bs, done) => {
      const g = vs.get(id);
      g.onsuccess = () => {
        const cur = g.result;
        if (!cur) return;
        const next = { ...fn(cur), id };
        vs.put(next);
        apply(bs, refDeltas(next.blobs, cur.blobs), found);
        done(next);
      };
    }),
    deleteVersion: id => change((vs, bs, done) => {
      const g = vs.get(id);
      g.onsuccess = () => {
        const cur = g.result;
        if (!cur) { done(false); return; }
        vs.delete(id);
        apply(bs, refDeltas([], cur.blobs));
        done(true);
      };
    }),
    async counts() {
      const n = store => req(store, 'readonly', s => s.count());
      return { versions: await n('versions'), blobs: await n('blobs') };
    },
  };
}

// ---- the history

/**
 * A history over a backend. Every call goes through one queue, and each record reads the design's newest version
 * fresh from storage (another tab may have written it since). Returns { record, list, get, keep, remove, lineages,
 * counts, flush }.
 */
export function createHistory({ backend = memoryBackend(), now = () => Date.now(), rules = HISTORY_RULES } = {}) {
  let queue = Promise.resolve();
  const run = fn => { const p = queue.then(fn); queue = p.catch(() => {}); return p; };
  const newest = list => list.reduce((a, v) => (!a || v.end > a.end || (v.end === a.end && v.id > a.id) ? v : a), null);
  const strip = ({ body, ...v }) => ({ ...v, bytes: body ? body.length : 0 });

  async function thin(lineage) {
    for (const id of thinPlan(await backend.byLineage(lineage), now(), rules)) await backend.deleteVersion(id);
  }

  /**
   * Keep `json` (a design file) in `lineage`'s history. kind 'auto' folds into a step under ten minutes old and
   * skips a state the newest version already holds; 'saved' (a name in `label`) and 'download' (the file name in
   * `label`) always make a version of their own. `action` is the edit's name (the undo label), collected per step;
   * `newStep` starts a step even inside the ten minutes (a restore). Resolves to the version written, or the newest
   * when nothing changed.
   */
  function record(lineage, json, { kind = 'auto', label = '', action = '', note = '', newStep = false } = {}) {
    return run(async () => {
      if (!lineage || typeof json !== 'string') return null;
      const t = now();
      const { body, found, meta } = await pack(json, rules);
      const blobs = [...found.keys()];
      const last = await backend.latest(lineage);   // read fresh: another tab may have written since
      const info = { name: String(meta.name || 'Untitled faceplate').slice(0, 120), elements: Array.isArray(meta.elements) ? meta.elements.length : 0, mode: meta.mode === 'up' ? 'up' : 'down', size: meta.sizes?.current || '' };
      if (kind === 'auto' && last && last.body === body) return strip(last);
      if (kind === 'auto' && !newStep && foldsInto(last, t, rules)) {
        // folded into the step as it is stored now (another tab may have folded into it too)
        const out = await backend.updateVersion(last.id, cur => ({ ...cur, ...info, body, blobs, end: t, edits: (cur.edits || 1) + 1,
          actions: action ? [...(cur.actions || []).filter(a => a !== action), action].slice(-rules.actions) : cur.actions || [] }), found);
        if (out) return strip(out);
      }
      const v = { lineage, kind: kind in HISTORY_KINDS ? kind : 'auto', start: t, end: t, label: String(label).slice(0, 120), note: String(note).slice(0, 200), actions: action ? [action] : [], edits: 1, ...info, body, blobs };
      v.id = await backend.addVersion(v, found);
      await thin(lineage);
      return strip(v);
    });
  }

  return {
    record,
    /** The versions of a design, newest first, without their contents. */
    list: lineage => run(async () => (await backend.byLineage(lineage)).sort((a, b) => b.end - a.end || b.id - a.id).map(strip)),
    /** One version with its design file (JSON) put back together. */
    get: id => run(async () => { const v = await backend.get(id); if (!v) return null; return { ...strip(v), json: await unpack(v.body, h => backend.getBlob(h)) }; }),
    /** Keep a version for good under a name (an autosave becomes a saved version). */
    keep: (id, label) => run(async () => {
      const out = await backend.updateVersion(id, cur => ({ ...cur, kind: cur.kind === 'download' ? 'download' : 'saved', label: String(label || cur.label || '').slice(0, 120) }));
      return out ? strip(out) : null;
    }),
    remove: id => run(() => backend.deleteVersion(id)),
    /** Every design this browser holds a history for: its newest name and time, and how many versions. */
    lineages: () => run(async () => {
      const out = [];
      for (const l of await backend.lineages()) {
        const list = await backend.byLineage(l), last = newest(list);
        if (last) out.push({ lineage: l, name: last.name, end: last.end, count: list.length });
      }
      return out.sort((a, b) => b.end - a.end);
    }),
    counts: () => run(() => backend.counts()),
    flush: () => run(async () => {}),
    get backend() { return backend.kind; },
  };
}

/**
 * IndexedDB, falling back to memory for the session when the browser has none or refuses to open it (some private
 * windows): the history then still works until the page closes, and `kind` says which it is.
 */
export function autoBackend() {
  const mem = memoryBackend();
  if (typeof indexedDB === 'undefined') return mem;
  let use = null;
  const idb = idbBackend();
  const pick = async () => {
    if (use) return use;
    try { await idb.counts(); use = idb; } catch (e) { console.warn('version history: IndexedDB unavailable, keeping it in memory', e); use = mem; }
    return use;
  };
  const out = { get kind() { return use ? use.kind : 'indexeddb'; } };
  for (const k of Object.keys(mem)) if (typeof mem[k] === 'function') out[k] = async (...a) => (await pick())[k](...a);
  return out;
}

/** The history this page keeps: IndexedDB when the browser has it, else memory. */
export const history = createHistory({ backend: autoBackend() });
