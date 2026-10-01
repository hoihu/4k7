/**
 * Local-first persistence in IndexedDB. The API key is encrypted with a non-extractable
 * AES-GCM key that never leaves this browser profile.
 */
import type { Artwork, Design, PartCard } from '@tracewise/schema';

const DB = 'tracewise';
/** v2: 'library' store for imported parts; v3: 'datasheets' (PDFs by SHA-256); v4: 'artwork' (silkscreen graphics). */
const VERSION = 4;

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
    req.onblocked = () => {
      clearTimeout(timer);
      storageHealth = 'IndexedDB blocked by another tab';
      reject(new Error(storageHealth));
    };
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of ['projects', 'settings', 'keys', 'library', 'datasheets', 'artwork']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      resolve(req.result);
    };
    req.onerror = () => {
      clearTimeout(timer);
      storageHealth = `IndexedDB error: ${req.error?.message ?? 'unknown'}`;
      reject(req.error);
    };
  });
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

export async function loadProject(): Promise<Design | undefined> {
  try {
    const raw = await get<string>('projects', 'current');
    return raw ? (JSON.parse(raw) as Design) : undefined;
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

/* ------------------------------ part library ------------------------------ */

/** Parts imported from datasheets, kept in this browser. */
export async function loadLibrary(): Promise<PartCard[]> {
  try {
    return (await tx<PartCard[]>('library', 'readonly', (s) => s.getAll() as IDBRequest<PartCard[]>)) ?? [];
  } catch {
    return [];
  }
}

export async function saveLibraryPart(card: PartCard): Promise<void> {
  await put('library', card.id, JSON.parse(JSON.stringify(card)) as PartCard); // plain data, never a Svelte proxy
}

export async function deleteLibraryPart(id: string): Promise<void> {
  await tx('library', 'readwrite', (s) => s.delete(id));
}

/* -------------------------------- artwork -------------------------------- */

/** Saved silkscreen artwork (logos, clipart), kept in this browser for every project. */
export async function loadArtwork(): Promise<Artwork[]> {
  try {
    return (await tx<Artwork[]>('artwork', 'readonly', (s) => s.getAll() as IDBRequest<Artwork[]>)) ?? [];
  } catch {
    return [];
  }
}

export async function saveArtwork(a: Artwork): Promise<void> {
  await put('artwork', a.id, JSON.parse(JSON.stringify(a)) as Artwork);
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
  /** Claude Code bridge pairing, remembered so the tab reconnects by itself. */
  bridgeCode: string;
  bridgePort: number | null;
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
  bridgeCode: '',
  bridgePort: null,
  claudeModel: '',
  claudeWeb: false,
};

/** Bumped when a default changes in a way existing users should get (v2: dark blue theme). */
const SETTINGS_VERSION = 2;

export async function loadSettings(): Promise<Settings> {
  try {
    const saved = (await get<Partial<Settings> & { version?: number }>('settings', 'settings')) ?? {};
    const merged = { ...DEFAULT_SETTINGS, ...saved };
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
