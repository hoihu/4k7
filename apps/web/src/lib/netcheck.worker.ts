/// <reference lib="webworker" />
/**
 * The netlist check of production files (@4k7/fab netcheck.ts) off the main thread: the files read
 * back, their copper drawn on a fine grid and held against the design, or against the netlist that
 * came with them. It takes about half a second on a 110 × 150 mm board of four layers.
 */
import { checkFabSet, readFabFiles, type NetDesign } from '@4k7/fab';

self.onmessage = (e: MessageEvent<{ files: { name: string; content: string }[]; design: NetDesign; fresh: boolean }>) => {
  const { files, design, fresh } = e.data;
  try {
    self.postMessage({ check: checkFabSet(readFabFiles(files), design, { fresh }) });
  } catch (err) {
    self.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};
