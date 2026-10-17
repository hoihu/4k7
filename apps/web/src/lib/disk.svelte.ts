/**
 * Projects, imported parts, artwork and datasheets are kept on this computer by the local server
 * (tools/server/src/storage.ts), over HTTP with the access key. Nothing is saved without it.
 */
import { SERVER_PORTS, type ScadJob, type ScadRunResult, type ScadStatus } from '@4k7/schema';

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

  /* -------------------------- OpenSCAD (the enclosure) ------------------------ */

  /** OpenSCAD on this computer; `again`: look for it again (after installing it). Null: the server is older than the enclosure. */
  async scadStatus(again = false): Promise<ScadStatus | null> {
    const r = await this.#req('GET', `scad${again ? '?again=1' : ''}`);
    return r ? ((await r.json()) as ScadStatus) : null;
  }

  /** Render a job with the user's OpenSCAD (the server runs it). */
  async scadRender(job: ScadJob): Promise<ScadRunResult[]> {
    const r = await this.#req('POST', 'scad/render', JSON.stringify({ files: job.files, runs: job.runs }), { 'content-type': 'application/json' });
    if (!r) throw new DiskError('This 4k7 server cannot render enclosures yet: update it (restart the app).', 404);
    return (await r.json()) as ScadRunResult[];
  }

  /** Run this OpenSCAD from now on (an absolute path), or look for it again (null). */
  async scadSetBin(bin: string | null): Promise<{ ok: true; status: ScadStatus } | { ok: false; error: string }> {
    const r = await this.#req('POST', 'scad/bin', JSON.stringify({ bin }), { 'content-type': 'application/json' });
    if (!r) return { ok: false, error: 'This 4k7 server is older than the enclosure step: update it.' };
    return (await r.json()) as { ok: true; status: ScadStatus } | { ok: false; error: string };
  }
}

export const disk = new Disk();
