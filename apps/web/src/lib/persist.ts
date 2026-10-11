/**
 * Local-first persistence in IndexedDB. The API key is encrypted with a non-extractable
 * AES-GCM key that never leaves this browser profile.
 */
import type { Artwork, PartCard } from '@4k7/schema';

const DB = '4k7';
/** The app's name before 4k7. A browser that ran it keeps its data under this name; it is copied over once. */
const OLD_DB = 'tracewise';
/** v2: 'library' store for imported parts; v3: 'datasheets' (PDFs by SHA-256); v4: 'artwork' (silkscreen graphics). */
const VERSION = 4;
const STORES = ['projects', 'settings', 'keys', 'library', 'datasheets', 'artwork'];

/** Last storage problem in this browser, for diagnostics ('ok' when saving works). */
export let storageHealth = 'ok';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      storageHealth = 'IndexedDB unavailable';
      reject(new Error(storageHealth));
      return;
    }
    // some managed/private browser setups never answer; don't hang the app on them
    const timer = setTimeout(() => {
      storageHealth = 'IndexedDB did not respond';
      reject(new Error(storageHealth));
    }, 3000);
    const req = indexedDB.open(DB, VERSION);
    let created = false;
    req.onblocked = () => {
      clearTimeout(timer);
      storageHealth = 'IndexedDB blocked by another tab';
      reject(new Error(storageHealth));
    };
    req.onupgradeneeded = (e) => {
      const db = req.result;
      created = e.oldVersion === 0;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      // the first open of a new database: bring over what the old name held, before anyone reads
      if (created) migration = copyDatabase(OLD_DB, req.result).catch(() => undefined);
      if (migration) migration.then(() => resolve(req.result));
      else resolve(req.result);
    };
    req.onerror = () => {
      clearTimeout(timer);
      storageHealth = `IndexedDB error: ${req.error?.message ?? 'unknown'}`;
      reject(req.error);
    };
  });
}

/** The copy from the old database name, so every open waits for it. */
let migration: Promise<void> | null = null;

