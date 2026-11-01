/**
 * Serves the built web app from the server's port, so `npx 4k7pcb` is the whole app: the page
 * and the server share an origin on 127.0.0.1 (no website reaching into the computer, which
 * browsers restrict). Static files only; designs are kept on this computer by storage.ts.
 *
 * The page itself is served only at /<access-key>, the key the tab then hands to the server: another
 * page or program on this computer that does not know it gets neither the app nor the server. The
 * build files (/assets/…) hold no secrets and are served to any local request.
 */
import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { SERVER_ACCESS_KEY, SERVER_PORTS } from '@4k7/schema';
import { DEV_APP } from './config.ts';
import type { HttpHandler } from './server.ts';
import { secretsMatch } from './mcp.ts';
import { LOCAL_HOST } from './storage.ts';

/** Answers on every server, so a second one can tell that a port already serves 4k7. */
export const PROBE_PATH = '/4k7-server.json';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
};


export function appHandler(dir: string | null, version: string, accessKey: string): HttpHandler {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (!LOCAL_HOST.test(req.headers.host ?? '')) {
      res.writeHead(421).end('wrong host');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    let path: string;
    try {
      path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (path === PROBE_PATH) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ name: '4k7-server', version }));
      return;
    }
    if (!dir) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('The app is not built yet. Run `npm run build` in the repository, then reload.');
      return;
    }
    const key = /^\/([^/]+)\/?$/.exec(path)?.[1] ?? '';
    const page = SERVER_ACCESS_KEY.test(key);
    if (page ? !secretsMatch(key, accessKey) : path === '/' || path === '/index.html') {
      res
        .writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' })
        .end(NO_KEY_PAGE);
      return;
    }
    const file = normalize(join(dir, page ? 'index.html' : path));
    if (file !== dir && !file.startsWith(dir.endsWith(sep) ? dir : dir + sep)) {
      res.writeHead(403).end();
      return;
    }
    let size: number;
    try {
      const st = statSync(file);
      if (!st.isFile()) throw new Error('not a file');
      size = st.size;
    } catch {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': size,
      // hashed build files never change; everything else is checked on every load
      'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : page ? 'no-store' : 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-frame-options': 'DENY',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
  };
}

const NO_KEY_PAGE = `<!doctype html><meta charset="utf-8"><title>4k7</title>
<body style="font:15px system-ui,sans-serif;max-width:34em;margin:4em auto;padding:0 1em;color:#ddd;background:#14161a">
<h1 style="font-size:20px">Open 4k7 with its link</h1>
<p>The app's address includes an access key: <code>http://localhost:7777/&lt;key&gt;</code>. Use the link the
<code>4k7pcb</code> command opened or printed (running it again opens it), or the one Claude Code gave you.</p>
<p style="color:#999">The key is also in <code>~/.4k7/server.json</code> (<code>"accessKey"</code>).</p>
</body>`;

/**
 * Whether a 4k7 server serves the app on this port (another one started first). With an access key: one
 * that takes it, so a link with this key works there (a server run from source has a key of its own).
 */
export async function serves4k7(port: number, accessKey?: string): Promise<boolean> {
  try {
    const signal = AbortSignal.timeout(800);
    const r = await fetch(`http://127.0.0.1:${port}${PROBE_PATH}`, { signal });
    if (!r.ok || ((await r.json()) as { name?: string }).name !== '4k7-server') return false;
    return !accessKey || (await fetch(`http://127.0.0.1:${port}/api/storage`, { headers: { authorization: `Bearer ${accessKey}` }, signal })).ok;
  } catch {
    return false;
  }
}

/** Whether something answers on this URL (the Vite dev server of a checkout). */
export async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(800) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Where app links point unless this server's own address will do (undefined). Settings (and the API keys) live in the
 * browser's storage per origin (host and port), so the installed app should always open at the same address:
 * http://localhost:7777, served by this server or by another one that started first and takes the same key.
 * Run from source, the links open the dev server (npm run dev) while it answers.
 */
export async function appUrl(opts: { port: number; accessKey: string; checkout: boolean; log: (msg: string) => void; home?: number; devApp?: string }): Promise<string | undefined> {
  const { port, home = SERVER_PORTS[0], devApp = DEV_APP } = opts;
  if (opts.checkout) return (await reachable(devApp)) ? devApp : undefined;
  if (port === home) return undefined;
  if (await serves4k7(home, opts.accessKey)) return `http://localhost:${home}`;
  opts.log(`note: port ${home} is used by another program, so the app opens at http://localhost:${port}; settings saved at another address do not show there`);
  return undefined;
}
