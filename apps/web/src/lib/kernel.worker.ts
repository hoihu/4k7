/// <reference lib="webworker" />
/**
 * Hosts the design kernel off the main thread. Every call is a plain method name +
 * structured-cloneable arguments.
 */
import { Kernel, registerArtwork, unregisterArtwork } from '@4k7/kernel';
import type { ImportSources, QueryContext } from '@4k7/kernel';
import { registerUserParts, unregisterUserPart } from '@4k7/parts';
import type { Artwork, CheckSettings, Design, OptimizeScope, PartCard, RouteHelperResult, StoredCopper } from '@4k7/schema';

const kernel = new Kernel();

const methods = {
  /**
   * `by`: the user for the app's own edits (drags, buttons); the agent's tool calls leave it out.
   * `routed`: what the route helper found for the transaction's route ops on drawn copper, in the
   * helper worker (by op index): laid as found, without routing here. `sources`: the stored projects
   * the app read for the transaction's import_block and import_board ops.
   */
  transact: (tx: unknown, by?: 'user' | 'agent', routed?: Record<number, RouteHelperResult>, rev?: number, sources?: ImportSources) =>
    kernel.transact(tx, by, routed ? { results: routed, ...(rev !== undefined ? { rev } : {}) } : undefined, sources),
  /** The working copy with its revision (the route helper's worker routes it; transact refuses its results if it changed). */
  draftSnapshot: () => kernel.draftSnapshot(),
  /** `ctx`: what the app read for the query: the guides for get_guide, the stored projects for list_blocks. */
  query: (q: unknown, ctx?: QueryContext) => kernel.query(q, ctx),
  /** Every diagnostic, unpaged (get_diagnostics pages them): the app adds the production files' findings. */
  diagnostics: () => kernel.diagnostics(),
  state: () => kernel.state(),
  setScope: (s: OptimizeScope | null) => kernel.setScope(s),
  /** Which schematic checks run and how strictly (null = the shipped defaults). */
  setChecks: (checks: CheckSettings | null) => kernel.setChecks(checks),
  accept: (ids?: string[], by?: 'user' | 'agent', summary?: string) => kernel.accept(ids, by, summary),
  reject: () => kernel.reject(),
  undo: () => kernel.undo(),
  redo: () => kernel.redo(),
  load: (d: Design) => kernel.load(d),
  exportDesign: () => kernel.exportDesign(),
  rename: (name: string) => kernel.rename(name),
  /** The working copy, for the board worker. */
  draftDesign: () => kernel.draftDesign(),
  /** The working copy's board placed, not routed (fast): its parts, pads and sides, for what assembly costs. `board`: which (several boards). */
  boardPlacement: (board?: string) => kernel.boardPlacement(board),
  /** The working copy's bring-up sheet, for the design document. `board`: which (several boards). */
  bringUp: () => kernel.bringUp(),
  /** The working copy's cable and wire mates pin to pin, for the design document. */
  cableTable: () => kernel.cableTable(),
  /** Where every board stands (the assembly), first board first. */
  assembly: () => kernel.assembly(),
  /** Every board of the working copy placed, first board first. */
  boardPlacements: () => kernel.boardList().map((b) => kernel.boardPlacement(b.id)),
  /** The working copy's board `board` (as a design of its own) and its placement, for the board worker. */
  boardRequest: (board?: string) => kernel.boardRequest(board),
  /** Copper the board worker routed, kept with the design (true: the committed design took it, save it). */
  keepCopper: (copper: StoredCopper) => kernel.keepCopper(copper),
  /** The working copy's part cards (the design's own copies, e.g. with a footprint the agent gave). */
  designParts: () => kernel.draftParts(),
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
