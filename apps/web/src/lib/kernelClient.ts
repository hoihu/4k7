import type { KernelPort } from '@4k7/agent';
import type { KernelMethods } from './kernel.worker.ts';

type Remote = { [K in keyof KernelMethods]: (...args: Parameters<KernelMethods[K]>) => Promise<ReturnType<KernelMethods[K]>> };

/** Promise-based proxy to the kernel worker. */
export function createKernel(): Remote & { port: KernelPort } {
  const worker = new Worker(new URL('./kernel.worker.ts', import.meta.url), { type: 'module' });
  let seq = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.error !== undefined) p.reject(new Error(e.data.error));
    else p.resolve(e.data.result);
  };
  // a worker that fails (an error outside a call) answers nothing more: fail what waits instead of hanging
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(`kernel worker failed: ${e.message || 'unknown error'}`));
    pending.clear();
  };
  const call = (method: string, args: unknown[]) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, args });
    });

  const remote = new Proxy({} as Remote & { port?: KernelPort }, {
    // own properties (the port below) first, everything else is an RPC method
    get: (t, method: string) => (method in t ? t[method as keyof typeof t] : method === 'then' ? undefined : (...args: unknown[]) => call(method, args)),
  });

  const port: KernelPort = {
    transact: (tx) => remote.transact(tx),
    query: (q) => remote.query(q),
    snapshot: async () => {
      const s = await remote.state();
      return { summary: s.summary, diagnostics: s.diagnostics, counts: s.counts, ledger: s.ledger };
    },
  };
  return Object.assign(remote, { port });
}
