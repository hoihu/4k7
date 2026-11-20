/// <reference lib="webworker" />
/**
 * The netlist check of production files (@4k7/fab netcheck.ts) off the main thread: the files read
 * back, their copper drawn on a fine grid and held against the design, or against the netlist that
 * came with them. It takes about half a second on a 110 × 150 mm board of four layers. Given a board,
 * it makes the board's files itself first (the layout's checks, fabFindings.ts).
 */
import { checkBoardFiles, checkFabSet, readFabFiles, type NetDesign } from '@4k7/fab';
import type { BoardView } from '@4k7/schema';

type Ask = { files: { name: string; content: string }[]; design: NetDesign; fresh: boolean } | { board: BoardView };

self.onmessage = (e: MessageEvent<Ask>) => {
  const ask = e.data;
  try {
    self.postMessage({ check: 'board' in ask ? checkBoardFiles(ask.board) : checkFabSet(readFabFiles(ask.files), ask.design, { fresh: ask.fresh }) });
  } catch (err) {
    self.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};
