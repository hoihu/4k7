/**
 * On a design of several boards, the user's board edits (a drag, the panel's tabs) are for the board
 * shown, so an op without a `board` field gets it. `set_fab_profile` is left as it is: without `board`
 * it sets the house on every board, which is what the manufacturer picker means (a board's own tier is
 * a later `set_fab_profile` with `board`). See docs/design/multi-board.md §5.
 */
const EVERY_BOARD = new Set(['set_fab_profile']);

export function onShownBoard(ops: unknown[], boards: number, shown: string): unknown[] {
  if (boards <= 1) return ops;
  return ops.map((o) =>
    o && typeof o === 'object' && !('board' in o) && !EVERY_BOARD.has((o as { op?: unknown }).op as string) ? { ...o, board: shown } : o,
  );
}
