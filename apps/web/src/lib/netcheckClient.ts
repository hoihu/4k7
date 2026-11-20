/**
 * The netlist check of production files, in a worker of its own (netcheck.worker.ts) that stays
 * for the next check: the Gerber viewer checks its files after every change of the board, the
 * export checks what it writes, and the agent's view_gerbers waits for the result. One check runs
 * at a time; a check asked with a `latest` key replaces one of that key still waiting (the viewer's
 * files made again after another edit), so edits in a row do not queue up checks of old files.
 * The layout's checks give the board instead: the worker makes its files (checkBoard).
 */
import type { CopperCheck, NetDesign } from '@4k7/fab';
import type { BoardView } from '@4k7/schema';

type Ask = { files: { name: string; content: string }[]; design: NetDesign; fresh: boolean } | { board: BoardView };

interface Job {
  ask: Ask;
  latest?: string;
  resolve: (c: CopperCheck | null) => void;
  reject: (e: Error) => void;
}

let worker: Worker | null = null;
let running: Job | null = null;
const waiting: Job[] = [];

function start() {
  if (running || !waiting.length) return;
  const job = waiting.shift()!;
  running = job;
  if (!worker) {
    worker = new Worker(new URL('./netcheck.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ check?: CopperCheck | null; error?: string }>) => {
      const done = running;
      running = null;
      if (e.data.error !== undefined) done?.reject(new Error(e.data.error));
      else done?.resolve(e.data.check ?? null);
      start();
    };
    worker.onerror = (e) => {
      // (a worker that failed: this check fails, the next one starts a new worker)
      const done = running;
      running = null;
      worker?.terminate();
      worker = null;
      done?.reject(new Error(e.message || 'The netlist check failed.'));
      start();
    };
  }
  worker.postMessage(job.ask);
}

/** The files' copper against the design (`fresh`: the files were just made from it); null without copper layers. */
export function checkFiles(files: { name: string; content: string }[], design: NetDesign, fresh: boolean, latest?: string): Promise<CopperCheck | null> {
  return enqueue({ files, design, fresh }, latest);
}

/** The board's own files, made in the worker as the export makes them, against the board; a later ask replaces one still waiting. */
export function checkBoard(board: BoardView): Promise<CopperCheck | null> {
  return enqueue({ board }, 'board');
}

function enqueue(ask: Ask, latest?: string): Promise<CopperCheck | null> {
  return new Promise((resolve, reject) => {
    if (latest) {
      const i = waiting.findIndex((j) => j.latest === latest);
      if (i >= 0) waiting.splice(i, 1)[0]!.reject(new Error('replaced by a newer check'));
    }
    waiting.push({ ask, ...(latest ? { latest } : {}), resolve, reject });
    start();
  });
}
