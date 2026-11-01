/**
 * Designs and libraries on this computer, served to the app's tab over HTTP under /api/.
 *
 * - Projects: one `<name>.twd.json` per project in a folder the user can see (~/Documents/4k7 by
 *   default), written as the design changes. The file's name is the project's id.
 * - Imported parts and artwork: one JSON file per record in ~/.4k7/library and ~/.4k7/artwork.
 * - Datasheets: ~/.4k7/datasheets/<sha256>.pdf with the file's original name (and link) next to it.
 * - Not files: the assembly houses' parts catalogues (/api/sourcing, see sourcing.ts).
 *
 * Every request needs the access key (`authorization: Bearer <key>`). Requests from a page carry
 * its origin, which must be one of the app's (the server's own pages, the dev server); a website
 * reaching into this computer gets nothing. Writes go to a temporary file renamed over the old
 * one, so a crash never leaves half a project.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { secretsMatch } from './mcp.ts';
import type { HttpHandler } from './server.ts';
import { download as fetchPdf, isPdf, MAX_PDF_BYTES, pdfName } from './download.ts';
import { partQuery, quoteRequest, type Sourcing } from './sourcing.ts';

export const PROJECT_EXT = '.twd.json';
const RECORD_STORES = ['library', 'artwork'] as const;
type RecordStore = (typeof RECORD_STORES)[number];
/** A design with its history, or a datasheet PDF. */
const MAX_BODY = 64 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
/** Host headers the server answers to (a page at another name that resolves here is a DNS-rebinding attempt). */
export const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export interface StorageOptions {
  accessKey: string;
  /** Where the projects are. */
  projectsDir: string;
  /** Where libraries and datasheets are (~/.4k7). */
  dataDir: string;
  /** Whether a page at this origin may use the storage. */
  allowedOrigin: (origin: string) => boolean;
  /** Show a folder in the file manager. */
  reveal?: (dir: string) => void;
  /** Parts catalogues of assembly houses (/api/sourcing). */
  sourcing?: Sourcing;
  log?: (msg: string) => void;
  /** Downloads a datasheet link (tests replace it). */
  download?: (url: string) => Promise<Uint8Array>;
}

/** ~/Documents/4k7 where there is a Documents folder, else ~/4k7. FOURK7_PROJECTS or "projectsDir" in server.json override it. */
export function defaultProjectsDir(name = '4k7'): string {
  const docs = join(homedir(), 'Documents');
  return join(existsSync(docs) ? docs : homedir(), name);
}

export interface ProjectEntry {
  id: string;
  /** Last written, ms since epoch. */
  modified: number;
  size: number;
}

/** Names Windows keeps for devices, whatever the extension: a file cannot be called that there. */
const isDeviceName = (name: string) => process.platform === 'win32' && /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name);

/** A file name for a project called `name` (no path characters, not hidden). */
export function projectFileName(name: string): string {
  const clean = name
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 80)
    .trim();
  return isDeviceName(clean) ? `${clean}-` : clean || 'untitled';
}

/** A file name for a library or artwork record; only its id is read from it, nothing needs to turn it back. */
function recordFileName(id: string): string {
  const name = encodeURIComponent(id);
  if (process.platform !== 'win32') return name;
  return (isDeviceName(name) ? `%${name.charCodeAt(0).toString(16)}${name.slice(1)}` : name).replace(/\*/g, '%2A');
}

/** A project id as it may come in a URL: a file name without its extension, nothing that leaves the folder. */
function validProjectId(id: string): boolean {
  return id.length > 0 && id.length <= 120 && projectFileName(id) === id;
}

