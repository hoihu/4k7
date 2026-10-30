/**
 * Renders an enclosure script on the Manifold engine (docs/design/enclosure.md §5.1, §8). The script
 * may have come with a design from someone else, so it runs on its own: a new worker per render,
 * started from a blob made of the script. A blob's worker takes this page's Content-Security-Policy,
 * so it cannot eval, import from elsewhere or connect anywhere but here (and the first thing it does,
 * before the script's first line, is to remove what connects and what stores, so not here either).
 * The WASM and the font come from this side, and a render that does not end is stopped.
 */
import { failedReport, scriptSource, type EnclosureFacts, type EnclosureFinding, type EnclosurePiece, type EnclosureReport, type PartSolids } from '@4k7/fab';
import { enclosureKey, scriptPieces, scriptProblems, type EnclosureBrief, type EnclosureGraphic } from '@4k7/schema';
import fontUrl from '@4k7/fab/fonts/LiberationSans-Bold.ttf?url';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import runtimeUrl from './enclosure.worker.ts?worker&url';

/** How long one render may take: well under the minute the server and the MCP clients wait for a tool, so the agent hears why. */
const RENDER_MS = 45_000;

/** Runs before anything of the script. No line of its own: the script's lines stay where scriptSource says. */
const LOCK_DOWN = `(function(){['fetch','XMLHttpRequest','WebSocket','WebSocketStream','EventSource','WebTransport','RTCPeerConnection','BroadcastChannel','Worker','SharedWorker','indexedDB','caches','cookieStore','importScripts','FileReaderSync'].forEach(function(n){for(var o=self;o;o=Object.getPrototypeOf(o)){try{delete o[n]}catch(e){}}})})();`;

/** After the script's function is defined (a syntax error never gets here): take the job, then load the engine, which does the rest. */
const bootstrap = (runtime: string) => `
self.onmessage=function(e){self.__enclosureJob=e.data;import(${JSON.stringify(runtime)}).catch(function(err){postMessage({fatal:String(err)})})};`;

let assets: Promise<{ wasm: ArrayBuffer; font: ArrayBuffer }> | null = null;
function loadAssets() {
  const get = async (url: string) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.arrayBuffer();
  };
  assets ??= Promise.all([get(wasmUrl), get(fontUrl)]).then(([wasm, font]) => ({ wasm, font }));
  assets.catch(() => (assets = null));
  return assets;
}

/** What came back, read as data: the script could have posted anything. */
function checked(r: unknown): { pieces: EnclosurePiece[]; findings: EnclosureFinding[]; size: EnclosureReport['size']; ms: number; log?: string[] } | null {
  const o = r as Partial<EnclosureReport> | null;
  const box = (b: unknown) => !!b && Array.isArray((b as EnclosurePiece['bbox']).min) && Array.isArray((b as EnclosurePiece['bbox']).max);
  if (!o || !Array.isArray(o.pieces) || !Array.isArray(o.findings)) return null;
  if (!o.pieces.every((p) => typeof p?.name === 'string' && p.tris instanceof Float32Array && box(p.bbox))) return null;
  if (!o.findings.every((f) => typeof f?.code === 'string' && typeof f.message === 'string' && (f.severity === 'error' || f.severity === 'warning'))) return null;
  return { pieces: o.pieces, findings: o.findings, size: o.size ?? null, ms: typeof o.ms === 'number' ? o.ms : 0, ...(Array.isArray(o.log) ? { log: o.log.map(String) } : {}) };
}

/** Render a script against the board's facts. Whatever goes wrong with the script is a report saying so. */
export async function renderScript(job: { facts: EnclosureFacts & { solids: PartSolids }; script: string; brief?: EnclosureBrief; graphics?: EnclosureGraphic[] }): Promise<EnclosureReport> {
  const { script } = job;
  const key = enclosureKey({ script, ...(job.graphics ? { graphics: job.graphics } : {}) });
  const fail = (message: string) => failedReport(script, key, message);
  const problems = scriptProblems(script);
  if (problems.length) return fail(`The script cannot run:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  const { wasm, font } = await loadAssets();

  const runtime = new URL(runtimeUrl, location.href).href;
  const source = `${LOCK_DOWN}${scriptSource(script, scriptPieces(script) ?? [])}${bootstrap(runtime)}`;
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const worker = new Worker(url);
  return new Promise<EnclosureReport>((resolve) => {
    const end = (r: EnclosureReport) => {
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve(r);
    };
    const timer = setTimeout(() => end(fail(`The script did not end in ${RENDER_MS / 1000} s: a loop that never stops, or more than one render can do (rounded or minkowski on a large solid, sdf with a fine edge).`)), RENDER_MS);
    worker.onmessage = (e: MessageEvent<{ report?: unknown; fatal?: unknown }>) => {
      const r = checked(e.data?.report);
      if (r) end({ ...r, script, key });
      else end(fail(`The render failed: ${String(e.data?.fatal ?? 'it sent back something that is not a report')}`));
    };
    worker.onerror = (e) => {
      e.preventDefault();
      // (a parse error passes scriptProblems only if the browser disagrees with it; Safari and Firefox do not say where)
      const line = e.lineno > 1 ? `line ${e.lineno - 1}: ` : '';
      end(fail(`The script stopped: ${line}${e.message || 'the browser could not run it'}`));
    };
    worker.postMessage({ job, wasm, font });
  });
}
