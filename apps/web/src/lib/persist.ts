/**
 * Persistence in this browser's IndexedDB: settings and the API keys. Projects, imported parts,
 * artwork and datasheets are files on this computer (files.ts, disk.svelte.ts). The
 * API key is encrypted with a non-extractable AES-GCM key that never leaves this browser profile.
 *
 * Versions before the files kept everything in IndexedDB; `browserData` reads it once to move it
 * to the server (the browser's copy is left as it was).
 */
import type { ApiServiceId } from '@4k7/agent';
import { migrateRulesText, type AgentEffort, type Artwork, type CheckSettings, type HarnessId, type PartCard } from '@4k7/schema';

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

/* ------------------------- what the browser kept before ------------------------- */

/** A saved project this version could not read, set aside by versions before the files. */
export interface KeptProject {
  key: string;
  json: string;
  reason: string;
  /** When it was set aside, ms since epoch. */
  at: number;
}

/** Everything versions before the files kept in this browser, to move to the server. */
export interface BrowserData {
  /** The project (JSON text). */
  project?: string;
  kept: KeptProject[];
  /** Records as stored, format stamp included. */
  library: unknown[];
  artwork: unknown[];
  datasheets: { hash: string; sheet: StoredDatasheet }[];
}

/** The project the browser kept (JSON text). */
export async function loadBrowserProject(): Promise<string | undefined> {
  try {
    return (await get<string>('projects', 'current')) || undefined;
  } catch {
    return undefined;
  }
}

async function all<T>(store: string): Promise<{ key: string; value: T }[]> {
  const db = await open();
  const s = db.transaction(store, 'readonly').objectStore(store);
  const [keys, values] = await Promise.all([request(s.getAllKeys()), request(s.getAll() as IDBRequest<T[]>)]);
  return keys.map((k, i) => ({ key: String(k), value: values[i]! }));
}

export async function browserData(): Promise<BrowserData> {
  const projects = await all<unknown>('projects');
  return {
    project: await loadBrowserProject(),
    kept: projects.map((p) => p.value).filter((v): v is KeptProject => typeof v === 'object' && v !== null && 'json' in v).sort((a, b) => a.at - b.at),
    library: (await all<unknown>('library')).map((r) => r.value),
    artwork: (await all<unknown>('artwork')).map((r) => r.value),
    datasheets: (await all<StoredDatasheet>('datasheets')).map((r) => ({ hash: r.key, sheet: r.value })),
  };
}

/** Whether this browser's data was moved to the server already. */
export async function movedToDisk(): Promise<boolean> {
  try {
    return (await get<boolean>('settings', 'movedToDisk')) === true;
  } catch {
    return true; // nothing readable to move
  }
}

