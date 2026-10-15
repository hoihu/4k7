/// <reference lib="webworker" />
/**
 * Runs try_placements (the agent comparing arrangements, each placed and maybe trial-routed for a
 * few seconds) on a copy of the working design, so the kernel worker stays responsive meanwhile.
 * One query per worker; the main thread ends it after the answer.
 */
import { Kernel } from '@4k7/kernel';
import type { Design } from '@4k7/schema';

self.onmessage = (e: MessageEvent<{ design: Design; query: unknown }>) => {
  try {
    self.postMessage({ result: new Kernel(e.data.design).query(e.data.query) });
  } catch (err) {
    self.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};
