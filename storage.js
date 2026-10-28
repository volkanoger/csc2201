// Keeps the project's files in IndexedDB. Falls back to memory if IndexedDB is unavailable.

const DB_NAME = 'python-ide';
const STORE = 'files';

let dbPromise = null;
let memory = null; // used when IndexedDB cannot be opened

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'name' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
  }));
}

/** Returns all files as {name: content}. */
export async function loadFiles() {
  try {
    const rows = await tx('readonly', (store) => store.getAll());
    return Object.fromEntries(rows.map((r) => [r.name, r.content]));
  } catch (err) {
    console.warn('IndexedDB unavailable, files will not be saved:', err);
    memory = memory || {};
    return { ...memory };
  }
}

export async function saveFile(name, content) {
  if (memory) { memory[name] = content; return; }
  await tx('readwrite', (store) => store.put({ name, content }));
}

export async function deleteFile(name) {
  if (memory) { delete memory[name]; return; }
  await tx('readwrite', (store) => store.delete(name));
}

export async function renameFile(oldName, newName, content) {
  if (memory) { delete memory[oldName]; memory[newName] = content; return; }
  await tx('readwrite', (store) => {
    store.delete(oldName);
    store.put({ name: newName, content });
  });
}
