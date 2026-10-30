/**
 * Projects, imported parts, artwork and datasheets are kept on this computer by the local server
 * (tools/server/src/storage.ts), over HTTP with the access key. Nothing is saved without it.
 */
import { SERVER_PORTS, type HouseFootprint, type PartQuery, type SupplierPart } from '@4k7/schema';
import type { AssemblyQuote, QuoteOrder } from '@4k7/parts';

export type DiskStatus = 'off' | 'connecting' | 'ok' | 'unreachable';

/** A project file in the projects folder; `id` is its name without .twd.json. */
export interface ProjectEntry {
  id: string;
  modified: number;
  size: number;
}

export class DiskError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

class Disk {
  status = $state<DiskStatus>('off');
  /** Where the server keeps the projects. */
  projectsDir = $state('');
  /** Where a project's file is, for showing: the folder comes from the server, with its computer's separators. */
  projectFile(id: string): string {
    return `${this.projectsDir}${this.projectsDir.includes('\\') ? '\\' : '/'}${id}.twd.json`;
  }
  #base = '';
  #key = '';

  /**
   * Find the server that keeps the files: the one serving this page, else the one on `preferPort`,
   * else any server port. False when none answers with this access key.
   */
  async find(accessKey: string, opts: { sameOrigin: boolean; preferPort?: number | null }): Promise<boolean> {
    this.#key = accessKey;
    if (!accessKey) {
      this.status = 'unreachable';
      return false;
    }
    if (this.status !== 'ok') this.status = 'connecting';
    const ports = opts.preferPort ? [opts.preferPort, ...SERVER_PORTS.filter((p) => p !== opts.preferPort)] : [...SERVER_PORTS];
    const bases = [...(opts.sameOrigin ? [location.origin] : []), ...ports.map((p) => `http://127.0.0.1:${p}`)];
    for (const base of bases) {
      try {
        const r = await fetch(`${base}/api/storage`, { headers: this.#headers(), signal: AbortSignal.timeout(1500) });
        // the dev server answers every path with the page: only the 4k7 server answers with JSON
        if (!r.ok || !r.headers.get('content-type')?.includes('json')) continue;
        const info = (await r.json()) as { projectsDir?: string };
        if (typeof info.projectsDir !== 'string') continue;
        this.#base = base;
        this.projectsDir = info.projectsDir;
        this.status = 'ok';
        return true;
      } catch {
        // nothing there
      }
    }
    this.status = 'unreachable';
    return false;
  }

  #headers(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${this.#key}`, ...extra };
  }

  /** A request to the storage; a 404 resolves to null, any other failure throws (and marks the server unreachable when it did not answer). */
  async #req(method: string, path: string, body?: BodyInit, headers?: Record<string, string>): Promise<Response | null> {
    if (this.status !== 'ok') throw new DiskError('The 4k7 server is not reachable', 0);
    let r: Response;
    try {
      r = await fetch(`${this.#base}/api/${path}`, { method, body, headers: this.#headers(headers) });
    } catch {
      this.status = 'unreachable';
      throw new DiskError('The 4k7 server is not reachable', 0);
    }
    if (r.status === 404) return null;
    if (!r.ok) throw new DiskError((await r.text().catch(() => '')) || `${method} ${path}: HTTP ${r.status}`, r.status);
    return r;
  }

  /* -------------------------------- projects ------------------------------- */

  async listProjects(): Promise<ProjectEntry[]> {
    return ((await (await this.#req('GET', 'projects'))?.json()) as ProjectEntry[] | undefined) ?? [];
  }

  /** The project's file as text, or undefined when there is none. */
  async loadProject(id: string): Promise<string | undefined> {
    return (await (await this.#req('GET', `projects/${encodeURIComponent(id)}`))?.text()) ?? undefined;
  }

  async saveProject(id: string, json: string): Promise<void> {
    await this.#req('PUT', `projects/${encodeURIComponent(id)}`, json, { 'content-type': 'application/json' });
  }

  /** A new project file, named after `name` or the design's name (with a number when taken); its id. */
  async createProject(json: string, name?: string): Promise<string> {
    const r = await this.#req('POST', `projects${name ? `?name=${encodeURIComponent(name)}` : ''}`, json, { 'content-type': 'application/json' });
    return ((await r!.json()) as { id: string }).id;
  }

  /** Rename a project's file after its new name; its new id. */
  async renameProject(id: string, name: string): Promise<string> {
    const r = await this.#req('POST', `projects/${encodeURIComponent(id)}/rename`, JSON.stringify({ name }), { 'content-type': 'application/json' });
    return r ? ((await r.json()) as { id: string }).id : id;
  }

  /** Open the projects folder in the file manager. */
  async reveal(): Promise<void> {
    await this.#req('POST', 'reveal');
  }

  /* --------------------------- libraries, datasheets ------------------------- */

  async records<T>(store: 'library' | 'artwork'): Promise<T[]> {
    return ((await (await this.#req('GET', `records/${store}`))?.json()) as T[] | undefined) ?? [];
  }

  async record<T>(store: 'library' | 'artwork', id: string): Promise<T | undefined> {
    return ((await (await this.#req('GET', `records/${store}/${encodeURIComponent(id)}`))?.json()) as T | undefined) ?? undefined;
  }

  /** `ifAbsent`: leave a record that is already there as it is. */
  async putRecord(store: 'library' | 'artwork', id: string, value: unknown, ifAbsent = false): Promise<void> {
    await this.#req('PUT', `records/${store}/${encodeURIComponent(id)}${ifAbsent ? '?ifAbsent=1' : ''}`, JSON.stringify(value), { 'content-type': 'application/json' });
  }

  async deleteRecord(store: 'library' | 'artwork', id: string): Promise<void> {
    await this.#req('DELETE', `records/${store}/${encodeURIComponent(id)}`);
  }

  async datasheet(hash: string): Promise<{ name: string; data: ArrayBuffer } | undefined> {
    const r = await this.#req('GET', `datasheets/${hash}`);
    if (!r) return undefined;
    return { name: decodeURIComponent(r.headers.get('x-name') ?? `${hash}.pdf`), data: await r.arrayBuffer() };
  }

  async putDatasheet(hash: string, sheet: { name: string; data: ArrayBuffer }, ifAbsent = false): Promise<void> {
    await this.#req('PUT', `datasheets/${hash}${ifAbsent ? '?ifAbsent=1' : ''}`, sheet.data, { 'content-type': 'application/pdf', 'x-name': encodeURIComponent(sheet.name) });
  }

  /** Have the server download the datasheet behind a link and keep it (once per link). Null: an older server. */
  async fetchDatasheet(url: string): Promise<{ hash: string; name: string } | null> {
    const r = await this.#req('POST', 'datasheets/fetch', JSON.stringify({ url }), { 'content-type': 'application/json' });
    return r ? ((await r.json()) as { hash: string; name: string }) : null;
  }

  async deleteDatasheet(hash: string): Promise<void> {
    await this.#req('DELETE', `datasheets/${hash}`);
  }

  /* ------------------------ parts catalogues (sourcing) ------------------------ */

  /** Search an assembly house's own catalogue, read by the server. Null: the server has no catalogue for it (an older server). */
  async sourcingSearch(house: string, q: PartQuery): Promise<SupplierPart[] | null> {
    const r = await this.#req('POST', `sourcing/${encodeURIComponent(house)}/search`, JSON.stringify(q), { 'content-type': 'application/json' });
    return r ? ((await r.json()) as { parts: SupplierPart[] }).parts : null;
  }

  /** One part of an assembly house's catalogue (null inside: not listed). Null: the server has no catalogue for the house. */
  async sourcingLookup(house: string, sku: string): Promise<{ part: SupplierPart | null } | null> {
    const r = await this.#req('GET', `sourcing/${encodeURIComponent(house)}/part/${encodeURIComponent(sku)}`);
    return r ? ((await r.json()) as { part: SupplierPart | null }) : null;
  }

  /** The house's footprint for one of its parts (null inside: it has none). Null: the server cannot read the house's footprints (an older server). */
  async sourcingFootprint(house: string, sku: string): Promise<{ footprint: HouseFootprint | null } | null> {
    const r = await this.#req('GET', `sourcing/${encodeURIComponent(house)}/footprint/${encodeURIComponent(sku)}`);
    return r ? ((await r.json()) as { footprint: HouseFootprint | null }) : null;
  }

  /** An assembly house's online quote for an order (PCBWay), read by the server. Null: the server cannot ask it (an older server). */
  async sourcingQuote(house: string, order: QuoteOrder): Promise<AssemblyQuote | null> {
    const r = await this.#req('POST', `sourcing/${encodeURIComponent(house)}/quote`, JSON.stringify(order), { 'content-type': 'application/json' });
    return r ? ((await r.json()) as { quote: AssemblyQuote }).quote : null;
  }
}

export const disk = new Disk();
