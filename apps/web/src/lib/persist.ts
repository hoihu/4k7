/**
 * Local-first persistence in IndexedDB. The API key is encrypted with a non-extractable
 * AES-GCM key that never leaves this browser profile.
 */
import type { Design } from '@tracewise/schema';

const DB = 'tracewise';
const VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of ['projects', 'settings', 'keys']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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
  await put('projects', 'current', json);
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
  await put('settings', 'settings', { ...s, version: SETTINGS_VERSION });
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
