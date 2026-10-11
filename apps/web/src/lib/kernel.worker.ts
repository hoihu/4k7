/// <reference lib="webworker" />
/**
 * Hosts the design kernel off the main thread. Every call is a plain method name +
 * structured-cloneable arguments; the Rust/WASM kernel will slot in behind the same RPC.
 */
import { Kernel, registerArtwork, unregisterArtwork } from '@4k7/kernel';
import { registerUserParts, unregisterUserPart } from '@4k7/parts';
import type { Artwork, Design, OptimizeScope, PartCard } from '@4k7/schema';

const kernel = new Kernel();

const methods = {
  transact: (tx: unknown) => kernel.transact(tx),
  query: (q: unknown) => kernel.query(q),
  state: () => kernel.state(),
  setScope: (s: OptimizeScope | null) => kernel.setScope(s),
  accept: (ids?: string[], by?: 'user' | 'agent', summary?: string) => kernel.accept(ids, by, summary),
  reject: () => kernel.reject(),
  undo: () => kernel.undo(),
  redo: () => kernel.redo(),
  load: (d: Design) => kernel.load(d),
  exportDesign: () => kernel.exportDesign(),
  rename: (name: string) => kernel.rename(name),
  hasPending: () => kernel.hasPending(),
  /** The working copy, for the board worker. */
  draftDesign: () => kernel.draftDesign(),
  /** The working copy's part cards (the design's own copies, e.g. with a footprint the agent gave). */
  designParts: () => kernel.draftDesign().parts,
  /** Imported parts, so the agent can find and place them. */
  registerParts: (cards: PartCard[]) => registerUserParts(cards),
  unregisterPart: (id: string) => unregisterUserPart(id),
  /** Saved artwork, so add_graphic can place it by name. */
  registerArtwork: (list: Artwork[]) => registerArtwork(list),
  unregisterArtwork: (id: string) => unregisterArtwork(id),
};

export type KernelMethods = typeof methods;

self.onmessage = (e: MessageEvent<{ id: number; method: keyof KernelMethods; args: unknown[] }>) => {
  const { id, method, args } = e.data;
  try {
    const fn = methods[method] as (...a: unknown[]) => unknown;
    const result = fn(...args);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) });
  }
};
