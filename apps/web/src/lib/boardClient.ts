import type { BoardView, Design } from '@tracewise/schema';

export type BoardStage = 'placed' | 'routed';

/**
 * Board computations in their own worker. A new request while one is running terminates the
 * old worker: the result would be stale anyway, and routing a big board can take seconds.
 */
export class BoardClient {
  #worker: Worker | null = null;
  #busy = false;
  #seq = 0;
  #waiters: ((b: BoardView | null) => void)[] = [];

  /** `kept`: boards routed before; their copper stays where nothing it depends on has changed. */
  compute(design: Design, kept: BoardView[], onStage: (stage: BoardStage, board: BoardView) => void, onError: (msg: string) => void): void {
    if (this.#busy && this.#worker) {
      this.#worker.terminate();
      this.#worker = null;
    }
    this.#worker ??= new Worker(new URL('./board.worker.ts', import.meta.url), { type: 'module' });
    const id = ++this.#seq;
    this.#busy = true;
    this.#worker.onmessage = (e: MessageEvent<{ id: number; stage?: BoardStage; board?: BoardView; error?: string }>) => {
      if (e.data.id !== this.#seq) return;
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
    this.#worker.postMessage({ id, design, kept });
  }

  /** Answer with a board that needs no computing (a stored one); a running computation is dropped. */
  settle(board: BoardView) {
    if (this.#busy && this.#worker) {
      this.#worker.terminate();
      this.#worker = null;
    }
    this.#busy = false;
    this.#seq++;
    this.#flush(board);
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
