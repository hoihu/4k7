/// <reference lib="webworker" />
/**
 * The geometry side of one render. Loaded by the worker enclosureClient.ts starts for it, whose own
 * script is the enclosure script, wrapped and locked down: that one has left the script's function
 * and the job in its globals by now (docs/design/enclosure.md §5.1, §8).
 */
import { loadCsg, renderEnclosure, SCRIPT_GLOBAL, type EnclosureRenderJob } from '@4k7/fab/csg';

const g = globalThis as unknown as Record<string, unknown>;
const { job, wasm, font } = g.__enclosureJob as { job: EnclosureRenderJob; wasm: ArrayBuffer; font: ArrayBuffer };

void (async () => {
  try {
    const csg = await loadCsg({ wasm, font });
    const report = renderEnclosure(csg, job, g[SCRIPT_GLOBAL] as () => Record<string, unknown>, self.location.href);
    self.postMessage({ report }, report.pieces.map((p) => p.tris.buffer as ArrayBuffer));
  } catch (e) {
    self.postMessage({ fatal: e instanceof Error ? e.message : String(e) });
  }
})();
