/**
 * The solved board, kept with the design. Placement, routing and the pour are computed by code
 * that keeps improving, so a later version would lay the same design out differently. A design
 * therefore carries the board as it was solved: while the design is unchanged the stored board
 * is shown as it is, and only a change to the design solves it afresh.
 *
 * The stored board names the design it belongs to by a key over the design's canonical JSON.
 * Old files depend on that key: `canonicalJson` and `designKey` must keep giving the same
 * result for the same design (test/solved.test.ts holds a file written by solver 1).
 */
import type { BoardView, Design, SolvedBoard } from '@tracewise/schema';
import { canonicalJson, contentKey } from './canonical.ts';

/**
 * Counts the changes to what the placer, the router or the footprint generators produce.
 * Raise it with every such change (the golden test fails until then); boards stored by another
 * solver are shown as saved.
 */
export const SOLVER_VERSION = 1;

/** Identifies a design's content (a key over its canonical JSON). */
export function designKey(d: Design): string {
  return contentKey(canonicalJson(d));
}

/** The board as solved now for the design with this key, to be stored with it. */
export function freezeBoard(design: string, board: BoardView, build?: string, at = new Date()): SolvedBoard {
  return { design, solver: SOLVER_VERSION, ...(build ? { build } : {}), at: at.toISOString(), board };
}

/** The native file: the design as canonical JSON, the solved board (derived data) on one line. */
export function writeDesignFile(d: Design, solved?: SolvedBoard | null): string {
  const json = canonicalJson(d);
  return solved ? json.replace(/\n}\n$/, `,\n  "solved": ${JSON.stringify(solved)}\n}\n`) : json;
}

/** A parsed native file: the design, and its stored board when that belongs to this very design. */
export function readDesignFile(file: unknown): { design: Design; solved: SolvedBoard | null } {
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('Not a design file');
  const { solved, ...design } = file as Design & { solved?: SolvedBoard };
  const ok = !!solved && typeof solved === 'object' && Array.isArray(solved.board?.parts) && solved.design === designKey(design);
  return { design, solved: ok ? solved : null };
}

/**
 * A stored board for the design as the kernel holds it after loading: migration to the current
 * format rewrites the design (and so its key) without changing what it means.
 */
export function rekeySolved(solved: SolvedBoard, loaded: Design): SolvedBoard {
  return { ...solved, design: designKey(loaded) };
}
