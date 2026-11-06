/**
 * In development the page asks Vite for the access key of the local server that `npm run dev`
 * started (scripts/dev.sh), so http://localhost:5173 connects without the link the server prints: a
 * key the tab saved from an earlier link can be another server's, and a new browser profile has
 * none. The key is the one that server takes (tools/server/src/config.ts): FOURK7_ACCESS_KEY, else
 * server.json in FOURK7_HOME or ~/.4k7-dev. Only this origin's own page gets it: a request from
 * another site, another port on localhost, or under another host name (DNS rebinding) is refused.
 */
import { readFileSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite';

/** Where the page asks (apps/web/src/lib/app.svelte.ts). */
export const DEV_ACCESS_KEY_PATH = '/__4k7/access-key';

/** SERVER_ACCESS_KEY of @4k7/schema: the server ignores a FOURK7_ACCESS_KEY of another form. */
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCAL = ['localhost', '127.0.0.1', '[::1]'];

/** The answer to a request for the key. */
export function devAccessKeyAnswer(headers: IncomingHttpHeaders, env: Record<string, string | undefined> = process.env): { status: number; body: string } {
  const host = (headers.host ?? '').replace(/:\d+$/, '');
  if (headers['sec-fetch-site'] !== 'same-origin' || !LOCAL.includes(host)) return { status: 403, body: '' };
  let accessKey = env.FOURK7_ACCESS_KEY && KEY.test(env.FOURK7_ACCESS_KEY) ? env.FOURK7_ACCESS_KEY : null;
  if (!accessKey) {
    try {
      const saved = (JSON.parse(readFileSync(join(env.FOURK7_HOME || join(homedir(), '.4k7-dev'), 'server.json'), 'utf8')) as { accessKey?: unknown }).accessKey;
      if (typeof saved === 'string' && KEY.test(saved)) accessKey = saved;
    } catch {
      // no server has run from a checkout yet
    }
  }
  return { status: 200, body: JSON.stringify({ accessKey }) };
}

export function devAccessKey(): Plugin {
  return {
    name: '4k7-dev-access-key',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(DEV_ACCESS_KEY_PATH, (req, res) => {
        const { status, body } = devAccessKeyAnswer(req.headers);
        res.statusCode = status;
        res.setHeader('cache-control', 'no-store');
        if (body) res.setHeader('content-type', 'application/json');
        res.end(body);
      });
    },
  };
}
