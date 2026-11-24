/**
 * Persistence in this browser's IndexedDB: settings and the API keys. Projects, imported parts,
 * artwork and datasheets are files on this computer (files.ts, disk.svelte.ts). The
 * API key is encrypted with a non-extractable AES-GCM key that never leaves this browser profile.
 */
import type { ApiServiceId } from '@4k7/agent';
import type { SchematicThemeId } from './schematicThemes.ts';
import type { AgentEffort, Artwork, CheckSettings, HarnessId, PartCard } from '@4k7/schema';

const DB = '4k7';
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
    req.onblocked = () => {
      clearTimeout(timer);
      storageHealth = 'IndexedDB blocked by another tab';
      reject(new Error(storageHealth));
    };
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
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
  /** The schematic canvas's colours (schematicThemes.ts); 'app' = the app's light or dark. */
  schematicTheme: SchematicThemeId;
  /** The local server's access key and port, remembered so the tab reconnects by itself. */
  serverAccessKey: string;
  serverPort: number | null;
  /** The project open last (its file's name in the projects folder); '' = the newest. */
  project: string;
  /** The projects opened last, most recent first (recentProjects.ts). */
  recentProjects: string[];
  /** The user's notes on how they want schematics drawn, sent to the agent with every request; '' = none. */
  schematicNotes: string;
  /** The user's levels and limits for the drawing checks (SCH.*), only where they differ from the shipped ones. */
  schematicChecks: CheckSettings;
  /** The user's notes on how they want boards laid out (placement, planes, routing), sent to the agent with every request; '' = none. */
  layoutNotes: string;
  /** The user's notes for enclosures (printer, material, fasteners, fits), sent to the agent with every request; '' = none. */
  enclosureNotes: string;
  /** How many boards the stock check counts the parts for. */
  buildBoards: number;
  /** The assembly house the checks run for (its id, "jlcpcb"); '' = the board's manufacturer when it assembles, else the default. */
  assemblyHouse: string;
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
  schematicTheme: 'app',
  serverAccessKey: '',
  serverPort: null,
  project: '',
  recentProjects: [],
  schematicNotes: '',
  schematicChecks: {},
  layoutNotes: '',
  enclosureNotes: '',
  buildBoards: 10,
  assemblyHouse: '',
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
  version?: number;
}

export async function loadSettings(): Promise<Settings> {
  try {
    const saved = (await get<Partial<Settings> & OldSettings>('settings', 'settings')) ?? {};
    // older versions: the 6-digit pairing code and the port of the "bridge" (now the local server);
    // one provider each ("anthropic", "claude-code") before APIs and agents became choices
    const { bridgeCode: _code, bridgePort: _port, model, claudeModel, claudeWeb, provider, ...rest } = saved;
    const merged: Settings = { ...DEFAULT_SETTINGS, ...rest };
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
