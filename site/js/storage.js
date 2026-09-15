// Where a path's data is kept between visits, all of it keyed by NAR hash
// so two closures sharing a path share its entries.
//
//   IndexedDB  summaries   coarse byte summaries            kept forever
//              indexes     the NAR's file index             kept forever
//              refs        store-path references found       kept forever
//              raw         which NARs are on disk, and size kept with the files
//   OPFS       raw/<hash>  the decompressed NAR             evicted by LRU
//              fine/<hash> its 256-byte summaries           evicted with it
//
// IndexedDB falls back to in-memory maps when it cannot be opened (some
// private windows). OPFS reports itself unavailable instead, and the page
// then keeps raw bytes in the tile worker's memory.

const DB_NAME = "seenix";
const DB_VERSION = 1;

export const Store = Object.freeze({
  SUMMARIES: "summaries",
  INDEXES: "indexes",
  REFS: "refs",
  RAW: "raw",
});

const memory = new Map(Object.values(Store).map((name) => [name, new Map()]));

let dbPromise;
function openDb() {
  dbPromise ??= new Promise((resolve) => {
    if (globalThis.indexedDB === undefined) {
      resolve(null);
      return;
    }
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      for (const name of Object.values(Store)) {
        if (!req.result.objectStoreNames.contains(name)) {
          req.result.createObjectStore(name);
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

const settle = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

// The values stored under `keys`, as a Map of the ones present.
export async function getMany(store, keys) {
  const result = new Map();
  const db = await openDb();
  if (db === null) {
    for (const key of keys) {
      if (memory.get(store).has(key)) {
        result.set(key, memory.get(store).get(key));
      }
    }
    return result;
  }

  try {
    const objects = db.transaction(store, "readonly").objectStore(store);
    await Promise.all(
      keys.map(async (key) => {
        const value = await settle(objects.get(key));
        if (value !== undefined) {
          result.set(key, value);
        }
      }),
    );
  } catch {
    // An unreadable store reads as empty: the data is fetched again.
  }
  return result;
}

export async function put(store, key, value) {
  const db = await openDb();
  if (db === null) {
    memory.get(store).set(key, value);
    return;
  }
  try {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    // Out of quota: the next visit fetches again.
  }
}

export async function remove(store, key) {
  const db = await openDb();
  if (db === null) {
    memory.get(store).delete(key);
    return;
  }
  try {
    await settle(
      db.transaction(store, "readwrite").objectStore(store).delete(key),
    );
  } catch {
    // Nothing to remove.
  }
}

const RAW_DIR = "raw";
const FINE_DIR = "fine";

// A NAR hash as a file name: "sha256:<nix32>" has a colon, which not
// every file system accepts, and nix32 has no dashes.
export const fileNameOf = (narHash) => narHash.replace(":", "-");

let dirsPromise;

// { raw, fine } directory handles, or null when OPFS is unavailable.
export function opfsDirs() {
  dirsPromise ??= (async () => {
    try {
      const root = await navigator.storage.getDirectory();
      return {
        raw: await root.getDirectoryHandle(RAW_DIR, { create: true }),
        fine: await root.getDirectoryHandle(FINE_DIR, { create: true }),
      };
    } catch {
      return null;
    }
  })();
  return dirsPromise;
}

// File snapshots by directory and name. A snapshot of a file that has
// since been removed or rewritten fails to read, and is dropped then.
const files = new Map();

export async function readSlice(dir, name, offset, length) {
  const key = `${dir.name}/${name}`;
  if (!files.has(key)) {
    files.set(
      key,
      dir.getFileHandle(name).then((handle) => handle.getFile()),
    );
  }
  try {
    const file = await files.get(key);
    const blob = file.slice(offset, offset + length);
    return new Uint8Array(await blob.arrayBuffer());
  } catch (err) {
    files.delete(key);
    throw err;
  }
}

// Delete a NAR's raw bytes and fine summaries.
export async function removeNarFiles(narHash) {
  const dirs = await opfsDirs();
  if (dirs === null) {
    return;
  }
  const name = fileNameOf(narHash);
  files.delete(`${RAW_DIR}/${name}`);
  files.delete(`${FINE_DIR}/${name}`);
  await dirs.raw.removeEntry(name).catch(() => {});
  await dirs.fine.removeEntry(name).catch(() => {});
}
