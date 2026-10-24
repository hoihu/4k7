/// <reference lib="webworker" />
/**
 * Runs a transaction that asks the route helper (drawn copper: route nets / from, to) on a copy of
 * the working design, so the kernel worker stays responsive while it searches (up to half a
 * minute). It reports the copper laid so far a few times a second, the best result of the route op
 * running (what a stop keeps) and each route op's result; the main thread then applies the
 * transaction in the kernel with those results, which lays the same copper without routing again.
 * One transaction per worker; a stop ends the worker.
 */
import { Kernel } from '@4k7/kernel';
import type { Design, RouteHelperResult } from '@4k7/schema';

self.onmessage = (e: MessageEvent<{ design: Design; tx: unknown; by: 'user' | 'agent' }>) => {
  const { design, tx, by } = e.data;
  const results: Record<number, RouteHelperResult> = {};
  try {
    const r = new Kernel(design).transact(tx, by, {
      onProgress: (op, p) => self.postMessage({ progress: { op, pass: p.pass, connections: p.connections, done: p.done, bestOpen: p.bestOpen, elapsedMs: Math.round(p.elapsedMs), grid: p.grid, tracks: p.tracks, vias: p.vias } }),
      onBest: (op, result) => self.postMessage({ best: { op, result } }),
      onDone: (op, result) => {
        results[op] = result;
        self.postMessage({ done: { op, result } });
      },
    });
    // (refused: the route ops done before the refusal still count, the kernel refuses the same way)
    self.postMessage({ finished: { ok: r.status === 'ok', results } });
  } catch (err) {
    self.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};
