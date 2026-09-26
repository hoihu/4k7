/// <reference lib="webworker" />
/**
 * Hosts the design kernel off the main thread. Every call is a plain method name +
 * structured-cloneable arguments; the Rust/WASM kernel will slot in behind the same RPC.
 */
import { Kernel } from '@tracewise/kernel';
import { registerUserParts, unregisterUserPart } from '@tracewise/parts';
import type { Design, PartCard } from '@tracewise/schema';

const kernel = new Kernel();

const methods = {
  transact: (tx: unknown) => kernel.transact(tx),
  query: (q: unknown) => kernel.query(q),
  state: () => kernel.state(),
  accept: (ids?: string[], by?: 'user' | 'agent', summary?: string) => kernel.accept(ids, by, summary),
  reject: () => kernel.reject(),
  undo: () => kernel.undo(),
  load: (d: Design) => kernel.load(d),
  exportDesign: () => kernel.exportDesign(),
  rename: (name: string) => kernel.rename(name),
  hasPending: () => kernel.hasPending(),
  /** Placement, routing and DRC of the working copy (computed on demand). */
  board: () => kernel.board(),
  /** Imported parts, so the agent can find and place them. */
  registerParts: (cards: PartCard[]) => registerUserParts(cards),
  unregisterPart: (id: string) => unregisterUserPart(id),
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
