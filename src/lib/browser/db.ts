/** Minimal promise-based IndexedDB wrapper. Everything (projects, source videos, analysis) stays on this device. */

const DB_NAME = "clipping";
const DB_VERSION = 1;
export const JOBS = "jobs";
export const BLOBS = "blobs";
export const DATA = "data";

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(JOBS)) db.createObjectStore(JOBS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
      if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name: string, mode: IDBTransactionMode) {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export async function idbGet<T>(name: string, key: string): Promise<T | undefined> {
  return wrap((await store(name, "readonly")).get(key)) as Promise<T | undefined>;
}

export async function idbPut(name: string, value: unknown, key?: string): Promise<void> {
  await wrap((await store(name, "readwrite")).put(value, key));
}

export async function idbDelete(name: string, key: string | IDBKeyRange): Promise<void> {
  await wrap((await store(name, "readwrite")).delete(key));
}

export async function idbAll<T>(name: string): Promise<T[]> {
  return wrap((await store(name, "readonly")).getAll()) as Promise<T[]>;
}

/** Delete every key that starts with `prefix`. */
export async function idbDeletePrefix(name: string, prefix: string): Promise<void> {
  await idbDelete(name, IDBKeyRange.bound(prefix, prefix + "\uffff"));
}

/** Ask the browser not to evict our data under storage pressure. */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : null;
  } catch {
    return null;
  }
}
