// extension/lib/db.js
// Minimal IndexedDB queue for offline audio chunks.
// Stores failed POST segments so we can flush them when back online,
// including the segment's start time "t" (seconds).

const DB_NAME = 'twinmind_offline';
const DB_VERSION = 2; // bumped to v2 to include 't'
const STORE = 'queue';

let _db = null;

function _prom(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB error'));
  });
}

export async function dbInit() {
  if (_db) return _db;
  const openReq = indexedDB.open(DB_NAME, DB_VERSION);
  openReq.onupgradeneeded = () => {
    const db = openReq.result;
    let store;
    if (!db.objectStoreNames.contains(STORE)) {
      store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      store.createIndex('byCreated', 'createdAt', { unique: false });
    } else {
      store = openReq.transaction.objectStore(STORE);
      // v2 ensures records carry 't' (start seconds). Older records may not have it.
      if (!store.indexNames.contains('byCreated')) {
        store.createIndex('byCreated', 'createdAt', { unique: false });
      }
    }
  };
  _db = await _prom(openReq);
  return _db;
}

function _tx(mode = 'readonly') {
  if (!_db) throw new Error('db not initialized');
  const tx = _db.transaction(STORE, mode);
  return { tx, store: tx.objectStore(STORE) };
}

/**
 * Add a queued item.
 * @param {{blob: Blob, mime?: string, seq?: number, t?: number}} rec
 */
export async function queueAdd({ blob, mime, seq, t }) {
  await dbInit();
  const { tx, store } = _tx('readwrite');
  const rec = {
    blob, // Blob (Chromium IDB stores Blobs)
    mime: mime || blob?.type || 'audio/webm',
    seq: Number(seq) || 0,
    t: typeof t === 'number' ? t : null, // start time in seconds (can be null)
    createdAt: Date.now(),
  };
  const id = await _prom(store.add(rec));
  await _prom(tx.done || tx.complete ? tx : { onsuccess: () => {}, onerror: () => {} });
  return id;
}

export async function queueTake(n = 3) {
  await dbInit();
  const { _tx, store } = _tx('readonly');
  const idx = store.index('byCreated');
  const items = [];
  return new Promise((resolve, reject) => {
    const cursorReq = idx.openCursor();
    cursorReq.onerror = () => reject(cursorReq.error || new Error('cursor error'));
    cursorReq.onsuccess = () => {
      const c = cursorReq.result;
      if (!c || items.length >= n) {
        resolve(items);
        return;
      }
      const v = c.value;
      items.push({
        id: v.id,
        blob: v.blob,
        mime: v.mime,
        seq: v.seq,
        t: v.t ?? null,
        createdAt: v.createdAt,
      });
      c.continue();
    };
  });
}

export async function queueRemove(ids = []) {
  if (!ids.length) return;
  await dbInit();
  const { tx, store } = _tx('readwrite');
  await Promise.all(ids.map((id) => _prom(store.delete(id))));
  await _prom(tx.done || tx.complete ? tx : { onsuccess: () => {}, onerror: () => {} });
}

export async function queueCount() {
  await dbInit();
  const { store } = _tx('readonly');
  return await _prom(store.count());
}

export async function queueClear() {
  await dbInit();
  const { tx, store } = _tx('readwrite');
  await _prom(store.clear());
  await _prom(tx.done || tx.complete ? tx : { onsuccess: () => {}, onerror: () => {} });
}
