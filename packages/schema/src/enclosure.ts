/**
 * The enclosure (docs/design/enclosure.md): a brief agreed with the user, and a JavaScript script the
 * agent writes against the board as a library (@4k7/fab/csg). The app runs it on the Manifold geometry
 * engine, in a worker of its own, and measures what it makes.
 */
import { parse } from 'acorn';
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
    .describe('Parts used from outside with the box closed (refdes): the render checks that each one\'s way out (mating_path) is clear'),
  max_size_mm: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]).optional().describe('The largest the closed box may be, x × y × z'),
  lid_clearance_mm: z.number().min(0).max(20).optional().describe('Room between the tallest part and the lid (default 1)'),
});
export type EnclosureBrief = z.infer<typeof EnclosureBrief>;

/**
 * A graphic for the box (a logo, an icon): copied into the design from the artwork library or an
 * SVG path, so the box renders the same everywhere. The script draws it as graphic(name), 2D.
 */
export interface EnclosureGraphic {
  /** What the script calls it: graphic('logo'). */
  name: string;
  /** Filled (even-odd, figures inside figures are holes) or drawn as outlines `line` wide. */
  mode: 'fill' | 'outline';
  line?: number;
  /** Closed figures, flat x, y lists in mm centred on 0, 0, y down (as the artwork library's). */
  polys: number[][];
  /** Its size as stored (mm); the script scales it: graphic('logo', { width: 20 }). */
  w: number;
  h: number;
  /** Where it came from: "artwork Acme logo", "SVG path". */
  source?: string;
}

/** The enclosure as stored in the design. */
export interface EnclosureSettings {
  brief?: EnclosureBrief;
  /** The JavaScript script: one function per piece, against the board's library (@4k7/fab/csg). */
  script?: string;
  /** Graphics the script draws (graphic(name)). */
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

type AstNode = { type: string; loc: { start: { line: number } }; [key: string]: unknown };

/** Not a plain literal (a variable, a calculation). */
const NOT_LITERAL = Symbol('not a literal');

/** The value of a plain literal in the script: numbers, strings, arrays and objects of them. */
function literal(node: AstNode): unknown {
  switch (node.type) {
    case 'Literal':
      return node.value;
    case 'TemplateLiteral':
      return (node.expressions as AstNode[]).length ? NOT_LITERAL : (node.quasis as { value: { cooked: string } }[])[0]!.value.cooked;
    case 'UnaryExpression': {
      const v = node.operator === '-' ? literal(node.argument as AstNode) : NOT_LITERAL;
      return typeof v === 'number' ? -v : NOT_LITERAL;
    }
    case 'ArrayExpression': {
      const out = (node.elements as (AstNode | null)[]).map((e) => (e ? literal(e) : NOT_LITERAL));
      return out.includes(NOT_LITERAL) ? NOT_LITERAL : out;
    }
    case 'ObjectExpression': {
      const out: Record<string, unknown> = {};
      for (const p of node.properties as AstNode[]) {
        if (p.type !== 'Property' || p.computed) return NOT_LITERAL;
        const key = p.key as AstNode;
        const v = literal(p.value as AstNode);
        if (v === NOT_LITERAL) return NOT_LITERAL;
        out[key.type === 'Identifier' ? (key.name as string) : String(key.value)] = v;
      }
      return out;
    }
    default:
      return NOT_LITERAL;
  }
}

/** Every node under a node, leaving out the names that are not variables: an object's keys, the b of a.b. `visit` returning false: not what is under this one. */
function walk(node: AstNode, visit: (n: AstNode) => void | false) {
  if (visit(node) === false) return;
  for (const key of Object.keys(node)) {
    if ((key === 'key' || key === 'property') && !node.computed) continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const x of v) if (x && typeof (x as AstNode).type === 'string') walk(x as AstNode, visit);
    } else if (v && typeof (v as AstNode).type === 'string') walk(v as AstNode, visit);
  }
}

/** What the script reads from outside the geometry and the board: it runs without any of it (docs/design/enclosure.md §8). */
const NOT_THERE = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'importScripts', 'require', 'eval', 'Function', 'indexedDB', 'localStorage']);

const PIECE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What a script says, read without running it. */
interface ScriptInfo {
  /** What is wrong with it (empty: nothing). */
  problems: string[];
  pieces: string[] | null;
  print: Record<string, [number, number, number]>;
  inlays: Record<string, { host: string; colour?: string }>;
  /** The graphics it draws by name: graphic('logo', …). */
  graphics: string[];
}

