/**
 * The enclosure (docs/design/enclosure.md): a brief agreed with the user, and an OpenSCAD script the
 * agent writes against the board as a library (board.scad, @4k7/fab). The app renders it through the
 * user's OpenSCAD (the local server) and measures it.
 */
import { z } from 'zod';
import type { Mating, PackageInfo } from './ingest.ts';

/* --------------------------------- brief ---------------------------------- */

export const BriefItem = z.object({
  topic: z.string().min(2).describe('What it is about, short: "J1 USB-C", "Closure", "Mounting", "Material", "SW1 button"'),
  refs: z.array(z.string().min(1)).optional().describe('The parts it is about (refdes)'),
  decision: z.string().min(1).optional().describe('What is decided: by you (from the request, the board or a sensible default) or by the user\'s answer. Leave out while it is a question'),
  why: z.string().optional().describe('Why, in a few words (your reason, "the user\'s answer", "default")'),
  question: z.string().min(5).optional().describe('A question only the user can answer; with options, your pick first'),
  options: z.array(z.string().min(1)).min(2).max(4).optional().describe('2–4 short choices for the question, your pick first'),
});
export type BriefItem = z.infer<typeof BriefItem>;

export const EnclosureBrief = z.object({
  items: z.array(BriefItem).min(1).describe('Everything the box must do: process and material, pieces and closure, how the board is held, each part that matters (connectors, buttons, LEDs, displays, antennas), cables, mounting, environment, looks'),
  openings: z
    .array(z.string().min(1))
    .optional()
    .describe('Parts used from outside with the box closed (refdes): the render checks that each one\'s way out (mating_path in board.scad) is clear'),
  max_size_mm: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]).optional().describe('The largest the closed box may be, x × y × z'),
  lid_clearance_mm: z.number().min(0).max(20).optional().describe('Room between the tallest part and the lid (default 1)'),
});
export type EnclosureBrief = z.infer<typeof EnclosureBrief>;

/** The enclosure as stored in the design. */
export interface EnclosureSettings {
  brief?: EnclosureBrief;
  /** The OpenSCAD script (enclosure.scad): includes board.scad, one module per piece. */
  script?: string;
}

/** The brief's questions the user has not answered yet. */
export function openQuestions(b: EnclosureBrief | undefined): BriefItem[] {
  return (b?.items ?? []).filter((i) => i.question && !i.decision);
}

export const DEFAULT_LID_CLEARANCE = 1;

/* --------------------------------- script --------------------------------- */

/**
 * The pieces a script makes: its `pieces = ["base", "lid"];` line. Each is a module of that name,
 * and `piece = "base"` renders one.
 */
export function scriptPieces(script: string): string[] | null {
  const m = /^\s*pieces\s*=\s*\[([^\]]*)\]\s*;/m.exec(stripComments(script));
  if (!m) return null;
  const names = [...m[1]!.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)].map((x) => x[1]!);
  return names.length ? names : null;
}

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * What is wrong with a script before it is rendered (empty: nothing). It runs on the user's computer:
 * it may only include board.scad, and may not read files (import, surface).
 */
export function scriptProblems(script: string): string[] {
  const code = stripComments(script);
  const out: string[] = [];
  if (!/\binclude\s*<\s*board\.scad\s*>/.test(code)) out.push('It must start with include <board.scad> (the board: outline, holes, parts, mating paths).');
  for (const m of code.matchAll(/\b(include|use)\s*<\s*([^>]*)>/g)) {
    if (m[2]!.trim() !== 'board.scad') out.push(`${m[1]} <${m[2]}>: only board.scad is there; put everything else in this script.`);
  }
  if (/\b(import|surface)\s*\(/.test(code)) out.push('import() and surface() read files: not allowed; draw everything in the script.');
  const pieces = scriptPieces(script);
  if (!pieces) out.push('Name the pieces: pieces = ["base", "lid"]; (each a module of that name, chosen by piece = "base").');
  else {
    for (const p of pieces) if (!new RegExp(`\\bmodule\\s+${p}\\s*\\(`).test(code)) out.push(`pieces names "${p}" but there is no module ${p}().`);
    if (!/\bpiece\s*=/.test(code)) out.push('Choose the piece with a variable: piece = "all"; and draw only that piece (or all of them) at the end.');
  }
  return out;
}

/* --------------------------------- mating --------------------------------- */

/** A part's mating face: given with its package, else what its family implies (pin headers plug from above). */
export function matingOf(pkg: PackageInfo | undefined): Mating | null {
  if (!pkg) return null;
  if (pkg.mating) return pkg.mating;
  if (pkg.family === 'HEADER') return { face: 'up' };
  return null;
}

/** Board directions (top view, y down): where a part's plug comes from, after its rotation and side. */
export type BoardFacing = 'left' | 'right' | 'top' | 'bottom' | 'above' | 'below';

/** Which way a mating face points on the board: the footprint's face turned clockwise by `rot`, mirrored on the bottom. */
export function boardFacing(face: Mating['face'], rot: number, side: 'top' | 'bottom'): BoardFacing {
  if (face === 'up') return side === 'bottom' ? 'below' : 'above';
  const order: BoardFacing[] = ['top', 'right', 'bottom', 'left']; // clockwise
  let f: BoardFacing = face;
  if (side === 'bottom' && (f === 'left' || f === 'right')) f = f === 'left' ? 'right' : 'left';
  const i = order.indexOf(f);
  return order[(i + Math.round((((rot % 360) + 360) % 360) / 90)) % 4]!;
}
