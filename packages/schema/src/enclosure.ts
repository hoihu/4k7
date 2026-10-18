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

/**
 * A graphic for the box (a logo, an icon): copied into the design from the artwork library or an
 * SVG path, so the box renders the same everywhere. board.scad draws it as graphic(name), 2D.
 */
export interface EnclosureGraphic {
  /** What the script calls it: graphic("logo"). */
  name: string;
  /** Filled (even-odd, figures inside figures are holes) or drawn as outlines `line` wide. */
  mode: 'fill' | 'outline';
  line?: number;
  /** Closed figures, flat x, y lists in mm centred on 0, 0, y down (as the artwork library's). */
  polys: number[][];
  /** Its size as stored (mm); the script scales it: graphic("logo", width = 20). */
  w: number;
  h: number;
  /** Where it came from: "artwork Acme logo", "SVG path". */
  source?: string;
}

/** The enclosure as stored in the design. */
export interface EnclosureSettings {
  brief?: EnclosureBrief;
  /** The OpenSCAD script (enclosure.scad): includes board.scad, one module per piece. */
  script?: string;
  /** Graphics the script draws (graphic(name) in board.scad). */
  graphics?: EnclosureGraphic[];
}

/** The graphics as the agent reads them (get_enclosure): without their figures. */
export function enclosureGraphicsInfo(list: EnclosureGraphic[] | undefined): { name: string; size_mm: [number, number]; mode: string; figures: number; source?: string }[] {
  return (list ?? []).map((g) => ({ name: g.name, size_mm: [g.w, g.h], mode: g.mode === 'fill' ? 'filled' : `outlines ${g.line} mm`, figures: g.polys.length, ...(g.source ? { source: g.source } : {}) }));
}

/**
 * What a render is made from, as one key: the script and the graphics. A report made from another
 * key is out of date.
 */
export function enclosureKey(e: EnclosureSettings | null | undefined): string {
  if (!e?.script) return '';
  if (!e.graphics?.length) return e.script;
  // FNV-1a over the graphics: their figures can be large
  let h = 0x811c9dc5;
  const s = JSON.stringify(e.graphics);
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return `${e.script}\n// graphics ${(h >>> 0).toString(16)}`;
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

/**
 * How each piece is printed: the script's `print = [["lid", [180, 0, 0]]];` (OpenSCAD rotate angles,
 * degrees). Pieces it does not name are printed as they are built.
 */
export function scriptPrintRotations(script: string): Record<string, [number, number, number]> {
  const m = /^\s*print\s*=\s*\[([\s\S]*?)\]\s*;/m.exec(stripComments(script));
  const out: Record<string, [number, number, number]> = {};
  if (!m) return out;
  const num = '(-?\\d+(?:\\.\\d+)?)';
  for (const e of m[1]!.matchAll(new RegExp(`\\[\\s*"([A-Za-z_][A-Za-z0-9_]*)"\\s*,\\s*\\[\\s*${num}\\s*,\\s*${num}\\s*,\\s*${num}\\s*\\]\\s*\\]`, 'g'))) {
    out[e[1]!] = [Number(e[2]), Number(e[3]), Number(e[4])];
  }
  return out;
}

/**
 * Pieces printed in another colour, inside or on a piece they belong to: the script's
 * `inlays = [["lid_logo", "lid", "white"]];` (the inlay, its host, the colour it is shown in). An
 * inlay prints with its host (turned the same, one object in the 3MF, its own part for a second
 * filament) and lifts with it in the opened view.
 */
export function scriptInlays(script: string): Record<string, { host: string; colour?: string }> {
  const m = /^\s*inlays\s*=\s*\[([\s\S]*?\])\s*\]\s*;/m.exec(stripComments(script));
  const out: Record<string, { host: string; colour?: string }> = {};
  if (!m) return out;
  const id = '"([A-Za-z_][A-Za-z0-9_]*)"';
  for (const e of m[1]!.matchAll(new RegExp(`\\[\\s*${id}\\s*,\\s*${id}\\s*(?:,\\s*"([^"]*)"\\s*)?\\]`, 'g'))) {
    out[e[1]!] = { host: e[2]!, ...(e[3] ? { colour: e[3] } : {}) };
  }
  return out;
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
    for (const [inlay, { host }] of Object.entries(scriptInlays(script))) {
      if (!pieces.includes(inlay)) out.push(`inlays names "${inlay}", which is not in pieces.`);
      else if (!pieces.includes(host)) out.push(`The inlay ${inlay} belongs to "${host}", which is not in pieces.`);
      else if (scriptInlays(script)[host]) out.push(`The inlay ${inlay} belongs to ${host}, itself an inlay: give it the piece they are both printed with.`);
    }
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

/* --------------------------- OpenSCAD on the server ------------------------ */

/** OpenSCAD on this computer, as the local server found it (GET /api/scad). */
export interface ScadStatus {
  available: boolean;
  version?: string;
  /** The program it runs. */
  path?: string;
  /** Who chose it: the environment variable (wins), the app's settings, or nobody (found by itself). */
  from: 'env' | 'settings' | 'auto';
  /** The environment variable that overrides it. */
  env: string;
  /** The fast Manifold geometry engine (OpenSCAD 2025 and later). */
  manifold?: boolean;
  /** Why it is not available, or a warning (old and slow). */
  reason?: string;
}

/** A render job (POST /api/scad/render): files (board.scad, enclosure.scad) and the runs to make, each its own top-level file. */
export interface ScadJob {
  files: Record<string, string>;
  runs: { id: string; code: string; mesh?: boolean }[];
}

/** What one run made. */
export interface ScadRunResult {
  id: string;
  /** Rendered (an empty result counts as rendered). */
  ok: boolean;
  /** Nothing came out (an intersection that does not meet: the check passed). */
  empty: boolean;
  ms: number;
  bbox?: { min: [number, number, number]; max: [number, number, number] };
  /** Binary STL, base64, when the run asked for its mesh. */
  stl?: string;
  errors?: string[];
  warnings?: string[];
}