function readScript(script: string): ScriptInfo {
  const info: ScriptInfo = { problems: [], pieces: null, print: {}, inlays: {}, graphics: [] };
  let program: AstNode;
  try {
    // as a module, for its strict rules and to name import and export below (it runs as a plain function: see scriptSource in @4k7/fab)
    program = parse(script, { ecmaVersion: 'latest', sourceType: 'module', locations: true }) as unknown as AstNode;
  } catch (e) {
    const err = e as SyntaxError & { loc?: { line: number; column: number } };
    if (/\binclude\s*<\s*board\.scad\s*>|^\s*module\s+\w+\s*\(/m.test(script)) {
      info.problems.push('This is an OpenSCAD script, and the enclosure is JavaScript on the Manifold engine now: rewrite it (design_query get_enclosure: script and board_api). The board\'s names are the same: pcb_shape, mating_path, hole_posts, label, engrave; the geometry is cube, cylinder, difference, linear_extrude.');
      return info;
    }
    info.problems.push(`Line ${err.loc?.line ?? '?'}, column ${(err.loc?.column ?? -1) + 1}: ${err.message.replace(/\s*\(\d+:\d+\)$/, '')}.`);
    return info;
  }

  const at = (n: AstNode) => `Line ${n.loc.start.line}`;
  const declared = new Map<string, AstNode>();
  const body = program.body as AstNode[];
  for (const n of body) {
    if (n.type === 'FunctionDeclaration') declared.set((n.id as { name: string }).name, n);
    if (n.type === 'VariableDeclaration') {
      for (const d of n.declarations as AstNode[]) {
        const id = d.id as AstNode;
        if (id.type === 'Identifier') declared.set(id.name as string, d);
      }
    }
    if (/^(Import|Export)/.test(n.type)) info.problems.push(`${at(n)}: no import or export: the geometry and the board are already there, and the pieces are named by const pieces = […];.`);
  }
  walk(program, (n) => {
    if (n.type === 'ImportExpression') info.problems.push(`${at(n)}: no import(): the script runs on its own; draw everything in it.`);
    if (n.type === 'Identifier' && NOT_THERE.has(n.name as string) && !declared.has(n.name as string)) info.problems.push(`${at(n)}: ${n.name as string} is not there: the script makes geometry and reads nothing from outside.`);
    if (n.type === 'CallExpression' && (n.callee as AstNode).type === 'Identifier' && (n.callee as AstNode).name === 'graphic') {
      const first = (n.arguments as AstNode[])[0];
      const name = first ? literal(first) : NOT_LITERAL;
      if (typeof name === 'string') info.graphics.push(name);
    }
  });
  // (the parser takes this at a module's top; the script is the body of a plain function)
  walk(program, (n) => {
    if (/Function/.test(n.type)) return false;
    if (n.type === 'AwaitExpression' || (n.type === 'ForOfStatement' && n.await)) info.problems.push(`${at(n)}: no await: the script runs straight through.`);
  });
  // what strict mode would have said at run time, and earlier: a name assigned without a declaration, anywhere in the script
  const names = new Set<string>();
  const nameIn = (pattern: AstNode | null | undefined) => pattern && walk(pattern, (n) => void (n.type === 'Identifier' && names.add(n.name as string)));
  walk(program, (n) => {
    if (n.type === 'VariableDeclarator') nameIn(n.id as AstNode);
    if (n.type === 'CatchClause') nameIn(n.param as AstNode | null);
    if (/Function|Class/.test(n.type)) {
      nameIn(n.id as AstNode | null);
      for (const p of (n.params as AstNode[] | undefined) ?? []) nameIn(p);
    }
  });
  walk(program, (n) => {
    const target = (n.type === 'AssignmentExpression' ? n.left : n.type === 'UpdateExpression' ? n.argument : /^For(In|Of)Statement$/.test(n.type) ? n.left : null) as AstNode | null;
    if (target?.type === 'Identifier' && !names.has(target.name as string)) info.problems.push(`${at(n)}: ${target.name as string} is assigned but not declared: const ${target.name as string} = …;`);
  });

  const value = (name: string) => {
    const d = declared.get(name);
    return d?.type === 'VariableDeclarator' && d.init ? literal(d.init as AstNode) : declared.has(name) ? NOT_LITERAL : undefined;
  };
  const pieces = value('pieces');
  if (Array.isArray(pieces) && pieces.length && pieces.every((p) => typeof p === 'string' && PIECE_NAME.test(p))) info.pieces = pieces as string[];
  if (!info.pieces) {
    info.problems.push('Name the pieces: const pieces = [\'base\', \'lid\']; (plain names, each a function of that name).');
    return info;
  }
  for (const p of info.pieces) if (!declared.has(p)) info.problems.push(`pieces names "${p}" but there is no function ${p}().`);

  const print = value('print');
  if (print !== undefined) {
    const ok = !!print && typeof print === 'object' && !Array.isArray(print) && Object.values(print).every((r) => Array.isArray(r) && r.length === 3 && r.every((v) => typeof v === 'number'));
    if (!ok) info.problems.push('print is plain numbers, read without running the script: const print = { lid: [180, 0, 0] }; (the angles of rotate).');
    else {
      info.print = print as ScriptInfo['print'];
      for (const name of Object.keys(info.print)) if (!info.pieces.includes(name)) info.problems.push(`print names "${name}", which is not in pieces.`);
    }
  }

  const inlays = value('inlays');
  if (inlays !== undefined) {
    const ok = !!inlays && typeof inlays === 'object' && !Array.isArray(inlays) && Object.values(inlays).every((x: { host?: unknown; colour?: unknown }) => !!x && typeof x.host === 'string' && (x.colour === undefined || typeof x.colour === 'string'));
    if (!ok) info.problems.push('inlays is plain text, read without running the script: const inlays = { lid_logo: { host: \'lid\', colour: \'white\' } };.');
    else {
      for (const [name, x] of Object.entries(inlays as Record<string, { host: string; colour?: string }>)) info.inlays[name] = { host: x.host, ...(x.colour ? { colour: x.colour } : {}) };
      for (const [inlay, { host }] of Object.entries(info.inlays)) {
        if (!info.pieces.includes(inlay)) info.problems.push(`inlays names "${inlay}", which is not in pieces.`);
        else if (!info.pieces.includes(host)) info.problems.push(`The inlay ${inlay} belongs to "${host}", which is not in pieces.`);
        else if (info.inlays[host]) info.problems.push(`The inlay ${inlay} belongs to ${host}, itself an inlay: give it the piece they are both printed with.`);
      }
    }
  }
  return info;
}

/** The views ask often, and of the same script. */
let lastRead: { script: string; info: ScriptInfo } | null = null;
function scriptInfo(script: string): ScriptInfo {
  if (lastRead?.script !== script) lastRead = { script, info: readScript(script) };
  return lastRead.info;
}

/** The pieces a script makes: its `const pieces = ['base', 'lid'];`, each a function of that name. Null when it has none, or does not parse. */
export function scriptPieces(script: string): string[] | null {
  return scriptInfo(script).pieces;
}

/**
 * How each piece is printed: the script's `const print = { lid: [180, 0, 0] };` (the angles of rotate,
 * degrees). Pieces it does not name are printed as they are built.
 */
export function scriptPrintRotations(script: string): Record<string, [number, number, number]> {
  return scriptInfo(script).print;
}

/**
 * Pieces printed in another colour, inside or on a piece they belong to: the script's
 * `const inlays = { lid_logo: { host: 'lid', colour: 'white' } };` (the colour it is shown in). An
 * inlay prints with its host (turned the same, one object in the 3MF, its own part for a second
 * filament) and lifts with it in the opened view.
 */
export function scriptInlays(script: string): Record<string, { host: string; colour?: string }> {
  return scriptInfo(script).inlays;
}

/** The graphics a script draws by name: graphic('logo', …). */
export function scriptGraphics(script: string): string[] {
  return scriptInfo(script).graphics;
}

/**
 * What is wrong with a script before it is run (empty: nothing): it parses, it names its pieces and
 * they are there, and it does not reach for what it cannot have. Not what keeps it in: the worker
 * does that (docs/design/enclosure.md §8). This says so while it can still be fixed, with the line.
 */
export function scriptProblems(script: string): string[] {
  // (a copy: the kernel adds to it, and the same script comes again)
  return [...scriptInfo(script).problems];
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

/** How far a mating path reaches out by default (mm). */
export const MATING_PATH_LENGTH = 30;

/**
 * The faces labels go on, each as [the reader's right, up, out of the box] (x right, y up from the
 * board's bottom-left corner, z up). Read from outside, upright; the floor is read with the box tipped
 * towards you.
 */
export const FACE_FRAMES: Record<BoardFacing, [[number, number, number], [number, number, number], [number, number, number]]> = {
  left: [[0, -1, 0], [0, 0, 1], [-1, 0, 0]],
  right: [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
  top: [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  bottom: [[1, 0, 0], [0, 0, 1], [0, -1, 0]],
  above: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  below: [[1, 0, 0], [0, -1, 0], [0, 0, -1]],
};
