/**
 * The one IndexedDB database, and the only file that opens it.
 *
 * Why IndexedDB and not `localStorage`: what is coming — Guitar Pro scores,
 * backing tracks, a cover timeline — is binary, large, and structured.
 * `localStorage` holds a few megabytes of strings, synchronously, on the one
 * thread that must never stall for more than 8 ms. IndexedDB holds `Blob`s
 * without base64, is asynchronous, and is bounded by the disk rather than by
 * a fixed quota. Everything stays on the player's machine: this is storage,
 * not a server (CLAUDE.md §1).
 *
 * Never a reason to fail. A browser that refuses storage (some private modes,
 * a full disk, a blocked upgrade) gets `null` from `openDb()`, and every caller
 * treats that as "nothing remembered": the rig still plays.
 */

export const DB_NAME = 'tonecraft';

/**
 * Object stores, by name. One constant per store so a typo is a type error.
 *
 * - `state` — small keyed records: the rig session today; later the timeline
 *   position, the open song, per-song loop points. Out-of-line keys.
 * - `media` — binary files the player gave us: DI takes today, `.gp`/`.gpx`
 *   scores and backing tracks tomorrow. Keyed by `MediaRecord.id`, indexed by
 *   `kind` so a library view can list one kind without reading every blob.
 */
export const STORES = {
  state: 'state',
  media: 'media',
} as const;
export type StoreName = (typeof STORES)[keyof typeof STORES];

/**
 * Schema migrations, in order. Entry `i` upgrades version `i` to `i + 1`, and
 * the database version is simply the length of this array.
 *
 * Append-only, like `schema/params.ts`: an entry that has shipped is never
 * edited, because a browser that already ran it will never run it again. A
 * new store (songs, timelines, markers) is a new entry at the end.
 */
const MIGRATIONS: readonly ((db: IDBDatabase, tx: IDBTransaction) => void)[] = [
  // 0 → 1
  (db) => {
    db.createObjectStore(STORES.state);
    const media = db.createObjectStore(STORES.media, { keyPath: 'id' });
    media.createIndex('kind', 'kind');
  },
];

export const DB_VERSION = MIGRATIONS.length;

let opening: Promise<IDBDatabase | null> | null = null;

/** The shared connection, opened once. `null` when this browser will not store anything. */
export function openDb(): Promise<IDBDatabase | null> {
  opening ??= new Promise<IDBDatabase | null>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = (event) => {
      const tx = request.transaction!;
      for (let v = event.oldVersion; v < DB_VERSION; v++) MIGRATIONS[v]!(request.result, tx);
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab running a newer page wants to upgrade: step aside rather
      // than block it. This tab falls back to "nothing remembered" until reload.
      db.onversionchange = () => { db.close(); opening = Promise.resolve(null); };
      resolve(db);
    };
    // An older page in another tab holds the connection. Its onversionchange
    // closes it, after which onsuccess fires; nothing to do meanwhile.
    request.onblocked = () => {};
    request.onerror = () => resolve(null);
  });
  return opening;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * One request in its own transaction. Every failure resolves to `fallback`:
 * callers are UI code, and a storage error is never worth an exception there.
 */
async function run<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  op: (s: IDBObjectStore) => IDBRequest<T>,
  fallback: T,
): Promise<T> {
  const db = await openDb();
  if (db === null) return fallback;
  try {
    const tx = db.transaction(store, mode);
    const result = await done(op(tx.objectStore(store)));
    if (mode === 'readwrite') {
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    }
    return result;
  } catch {
    return fallback;
  }
}

export function dbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return run<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>, undefined);
}

/** `key` only for stores with out-of-line keys (`state`). Resolves `false` when nothing was written. */
export async function dbPut(store: StoreName, value: unknown, key?: IDBValidKey): Promise<boolean> {
  const written = await run<IDBValidKey | null>(store, 'readwrite',
    (s) => s.put(value, key) as IDBRequest<IDBValidKey | null>, null);
  return written !== null;
}

export async function dbDelete(store: StoreName, key: IDBValidKey): Promise<void> {
  await run<undefined>(store, 'readwrite', (s) => s.delete(key), undefined);
}

export function dbGetAll<T>(store: StoreName, index?: string, query?: IDBValidKey): Promise<T[]> {
  return run<T[]>(store, 'readonly',
    (s) => (index === undefined ? s.getAll(query) : s.index(index).getAll(query)) as IDBRequest<T[]>, []);
}
