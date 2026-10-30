/**
 * The report on an enclosure script (docs/design/enclosure.md §5.1–5.2), as the app, the agent and the
 * print files read it, and how a script is wrapped to run. Rendering and measuring are in csg/ (its
 * own entry, @4k7/fab/csg: only the worker that renders loads the geometry engine).
 */
import { matingOf, scriptInlays, scriptPrintRotations, type BoardView, type EnclosureBrief } from '@4k7/schema';
import type { EnclosureFacts } from './scad.ts';
import { orient, orientTogether, plate, threeMf, writeStl, type PlateObject, type Tris } from './print.ts';

export type EnclosureCode = 'ENC.SCRIPT' | 'ENC.COLLIDES' | 'ENC.BLOCKED' | 'ENC.NO_MATING' | 'ENC.LOOSE' | 'ENC.LOW_LID' | 'ENC.PIECES_OVERLAP' | 'ENC.SIZE' | 'ENC.NEAR' | 'ENC.OVERHANG' | 'ENC.BRIDGE' | 'ENC.THIN' | 'ENC.WARP';

export interface EnclosureFinding {
  code: EnclosureCode;
  severity: 'error' | 'warning';
  message: string;
  /** Where (board coordinates), for the pictures. */
  box?: { min: [number, number, number]; max: [number, number, number] };
  /** The parts it is about. */
  parts?: string[];
  /** The piece it is on (the 3D view lifts its box with the piece). */
  piece?: string;
}

