const DB_NAME = 'recherche-dirigeants';
const STORE_NAME = 'snapshots';
const LAST_KEY = 'last';

export function normalizeSnapshot({ rows = [], filters = {}, savedAt = new Date().toISOString() } = {}) {
  return { version: 1, rows: Array.isArray(rows) ? rows : [], filters: filters && typeof filters === 'object' ? filters : {}, savedAt };
}
function openDb() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('IndexedDB indisponible'));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function access(mode, operation) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}
export function saveSnapshot(snapshot) { return access('readwrite', store => store.put(normalizeSnapshot(snapshot), LAST_KEY)); }
export function loadLastSnapshot() { return access('readonly', store => store.get(LAST_KEY)); }
