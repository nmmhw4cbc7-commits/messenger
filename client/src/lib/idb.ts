// Minimal promise wrapper around IndexedDB. Everything Haven keeps on the
// device lives here: the identity keys, pinned contact keys, conversations
// and decrypted messages. Signing out deletes the whole database.

const DB_NAME = 'haven';
const DB_VERSION = 2;

export type StoreName = 'meta' | 'pins' | 'convs' | 'messages' | 'files';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (e.oldVersion < 1) {
        db.createObjectStore('meta');
        db.createObjectStore('pins', { keyPath: 'userId' });
        db.createObjectStore('convs', { keyPath: 'id' });
        const messages = db.createObjectStore('messages', { keyPath: 'id' });
        messages.createIndex('byConv', ['convId', 'sortKey']);
      }
      // Decrypted attachments, keyed by message id.
      if (e.oldVersion < 2) db.createObjectStore('files');
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgraded or deleted the database: let go of it.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database blocked by another tab'));
  });
  return dbPromise;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name: StoreName, mode: IDBTransactionMode) {
  return (await open()).transaction(name, mode).objectStore(name);
}

export async function get<T>(name: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return request((await store(name, 'readonly')).get(key));
}

export async function getAll<T>(name: StoreName): Promise<T[]> {
  return request((await store(name, 'readonly')).getAll());
}

export async function put(name: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
  await request((await store(name, 'readwrite')).put(value, key));
}

/** Write many records in one transaction; resolves once it is durable. */
export async function putMany(name: StoreName, values: unknown[]): Promise<void> {
  if (!values.length) return;
  const tx = (await open()).transaction(name, 'readwrite');
  const s = tx.objectStore(name);
  for (const v of values) s.put(v);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** All records of a store with their keys (for stores without a key path). */
export async function entries<T>(name: StoreName): Promise<[IDBValidKey, T][]> {
  const s = await store(name, 'readonly');
  const [keys, values] = await Promise.all([request(s.getAllKeys()), request(s.getAll())]);
  return keys.map((k, i) => [k, values[i] as T]);
}

export async function del(name: StoreName, key: IDBValidKey): Promise<void> {
  await request((await store(name, 'readwrite')).delete(key));
}

/** All messages of one conversation, oldest first. */
export async function messagesOf<T>(convId: string): Promise<T[]> {
  const index = (await store('messages', 'readonly')).index('byConv');
  return request(index.getAll(IDBKeyRange.bound([convId, -Infinity], [convId, Infinity]))) as Promise<T[]>;
}

export async function deleteMessagesOf(convId: string): Promise<void> {
  const tx = (await open()).transaction('messages', 'readwrite');
  const index = tx.objectStore('messages').index('byConv');
  const keys = await request(index.getAllKeys(IDBKeyRange.bound([convId, -Infinity], [convId, Infinity])));
  for (const k of keys) tx.objectStore('messages').delete(k);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Delete everything Haven stored on this device. */
export async function wipe(): Promise<void> {
  if (dbPromise) {
    (await dbPromise).close();
    dbPromise = null;
  }
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

/** Ask the browser not to evict our data under storage pressure. */
export function requestPersistence() {
  navigator.storage?.persist?.().catch(() => {});
}