export interface EnclosurePiece {
  name: string;
  /** Its triangles (9 numbers each), in assembled position (board coordinates). */
  tris: Tris;
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

export interface EnclosureReport {
  /** The script it was made from. */
  script: string;
  /** What it was made from (the script and the graphics: enclosureKey); another key means it is out of date. */
  key: string;
  pieces: EnclosurePiece[];
  findings: EnclosureFinding[];
  /** The closed box: x × y × z. */
  size: [number, number, number] | null;
  /** Rendering time (ms). */
  ms: number;
  /** What the script said with echo(). */
  log?: string[];
}

/** The global the wrapped script leaves its function in. */
export const SCRIPT_GLOBAL = '__enclosureScript';

/**
 * A script as source to evaluate: one line, then the script, so its line n is line n + 1 here. A
 * function, so the script's names stay its own and shadow the library's. Called, it returns the pieces'
 * functions. Not in strict mode: there, Safari makes `return difference(…)` a tail call, which takes the
 * piece off the stack and with it the line of nearly every error (scriptProblems holds the script to
 * strict syntax, and to declaring what it assigns, before it gets here).
 */
export function scriptSource(script: string, pieces: string[]): string {
  return `globalThis.${SCRIPT_GLOBAL} = function () {\n${script}\n;return { ${pieces.join(', ')} };\n};`;
}

/** The line of the script an error comes from: the innermost in the script itself, whatever library call it died in. */
export function scriptLine(e: unknown, scriptUrl: string): number | null {
  const stack = (e as Error | undefined)?.stack ?? '';
  for (const frame of stack.split('\n')) {
    const i = frame.indexOf(scriptUrl);
    if (i < 0) continue;
    const m = /^:(\d+):\d+/.exec(frame.slice(i + scriptUrl.length));
    if (m) return Number(m[1]) - 1;
  }
  return null;
}

/** A report with one thing to say, that nothing could be made: the script is not fit to run, or did not end. */
export function failedReport(script: string, key: string, message: string, ms = 0): EnclosureReport {
  return { script, key, pieces: [], findings: [{ code: 'ENC.SCRIPT', severity: 'error', message }], size: null, ms };
}

/**
 * How slender a piece may be before it warps (WarpIssue), by the process the brief names: resin
 * cures and shrinks unevenly and peels from the vat, sintered powder cools slowly in the build, ABS
 * and ASA shrink more than PLA and PETG, which sit on a heated bed.
 */
export function warpLimit(brief?: EnclosureBrief): { process: string; slenderness: number } {
  const text = (brief?.items ?? []).filter((i) => /process|material|print/i.test(i.topic)).map((i) => `${i.topic} ${i.decision ?? ''}`).join(' ');
  if (/\b(sla|dlp|msla|lcd|resin)\b/i.test(text)) return { process: 'resin (SLA)', slenderness: 30 };
  if (/\b(mjf|sls|multi jet|sinter\w*|pa ?12|pa ?11)\b/i.test(text)) return { process: 'sintered nylon (MJF, SLS)', slenderness: 35 };
  if (/\b(abs|asa|pc|polycarbonate|nylon|pa)\b/i.test(text)) return { process: 'FDM in ABS, ASA, PC or nylon', slenderness: 35 };
  return { process: 'FDM in PLA or PETG', slenderness: 50 };
}

const dims = (b: { min: readonly number[]; max: readonly number[] }) => b.max.map((v, i) => Math.round((v - b.min[i]!) * 100) / 100 || 0).join(' × ');

/** The report as the agent reads it. */
export function reportText(r: EnclosureReport, facts?: EnclosureFacts): string {
  const errors = r.findings.filter((f) => f.severity === 'error');
  const lines: string[] = [];
  if (r.size) lines.push(`Box: ${r.size.join(' × ')} mm (x × y × z), pieces ${r.pieces.map((p) => `${p.name} ${dims(p.bbox)}`).join(', ')}.`);
  if (facts) lines.push(`Board: ${facts.size.join(' × ')} mm, top at z = ${facts.thickness}, tallest part to z = ${facts.tallestTop}, leads down to z = ${facts.lowestBottom}.`);
  lines.push(errors.length ? `${errors.length} finding(s) to fix:` : r.findings.length ? 'No errors; warnings:' : 'The report is clean: no collisions, every opening clear, the board held.');
  for (const f of r.findings) lines.push(`- ${f.severity === 'error' ? '' : 'warning: '}${f.code} ${f.message}`);
  if (r.log?.length) lines.push('The script said (echo):', ...r.log.map((l) => `  ${l}`));
  return lines.join('\n');
}

/** Whether a part is used from outside, by what the board says (connectors that are plugged from an edge). */
export function edgeConnectors(b: BoardView): string[] {
  return b.parts.filter((p) => p.category === 'connector' && matingOf(p.pkgInfo) && matingOf(p.pkgInfo)!.face !== 'up').map((p) => p.refdes);
}

/** The pieces turned for printing as the script says (each on the bed), as STL files and one 3MF plate. */
export function printFiles(r: EnclosureReport, project: string): { stl: { name: string; data: Uint8Array }[]; plate: Uint8Array } {
  const turns = scriptPrintRotations(r.script);
  const inlays = scriptInlays(r.script);
  const hosts = r.pieces.filter((p) => !inlays[p.name] || !r.pieces.some((h) => h.name === inlays[p.name]!.host));
  // a piece and its inlays turned alike and set on the bed together, so the inlays stay where they belong
  const objects: PlateObject[] = hosts.map((h) => {
    const with_ = r.pieces.filter((p) => inlays[p.name]?.host === h.name);
    if (!with_.length) return { name: h.name, tris: orient(h.tris, turns[h.name]) };
    const [tris, ...rest] = orientTogether([h, ...with_].map((p) => p.tris), turns[h.name]);
    return { name: h.name, tris: tris!, parts: with_.map((p, i) => ({ name: p.name, tris: rest[i]! })) };
  });
  const byName = new Map(objects.flatMap((o) => [[o.name, o.tris] as const, ...(o.parts ?? []).map((x) => [x.name, x.tris] as const)]));
  return {
    stl: r.pieces.map((p) => ({ name: p.name, data: writeStl(byName.get(p.name)!, `${project} ${p.name}`) })),
    plate: threeMf(plate(objects), `${project} enclosure`),
  };
}
