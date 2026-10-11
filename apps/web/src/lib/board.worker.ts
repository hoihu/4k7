/// <reference lib="webworker" />
/**
 * Computes the board (placement, then routing and DRC) off the kernel worker, so the design
 * kernel and the agent stay responsive while a big board routes. One request at a time; the
 * main thread replaces this worker when a newer design arrives.
 */
import { Kernel } from '@4k7/kernel';
import type { Design } from '@4k7/schema';

self.onmessage = (e: MessageEvent<{ id: number; design: Design }>) => {
  const { id, design } = e.data;
  try {
    const k = new Kernel(design);
    self.postMessage({ id, stage: 'placed', board: k.boardPlacement() });
    self.postMessage({ id, stage: 'routed', board: k.board() });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
