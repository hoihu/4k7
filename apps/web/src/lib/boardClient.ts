import type { BoardView, Design, StoredCopper, Track, Via } from '@4k7/schema';

export type BoardStage = 'placed' | 'routed';

/** Routing under way: the pass, how far it got, and the copper it has laid so far. */
export interface RouteProgress {
  pass: number;
  connections: number;
  done: number;
  /** Fewest connections a finished pass left open (null in the first pass). */
  bestOpen: number | null;
  elapsedMs: number;
  /** Routing on the grid: horizontal on top, vertical on the bottom, vias wherever they help. */
  grid: boolean;
  tracks: Track[];
  vias: Via[];
}

/**
 * Board computations in their own worker. A new request while one is running terminates the
 * old worker: the result would be stale anyway, and routing a big board can take seconds.
 */
export class BoardClient {
  #worker: Worker | null = null;
  #busy = false;
  #seq = 0;
  #waiters: ((b: BoardView | null) => void)[] = [];
  /** The running request's best routing so far (see stop). */
  #best: StoredCopper | null = null;

  compute(design: Design, onStage: (stage: BoardStage, board: BoardView) => void, onError: (msg: string) => void, onProgress?: (p: RouteProgress) => void): void {
    if (this.#busy && this.#worker) {
      this.#worker.terminate();
      this.#worker = null;
    }
    this.#worker ??= new Worker(new URL('./board.worker.ts', import.meta.url), { type: 'module' });
    const id = ++this.#seq;
    this.#busy = true;
    this.#best = null;
    this.#worker.onmessage = (e: MessageEvent<{ id: number; stage?: BoardStage; board?: BoardView; error?: string; progress?: RouteProgress; best?: StoredCopper }>) => {
      if (e.data.id !== this.#seq) return;
      if (e.data.best) {
        this.#best = e.data.best;
        return;
      }
      if (e.data.progress) {
        onProgress?.(e.data.progress);
        return;
      }
      if (e.data.error) {
        this.#busy = false;
        onError(e.data.error);
        this.#flush(null);
        return;
      }
      onStage(e.data.stage!, e.data.board!);
      if (e.data.stage === 'routed') {
        this.#busy = false;
        this.#flush(e.data.board!);
      }
    };
    this.#worker.postMessage({ id, design });
  }

  /**
   * Stop the routing under way: the worker is ended (a running route cannot be told to stop) and
   * the best result it had is returned, to be kept in the design. Null if nothing was routing.
   * Whoever waits for a board gets the next one computed.
   */
  stop(): StoredCopper | null {
    if (!this.#busy || !this.#worker) return null;
    this.#worker.terminate();
    this.#worker = null;
    this.#busy = false;
    const best = this.#best;
    this.#best = null;
    return best;
  }

  get busy() {
    return this.#busy;
  }

  /** The next routed board (or null on error). */
  next(): Promise<BoardView | null> {
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  #flush(b: BoardView | null) {
    for (const w of this.#waiters.splice(0)) w(b);
  }
}
