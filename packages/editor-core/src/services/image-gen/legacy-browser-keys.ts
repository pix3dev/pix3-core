/**
 * The image-gen API keys an earlier editor kept in the browser: IndexedDB `pix3-secrets`, each
 * value AES-GCM encrypted with a non-extractable master key stored beside it (the 1.x
 * `SecretStorageService`, ids `[project:<id>:]ai-provider:<provider>:api-key`). 2.x keeps keys on
 * the dev server (plan §B.1); `AiImageSettingsService` reads these once, hands them over, and
 * deletes the database. Nothing here ever writes a secret.
 */

const DB_NAME = 'pix3-secrets';
const STORE = 'secrets';
const MASTER_KEY_ID = '__pix3_master_key__';

interface SecretRecord {
  readonly id: string;
  readonly iv?: Uint8Array | ArrayBuffer;
  readonly data?: ArrayBuffer;
  readonly key?: CryptoKey;
}

const supported = (): boolean =>
  typeof indexedDB !== 'undefined' &&
  typeof crypto !== 'undefined' &&
  typeof crypto.subtle !== 'undefined';

/** The database, or null when it does not exist (opening never creates it). */
const openExisting = (): Promise<IDBDatabase | null> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    let created = false;
    request.onupgradeneeded = () => {
      // Only a database that did not exist upgrades from version 0: abort, so none is left.
      created = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      created ? resolve(null) : reject(request.error ?? new Error('IndexedDB open error'));
  });

const readAll = (db: IDBDatabase): Promise<SecretRecord[]> =>
  new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(STORE)) {
      resolve([]);
      return;
    }
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result as SecretRecord[]);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB read error'));
  });

/** `id → plaintext` of every secret that still decrypts; null when there is no database. */
export const readLegacyBrowserKeys = async (): Promise<Map<string, string> | null> => {
  if (!supported()) return null;
  const db = await openExisting();
  if (!db) return null;
  let records: SecretRecord[];
  try {
    records = await readAll(db);
  } finally {
    db.close();
  }
  const master = records.find(record => record.id === MASTER_KEY_ID)?.key;
  const out = new Map<string, string>();
  if (!master) return out;
  for (const record of records) {
    if (record.id === MASTER_KEY_ID || !record.data || !record.iv) continue;
    try {
      const iv = record.iv instanceof Uint8Array ? record.iv : new Uint8Array(record.iv);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        master,
        record.data
      );
      out.set(record.id, new TextDecoder().decode(plain));
    } catch {
      // Undecryptable (another browser profile's master key): nothing to move.
    }
  }
  return out;
};

export const deleteLegacyBrowserKeys = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('IndexedDB delete error'));
    // Another tab holds it open: the delete completes when that tab closes it.
    request.onblocked = () => resolve();
  });
