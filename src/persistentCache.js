// Small IndexedDB key/value store for large, rebuildable caches (chart series,
// daily point buckets). localStorage is limited to ~5 MB per origin and shared
// by every cache of the app: once full, setItem fails silently and every page
// load recomputes from the network. IndexedDB has a much larger quota and
// stores Maps/arrays natively (structured clone, no JSON codec).
//
// Every call resolves (never rejects): null means "unavailable", and callers
// fall back to their previous localStorage/memory behaviour.
const DB_NAME = 'asset-tracker-cache-v1';
const STORE = 'kv';
const OPEN_TIMEOUT_MS = 1000;
let connection;

function open() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return connection ||= new Promise(resolve => {
    let timer = setTimeout(() => resolve(null), OPEN_TIMEOUT_MS);
    const done = value => { clearTimeout(timer); resolve(value); };
    let request;
    try { request = indexedDB.open(DB_NAME, 1); } catch { done(null); return; }
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => done(request.result);
    request.onerror = request.onblocked = () => done(null);
  });
}

function run(mode, operation) {
  return open().then(db => {
    if (!db) return null;
    return new Promise(resolve => {
      try {
        const transaction = db.transaction(STORE, mode);
        const request = operation(transaction.objectStore(STORE));
        transaction.oncomplete = () => resolve(request ? request.result ?? null : true);
        transaction.onabort = transaction.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }).catch(() => null);
}

export const isPersistentCacheAvailable = () => typeof indexedDB !== 'undefined';
export const cacheGet = key => run('readonly', store => store.get(key));
export const cacheSet = (key, value) => run('readwrite', store => { store.put(value, key); return null; });
export const cacheDelete = key => run('readwrite', store => { store.delete(key); return null; });