const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/** An existing database by name, or null; never creates one. */
function openExisting(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    const req = indexedDB.open(name);
    req.onupgradeneeded = () => req.transaction?.abort(); // version 0: there was none
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

/** Copy every record of the stores both databases have. The old database is left as it was. */
async function copyDatabase(fromName: string, to: IDBDatabase): Promise<void> {
  const from = await openExisting(fromName);
  if (!from) return;
  try {
    for (const store of Array.from(from.objectStoreNames)) {
      if (!to.objectStoreNames.contains(store)) continue;
      const src = from.transaction(store, 'readonly').objectStore(store);
      const [keys, values] = await Promise.all([request(src.getAllKeys()), request(src.getAll())]);
      if (keys.length === 0) continue;
      const t = to.transaction(store, 'readwrite');
      const dst = t.objectStore(store);
      keys.forEach((k, i) => dst.put(values[i], k));
      await new Promise<void>((resolve, reject) => {
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    }
  } finally {
    from.close();
  }
}

/** Whether the browser keeps this site's storage (false in private windows or under some policies). */
export async function storagePersistent(): Promise<boolean | null> {
  try {
    return (await navigator.storage?.persisted?.()) ?? null;
  } catch {
    return null;
  }
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const get = <T>(store: string, key: string) => tx<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
const put = (store: string, key: string, value: unknown) => tx(store, 'readwrite', (s) => s.put(value, key));

/* --------------------------------- project -------------------------------- */

/** The saved project as stored (JSON text); the caller parses it, so an unreadable one can be kept. */
export async function loadProject(): Promise<string | undefined> {
  try {
    return (await get<string>('projects', 'current')) || undefined;
  } catch {
    return undefined;
  }
}

export async function saveProject(json: string): Promise<void> {
  try {
    await put('projects', 'current', json);
  } catch (e) {
    storageHealth = `saving the project failed: ${(e as Error).message}`;
  }
}

/** A saved project this version could not read, kept so the next save does not replace it. */
export interface KeptProject {
  key: string;
  json: string;
  reason: string;
  /** When it was set aside, ms since epoch. */
  at: number;
}

/** Move an unreadable saved project to its own key. False when even that failed. */
export async function keepProject(json: string, reason: string): Promise<boolean> {
  try {
    const at = Date.now();
    const kept: KeptProject = { key: `unreadable:${at}`, json, reason, at };
    await put('projects', kept.key, kept);
    await tx('projects', 'readwrite', (s) => s.delete('current')); // moved, so a reload does not keep it twice
    return true;
  } catch (e) {
    storageHealth = `keeping the unreadable project failed: ${(e as Error).message}`;
    return false;
  }
}

export async function loadKeptProjects(): Promise<KeptProject[]> {
  try {
    const all = await tx<unknown[]>('projects', 'readonly', (s) => s.getAll() as IDBRequest<unknown[]>);
    return (all ?? []).filter((v): v is KeptProject => typeof v === 'object' && v !== null && 'json' in v).sort((a, b) => a.at - b.at);
  } catch {
    return [];
  }
}

export async function deleteKeptProject(key: string): Promise<void> {
  await tx('projects', 'readwrite', (s) => s.delete(key));
}

/* ----------------------------- stored records ----------------------------- */

/**
 * Library parts and artwork are stored one record each, stamped with the format they were
 * written in. Bump a version when the record's shape changes and upgrade older records in
 * `readStored`'s caller (the `upgrade` argument).
 */
export const LIBRARY_FORMAT_VERSION = 1;
export const ARTWORK_FORMAT_VERSION = 1;

/** What a store held: the records this version can read, and how many a newer version wrote. */
export interface Stored<T> {
  items: T[];
  newer: number;
}

type Stamped<T> = T & { format?: number };

const stamp = <T>(record: T, format: number): Stamped<T> => ({ ...(JSON.parse(JSON.stringify(record)) as T), format }); // plain data, never a Svelte proxy

/**
 * Sort stored records by format: current ones as they are, older ones through `upgrade`,
 * newer ones left out (and left in the store). Records from before the stamp count as format 1.
 */
export function readStored<T>(records: Stamped<T>[], current: number, upgrade?: (record: T, from: number) => T): Stored<T> {
  const out: Stored<T> = { items: [], newer: 0 };
  for (const r of records) {
    const { format = 1, ...rest } = r;
    if (format > current) out.newer++;
    else out.items.push(format < current && upgrade ? upgrade(rest as T, format) : (rest as T));
  }
  return out;
}

/** Whether the record stored under this key was written by a newer version (saving would destroy it). */
async function newerStored(store: string, key: string, current: number): Promise<boolean> {
  const existing = await get<{ format?: number }>(store, key);
  return (existing?.format ?? 1) > current;
}

/* ------------------------------ part library ------------------------------ */

/** Parts imported from datasheets, kept in this browser. */
export async function loadLibrary(): Promise<Stored<PartCard>> {
  try {
    return readStored((await tx<Stamped<PartCard>[]>('library', 'readonly', (s) => s.getAll() as IDBRequest<Stamped<PartCard>[]>)) ?? [], LIBRARY_FORMAT_VERSION);
  } catch {
    return { items: [], newer: 0 };
  }
}

export async function saveLibraryPart(card: PartCard): Promise<void> {
  if (await newerStored('library', card.id, LIBRARY_FORMAT_VERSION)) throw new Error(`${card.id} was saved by a newer version of the app; update the app to change it`);
  await put('library', card.id, stamp(card, LIBRARY_FORMAT_VERSION));
}

export async function deleteLibraryPart(id: string): Promise<void> {
  await tx('library', 'readwrite', (s) => s.delete(id));
}

/* -------------------------------- artwork -------------------------------- */

/** Saved silkscreen artwork (logos, clipart), kept in this browser for every project. */
export async function loadArtwork(): Promise<Stored<Artwork>> {
  try {
    return readStored((await tx<Stamped<Artwork>[]>('artwork', 'readonly', (s) => s.getAll() as IDBRequest<Stamped<Artwork>[]>)) ?? [], ARTWORK_FORMAT_VERSION);
  } catch {
    return { items: [], newer: 0 };
  }
}

export async function saveArtwork(a: Artwork): Promise<void> {
  if (await newerStored('artwork', a.id, ARTWORK_FORMAT_VERSION)) throw new Error(`"${a.name}" was saved by a newer version of the app; update the app to change it`);
  await put('artwork', a.id, stamp(a, ARTWORK_FORMAT_VERSION));
}

export async function deleteArtwork(id: string): Promise<void> {
  await tx('artwork', 'readwrite', (s) => s.delete(id));
}

/** Datasheets of imported parts, so every value can be shown on its page. */
export interface StoredDatasheet {
  name: string;
  data: ArrayBuffer;
}

export async function saveDatasheet(hash: string, sheet: StoredDatasheet): Promise<void> {
  await put('datasheets', hash, sheet);
}

export async function deleteDatasheet(hash: string): Promise<void> {
  await tx('datasheets', 'readwrite', (s) => s.delete(hash));
}

/** A datasheet import waiting for review, kept so a reload does not lose it (the PDF is in "datasheets"). */
export async function savePendingImport(value: unknown | null): Promise<void> {
  try {
    if (value === null) await tx('settings', 'readwrite', (s) => s.delete('pendingImport'));
    else await put('settings', 'pendingImport', JSON.parse(JSON.stringify(value)));
  } catch (e) {
    storageHealth = `saving the pending import failed: ${(e as Error).message}`;
  }
}

export async function loadPendingImport<T>(): Promise<T | undefined> {
  try {
    return await get<T>('settings', 'pendingImport');
  } catch {
    return undefined;
  }
}

export async function loadDatasheet(hash: string): Promise<StoredDatasheet | undefined> {
  try {
    return await get<StoredDatasheet>('datasheets', hash);
  } catch {
    return undefined;
  }
}

/* -------------------------------- settings -------------------------------- */

export type ProviderKind = 'anthropic' | 'claude-code' | 'demo';
export type Mode = 'auto' | 'review';

export interface Settings {
  provider: ProviderKind;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  mode: Mode;
  fixBudget: number;
  theme: 'system' | 'light' | 'dark';
  /** The local server's access key and port, remembered so the tab reconnects by itself. */
  serverAccessKey: string;
  serverPort: number | null;
  /** Model alias for Claude Code in the app chat ('' = Claude Code's default). */
  claudeModel: string;
  /** Let Claude Code read the web (datasheets) in the app chat. */
  claudeWeb: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'demo',
  model: 'claude-opus-5',
  effort: 'high',
  mode: 'review',
  fixBudget: 5,
  theme: 'dark',
  serverAccessKey: '',
  serverPort: null,
  claudeModel: '',
  claudeWeb: false,
};

/** Bumped when a default changes in a way existing users should get (v2: dark blue theme). */
const SETTINGS_VERSION = 2;

export async function loadSettings(): Promise<Settings> {
  try {
    const saved = (await get<Partial<Settings> & { version?: number }>('settings', 'settings')) ?? {};
    // older versions: the 6-digit pairing code and the port of the "bridge" (now the local server)
    const { bridgeCode: _code, bridgePort: _port, ...rest } = saved as typeof saved & { bridgeCode?: string; bridgePort?: number | null };
    const merged = { ...DEFAULT_SETTINGS, ...rest };
    // v1 stored theme "system" without the user ever choosing it
    if ((saved.version ?? 1) < 2 && saved.theme === 'system') merged.theme = DEFAULT_SETTINGS.theme;
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  try {
    await put('settings', 'settings', { ...s, version: SETTINGS_VERSION });
  } catch (e) {
    storageHealth = `saving settings failed: ${(e as Error).message}`;
  }
}

/* ---------------------------------- API key -------------------------------- */

async function cryptoKey(): Promise<CryptoKey> {
  const existing = await get<CryptoKey>('keys', 'aes');
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await put('keys', 'aes', key);
  return key;
}

export async function saveApiKey(provider: string, apiKey: string): Promise<void> {
  if (!apiKey) {
    await put('settings', `key:${provider}`, null);
    return;
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cryptoKey(), new TextEncoder().encode(apiKey));
  await put('settings', `key:${provider}`, { iv, data });
}

export async function loadApiKey(provider: string): Promise<string> {
  try {
    const rec = await get<{ iv: Uint8Array; data: ArrayBuffer } | null>('settings', `key:${provider}`);
    if (!rec) return '';
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv as BufferSource }, await cryptoKey(), rec.data);
    return new TextDecoder().decode(plain);
  } catch {
    return '';
  }
}
