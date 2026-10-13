/// <reference lib="webworker" />
/**
 * Computes the board (placement, then routing and DRC) off the kernel worker, so the design
 * kernel and the agent stay responsive while a big board routes. One request at a time; the
 * main thread replaces this worker when a newer design arrives. While it routes, it reports the
 * copper laid so far a few times a second, so the board can be watched filling in, and the best
 * result so far whenever a pass improves on it: what the user keeps if they stop the routing (the
 * main thread then ends this worker; a running route cannot be told to stop).
 */
import { Kernel } from '@4k7/kernel';
import type { Design } from '@4k7/schema';

self.onmessage = (e: MessageEvent<{ id: number; design: Design }>) => {
  const { id, design } = e.data;
  try {
    const k = new Kernel(design);
    self.postMessage({ id, stage: 'placed', board: k.boardPlacement() });
    const board = k.board({
      onProgress: (p) => self.postMessage({ id, progress: { pass: p.pass, connections: p.connections, done: p.done, bestOpen: p.bestOpen, elapsedMs: Math.round(p.elapsedMs), tracks: p.tracks, vias: p.vias } }),
      onBest: (best) => self.postMessage({ id, best }),
    });
    self.postMessage({ id, stage: 'routed', board });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