export async function markMovedToDisk(): Promise<void> {
  await put('settings', 'movedToDisk', true);
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

export type Stamped<T> = T & { format?: number };

export const stamp = <T>(record: T, format: number): Stamped<T> => ({ ...(JSON.parse(JSON.stringify(record)) as T), format }); // plain data, never a Svelte proxy

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

/** Datasheets of imported parts, so every value can be shown on its page. */
export interface StoredDatasheet {
  name: string;
  data: ArrayBuffer;
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


/* -------------------------------- settings -------------------------------- */

/** The chat: a coding agent on this computer (through the local server), or a model API with the user's key. */
export type ProviderKind = 'agent' | 'api';
export type Mode = 'auto' | 'review';

export interface Settings {
  provider: ProviderKind;
  /** Which coding agent answers the chat. */
  harness: HarnessId;
  /** Model per agent ('' or missing = the agent's default). */
  harnessModels: Partial<Record<HarnessId, string>>;
  /** Effort per agent (missing = the agent's default). */
  harnessEfforts: Partial<Record<HarnessId, AgentEffort>>;
  /** Let the agent read the web (datasheets) in the app chat. */
  agentWeb: boolean;
  /** Which API, its address where it differs from the service's default, and the model, per service. */
  api: ApiServiceId;
  apiUrls: Partial<Record<ApiServiceId, string>>;
  apiModels: Partial<Record<ApiServiceId, string>>;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Models starred in the chat's model picker (see models.ts, choiceKey). */
  favoriteModels: string[];
  mode: Mode;
  fixBudget: number;
  theme: 'system' | 'light' | 'dark';
  /** The local server's access key and port, remembered so the tab reconnects by itself. */
  serverAccessKey: string;
  serverPort: number | null;
  /** The project open last (its file's name in the projects folder); '' = the newest. */
  project: string;
  /** The user's notes on how they want schematics drawn, sent to the agent with every request; '' = none. */
  schematicNotes: string;
  /** The user's levels and limits for the drawing checks (SCH.*), only where they differ from the shipped ones. */
  schematicChecks: CheckSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'agent',
  harness: 'claude-code',
  harnessModels: {},
  harnessEfforts: {},
  agentWeb: false,
  api: 'anthropic',
  apiUrls: {},
  apiModels: { anthropic: 'claude-opus-5' },
  effort: 'high',
  favoriteModels: [],
  mode: 'review',
  fixBudget: 5,
  theme: 'dark',
  serverAccessKey: '',
  serverPort: null,
  project: '',
  schematicNotes: '',
  schematicChecks: {},
};

/** Bumped when a default changes in a way existing users should get (v2: dark blue theme). */
const SETTINGS_VERSION = 2;

/** Settings as versions before the coding-agent choice saved them. */
interface OldSettings {
  provider?: string;
  model?: string;
  claudeModel?: string;
  claudeWeb?: boolean;
  bridgeCode?: string;
  bridgePort?: number | null;
  /** The ruleset text before notes and checks were split (2026-10-13): prose with "### SCH.ID" headings and level lines. */
  schematicRules?: string;
  version?: number;
}

export async function loadSettings(): Promise<Settings> {
  try {
    const saved = (await get<Partial<Settings> & OldSettings>('settings', 'settings')) ?? {};
    // older versions: the 6-digit pairing code and the port of the "bridge" (now the local server);
    // one provider each ("anthropic", "claude-code") before APIs and agents became choices
    const { bridgeCode: _code, bridgePort: _port, model, claudeModel, claudeWeb, provider, schematicRules, ...rest } = saved;
    const merged: Settings = { ...DEFAULT_SETTINGS, ...rest };
    // the ruleset text: its levels become check settings, its prose the notes ('' was the shipped default, which is gone)
    if (schematicRules && rest.schematicNotes === undefined) {
      const { notes, checks } = migrateRulesText(schematicRules);
      Object.assign(merged, { schematicNotes: notes, schematicChecks: checks });
    }
    // v1 stored theme "system" without the user ever choosing it
    if ((saved.version ?? 1) < 2 && saved.theme === 'system') merged.theme = DEFAULT_SETTINGS.theme;
    if (provider === 'api' || provider === 'agent') merged.provider = provider;
    else if (provider === 'anthropic') Object.assign(merged, { provider: 'api', api: 'anthropic' });
    else if (provider === 'claude-code') Object.assign(merged, { provider: 'agent', harness: 'claude-code' });
    // (and the offline demo is gone: the default)
    if (model && !rest.apiModels) merged.apiModels = { ...merged.apiModels, anthropic: model };
    if (claudeModel && !rest.harnessModels) merged.harnessModels = { 'claude-code': claudeModel };
    if (claudeWeb !== undefined && rest.agentWeb === undefined) merged.agentWeb = claudeWeb;
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  try {
    // plain data: the app's settings are a Svelte proxy, which IndexedDB cannot store
    await put('settings', 'settings', { ...(JSON.parse(JSON.stringify(s)) as Settings), version: SETTINGS_VERSION });
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