export function storageHandler(opts: StorageOptions): HttpHandler {
  const { projectsDir, dataDir } = opts;
  const projectPath = (id: string) => join(projectsDir, id + PROJECT_EXT);
  const recordDir = (store: RecordStore) => join(dataDir, store);
  const recordPath = (store: RecordStore, id: string) => join(recordDir(store), `${recordFileName(id)}.json`);
  const sheetDir = join(dataDir, 'datasheets');

  /** An id not taken yet: "name", "name 2", "name 3"… */
  const freeId = (name: string, except?: string) => {
    const base = projectFileName(name);
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base} ${n}`;
      if (id === except || !existsSync(projectPath(id))) return id;
    }
  };

  const listProjects = (): ProjectEntry[] => {
    if (!existsSync(projectsDir)) return [];
    const out: ProjectEntry[] = [];
    for (const f of readdirSync(projectsDir)) {
      if (!f.endsWith(PROJECT_EXT) || f.startsWith('.')) continue;
      try {
        const st = statSync(join(projectsDir, f));
        if (st.isFile()) out.push({ id: f.slice(0, -PROJECT_EXT.length), modified: st.mtimeMs, size: st.size });
      } catch {
        // went away while listing
      }
    }
    return out.sort((a, b) => b.modified - a.modified);
  };

  const readRecords = (store: RecordStore): unknown[] => {
    const dir = recordDir(store);
    if (!existsSync(dir)) return [];
    const out: unknown[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      try {
        out.push(JSON.parse(readFileSync(join(dir, f), 'utf8')));
      } catch (e) {
        opts.log?.(`skipped ${store}/${f}: ${(e as Error).message}`);
      }
    }
    return out;
  };

  /** What is kept next to a datasheet: its original name, and the link it was downloaded from. */
  const sheetMeta = (hash: string): { name?: string; url?: string } | undefined => {
    try {
      return JSON.parse(readFileSync(join(sheetDir, `${hash}.json`), 'utf8')) as { name?: string; url?: string };
    } catch {
      return undefined;
    }
  };

  /** The datasheet already downloaded from `url`. */
  const sheetForUrl = (url: string): { hash: string; name: string } | undefined => {
    if (!existsSync(sheetDir)) return undefined;
    for (const f of readdirSync(sheetDir)) {
      const hash = f.slice(0, -'.json'.length);
      if (!f.endsWith('.json') || !HASH.test(hash)) continue;
      const meta = sheetMeta(hash);
      if (meta?.url === url && existsSync(join(sheetDir, `${hash}.pdf`))) return { hash, name: meta.name ?? `${hash}.pdf` };
    }
    return undefined;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<unknown> => {
    const origin = req.headers.origin;
    if (!LOCAL_HOST.test(req.headers.host ?? '') || (origin && !opts.allowedOrigin(origin))) {
      res.writeHead(403).end();
      return;
    }
    if (origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-expose-headers', 'x-name');
    }
    if (req.method === 'OPTIONS') {
      res
        .writeHead(204, {
          'access-control-allow-methods': 'GET, PUT, POST, DELETE',
          'access-control-allow-headers': 'authorization, content-type, x-name',
          'access-control-max-age': '600',
        })
        .end();
      return;
    }
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    if (!secretsMatch(auth, opts.accessKey)) {
      res.writeHead(401).end();
      return;
    }
    res.setHeader('cache-control', 'no-store');

    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').slice(2).map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return '\u0000'; // never a valid id
      }
    });
    const [kind, id, action] = parts;
    const m = req.method;
    const json = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    const notFound = () => res.writeHead(404).end();

    try {
      if (kind === 'storage' && m === 'GET' && id === undefined) return json(200, { projectsDir, dataDir });

      if (kind === 'reveal' && m === 'POST' && id === undefined) {
        mkdirSync(projectsDir, { recursive: true });
        opts.reveal?.(projectsDir);
        return res.writeHead(204).end();
      }


      // a house's parts catalogue: POST sourcing/<house>/search (a PartQuery), GET sourcing/<house>/part/<number>;
      // its assembly quote: POST sourcing/<house>/quote (a QuoteOrder); a part's land: GET sourcing/<house>/footprint/<number>
      if (kind === 'sourcing' && opts.sourcing) {
        const house = id ?? '';
        if (!opts.sourcing.houses.includes(house)) return notFound();
        if (action === 'search' && parts.length === 3 && m === 'POST') {
          const q = partQuery(JSON.parse((await readBody(req)).toString('utf8')));
          return json(200, { parts: await opts.sourcing.search(house, q) });
        }
        if (action === 'part' && parts.length === 4 && parts[3] && m === 'GET') return json(200, { part: await opts.sourcing.lookup(house, parts[3]) });
        if (action === 'footprint' && parts.length === 4 && parts[3] && m === 'GET') return json(200, { footprint: await opts.sourcing.footprint(house, parts[3]) });
        if (action === 'quote' && parts.length === 3 && m === 'POST') {
          const order = quoteRequest(JSON.parse((await readBody(req)).toString('utf8')));
          return json(200, { quote: await opts.sourcing.quote(house, order) });
        }
        return res.writeHead(405).end();
      }

      if (kind === 'projects') {
        if (id === undefined) {
          if (m === 'GET') return json(200, listProjects());
          // a new project: named after ?name= or the design's own name
          if (m === 'POST') {
            const body = (await readBody(req)).toString('utf8');
            const newId = freeId(url.searchParams.get('name') || designName(body));
            writeAtomic(projectPath(newId), body);
            return json(201, { id: newId });
          }
        } else if (validProjectId(id)) {
          const file = projectPath(id);
          if (action === undefined) {
            if (m === 'GET') return existsSync(file) ? res.writeHead(200, { 'content-type': 'application/json' }).end(readFileSync(file)) : notFound();
            if (m === 'PUT') {
              writeAtomic(file, await readBody(req));
              return res.writeHead(204).end();
            }
          }
          if (action === 'rename' && m === 'POST') {
            if (!existsSync(file)) return notFound();
            const { name } = JSON.parse((await readBody(req)).toString('utf8')) as { name?: string };
            const to = freeId(name ?? id, id);
            if (to !== id) renameRetrying(file, projectPath(to));
            return json(200, { id: to });
          }
        }
        return id !== undefined && !validProjectId(id) ? res.writeHead(400).end('bad project name') : res.writeHead(405).end();
      }

      if (kind === 'records' && (RECORD_STORES as readonly string[]).includes(id ?? '')) {
        const store = id as RecordStore;
        const recId = action;
        if (recId === undefined) return m === 'GET' ? json(200, readRecords(store)) : res.writeHead(405).end();
        if (!recId || parts.length > 3) return res.writeHead(400).end();
        const file = recordPath(store, recId);
        if (m === 'GET') return existsSync(file) ? res.writeHead(200, { 'content-type': 'application/json' }).end(readFileSync(file)) : notFound();
        if (m === 'PUT') {
          const body = await readBody(req);
          JSON.parse(body.toString('utf8')); // records are read back as JSON: refuse anything else
          if (url.searchParams.has('ifAbsent') && existsSync(file)) return res.writeHead(204).end();
          writeAtomic(file, body);
          return res.writeHead(204).end();
        }
        if (m === 'DELETE') {
          rmSync(file, { force: true });
          return res.writeHead(204).end();
        }
        return res.writeHead(405).end();
      }

      // the datasheet behind a link (a library part that came with one, a project from another computer):
      // downloaded once, then kept like an imported one
      if (kind === 'datasheets' && id === 'fetch' && action === undefined && m === 'POST') {
        const { url } = JSON.parse((await readBody(req)).toString('utf8')) as { url?: unknown };
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return res.writeHead(400).end('an http(s) link is needed');
        const known = sheetForUrl(url);
        if (known) return json(200, known);
        const data = await (opts.download ?? fetchPdf)(url);
        if (data.byteLength > MAX_PDF_BYTES) return res.writeHead(422).end(`the PDF is larger than ${MAX_PDF_BYTES >> 20} MB`);
        if (!isPdf(data)) return res.writeHead(422).end('the link does not lead to a PDF file');
        const hash = createHash('sha256').update(data).digest('hex');
        const meta = sheetMeta(hash);
        const name = meta?.name ?? pdfName(url);
        if (!existsSync(join(sheetDir, `${hash}.pdf`))) writeAtomic(join(sheetDir, `${hash}.pdf`), Buffer.from(data));
        writeAtomic(join(sheetDir, `${hash}.json`), JSON.stringify({ ...meta, name, url }));
        return json(200, { hash, name });
      }

      if (kind === 'datasheets' && id && HASH.test(id) && action === undefined) {
        const pdf = join(sheetDir, `${id}.pdf`);
        const meta = join(sheetDir, `${id}.json`);
        if (m === 'GET') {
          if (!existsSync(pdf)) return notFound();
          let name = `${id}.pdf`;
          try {
            name = (JSON.parse(readFileSync(meta, 'utf8')) as { name?: string }).name ?? name;
          } catch {
            // the name is a nicety
          }
          return res.writeHead(200, { 'content-type': 'application/pdf', 'x-name': encodeURIComponent(name) }).end(readFileSync(pdf));
        }
        if (m === 'PUT') {
          const body = await readBody(req);
          if (url.searchParams.has('ifAbsent') && existsSync(pdf)) return res.writeHead(204).end();
          let name = `${id}.pdf`;
          try {
            name = decodeURIComponent(String(req.headers['x-name'] ?? '')) || name;
          } catch {
            // keep the hash as its name
          }
          writeAtomic(pdf, body);
          writeAtomic(meta, JSON.stringify({ ...sheetMeta(id), name }));
          return res.writeHead(204).end();
        }
        if (m === 'DELETE') {
          rmSync(pdf, { force: true });
          rmSync(meta, { force: true });
          return res.writeHead(204).end();
        }
        return res.writeHead(405).end();
      }

      return notFound();
    } catch (e) {
      const err = e as Error & { status?: number };
      opts.log?.(`storage ${m} ${url.pathname}: ${err.message}`);
      if (!res.headersSent) res.writeHead(err.status ?? (e instanceof SyntaxError ? 400 : 500), { 'content-type': 'text/plain; charset=utf-8' }).end(err.message);
    }
  };
  return async (req, res) => {
    await handle(req, res);
  };
}

/** The design's name, for the file of a new project. */
function designName(body: string): string {
  try {
    const name = (JSON.parse(body) as { name?: unknown }).name;
    return typeof name === 'string' ? name : 'untitled';
  } catch {
    return 'untitled';
  }
}

function writeAtomic(file: string, data: string | Buffer) {
  const dir = join(file, '..');
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmp, data);
  try {
    renameRetrying(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Windows refuses to rename over a file that something has open for a moment (the virus scanner, the search
 * indexer, a sync client): wait and try again. Blocking, so that an older save can never land after a newer one.
 */
export function renameRetrying(from: string, to: string, rename: (from: string, to: string) => void = renameSync, platform = process.platform): void {
  for (let wait = 50; ; wait *= 2) {
    try {
      return rename(from, to);
    } catch (e) {
      if (platform !== 'win32' || wait > 1600 || !['EPERM', 'EACCES', 'EBUSY'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
