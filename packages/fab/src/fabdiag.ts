/**
 * The netlist check of the board's own production files (netcheck.ts) as diagnostics, so the
 * layout's checks and get_diagnostics carry what the files would build beside the DRC. One code per
 * kind of finding; positions in the board's coordinates. See docs/design/fab-check.md.
 */
import type { BoardView, Diagnostic, Severity } from '@4k7/schema';
import { readFabFiles } from './fabread.ts';
import { gerbers } from './gerber.ts';
import { checkFabSet, type CopperCheck, type CopperFindingKind } from './netcheck.ts';
import { boardNetDesign } from './netdesign.ts';

export const FAB_CODES = { short: 'FAB.SHORT', open: 'FAB.OPEN', pad: 'FAB.PAD_MISSING', floating: 'FAB.FLOATING' } as const satisfies Record<CopperFindingKind, string>;

const SEVERITY: Record<CopperFindingKind, Severity> = { short: 'error', open: 'error', pad: 'error', floating: 'warning' };

/** A finding about more pads than this names its nets only (a short of GND lists every GND pad). */
const NAMED_PADS = 6;

/** The board's files made as the export makes them (not stamped), read back and held against it; null without copper. */
export function checkBoardFiles(b: BoardView): CopperCheck | null {
  return checkFabSet(readFabFiles(gerbers(b, 'board')), boardNetDesign(b), { fresh: true });
}

/**
 * The check's findings as FAB.* diagnostics of board `b` (the one the files were made from). Copper
 * joined to nothing where the board marks the plane floating itself is left to DRC.FLOATING_PLANE.
 */
export function fabDiagnostics(c: CopperCheck | null, b: BoardView): Diagnostic[] {
  if (!c) return [];
  const floating = new Set(b.zones.filter((z) => z.floating).map((z) => `${z.layer}|${b.netNames[z.netId] ?? z.netId}`));
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return c.findings
    .filter((f) => !(f.kind === 'floating' && f.nets.length && f.nets.every((n) => floating.has(`${f.layer}|${n}`))))
    .map((f) => ({
      code: FAB_CODES[f.kind],
      severity: SEVERITY[f.kind],
      message: `Production files: ${f.text}`,
      entities: [...(f.pads.length <= NAMED_PADS ? f.pads : []), ...f.nets.map((n) => `net:${n}`)],
      // (the files count y up from the board's bottom edge)
      at: { x: r(f.at.x), y: r(b.outline.h - f.at.y) },
      source: 'the Gerber and drill files read back (docs/design/fab-check.md)',
    }));
}
