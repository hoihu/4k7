/**
 * Rendering and measuring an enclosure script (docs/design/enclosure.md §5.1–5.2). The job: one
 * run per piece (its mesh) and one per check, each an intersection that is empty when the check
 * passes. The report: what OpenSCAD said and what the checks found, in words the agent can act on.
 */
import { DEFAULT_LID_CLEARANCE, matingOf, scriptPieces, type BoardView, type EnclosureBrief, type ScadJob, type ScadRunResult } from '@4k7/schema';
import { boardScad, type EnclosureFacts } from './scad.ts';

export type EnclosureCode = 'ENC.SCRIPT' | 'ENC.COLLIDES' | 'ENC.BLOCKED' | 'ENC.NO_MATING' | 'ENC.LOOSE' | 'ENC.LOW_LID' | 'ENC.PIECES_OVERLAP' | 'ENC.SIZE' | 'ENC.WARNING';

export interface EnclosureFinding {
  code: EnclosureCode;
  severity: 'error' | 'warning';
  message: string;
  /** Where (board.scad coordinates), for the pictures. */
  box?: { min: [number, number, number]; max: [number, number, number] };
  /** The parts it is about. */
  parts?: string[];
}

export interface EnclosurePiece {
  name: string;
  /** Binary STL, base64, in assembled position (board.scad coordinates). */
  stl: string;
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

export interface EnclosureReport {
  /** The script it was made from. */
  script: string;
  pieces: EnclosurePiece[];
  findings: EnclosureFinding[];
  /** The closed box: x × y × z. */
  size: [number, number, number] | null;
  /** Rendering time, all runs (ms). */
  ms: number;
}

/** Everything a render needs: the files and the runs. */
export interface EnclosureJob extends ScadJob {
  pieces: string[];
  facts: EnclosureFacts;
  brief?: EnclosureBrief;
}

const r2 = (v: number) => Math.round(v * 100) / 100 || 0;
const pt = (v: readonly number[]) => `(${v.map(r2).join(', ')})`;
const dims = (b: { min: readonly number[]; max: readonly number[] }) => b.max.map((v, i) => r2(v - b.min[i]!)).join(' × ');

/** The job for a script on this board: the pieces, then the checks. */
export function enclosureJob(b: BoardView, project: string, script: string, brief?: EnclosureBrief): EnclosureJob {
  const lib = boardScad(b, project, brief);
  const pieces = scriptPieces(script) ?? [];
  const all = `union() { ${pieces.map((p) => `${p}();`).join(' ')} }`;
  const head = 'use <enclosure.scad>\ninclude <board.scad>\n';
  const runs: ScadJob['runs'] = [];
  for (const p of pieces) runs.push({ id: `piece:${p}`, code: `use <enclosure.scad>\n${p}();\n`, mesh: true });
  for (const p of pieces) runs.push({ id: `collide:${p}`, code: `${head}intersection() { ${p}(); union() { pcb(); parts(); } }\n` });
  for (const ref of brief?.openings ?? []) {
    const part = lib.facts.parts.find((x) => x.ref === ref);
    if (part?.mating) runs.push({ id: `way:${ref}`, code: `${head}intersection() { ${all} mating_path(${JSON.stringify(ref)}); }\n` });
  }
  // the room over every part on top, as high as the brief's lid clearance
  const clear = brief?.lid_clearance_mm ?? DEFAULT_LID_CLEARANCE;
  if (clear > 0) runs.push({ id: 'lid', code: `${head}intersection() { ${all} for (p = parts_info) if (p[4] == "top") translate([p[2][0], p[2][1], p[3][2]]) cube([p[3][0] - p[2][0], p[3][1] - p[2][1], ${clear}]); }\n` });
  // the board rests on something under each hole (or anywhere under it when it has none)
  if (lib.facts.holes.length) {
    for (const h of lib.facts.holes) runs.push({ id: `rest:${h.id}`, code: `${head}intersection() { ${all} translate([${h.x}, ${h.y}, -0.25]) cylinder(h = 0.25, r = ${h.d / 2 + 1.5}, $fn = 24); }\n` });
  } else runs.push({ id: 'rest:board', code: `${head}intersection() { ${all} translate([0, 0, -0.25]) linear_extrude(height = 0.25) pcb_shape(); }\n` });
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) runs.push({ id: `overlap:${pieces[i]}:${pieces[j]}`, code: `use <enclosure.scad>\nintersection() { ${pieces[i]}(); ${pieces[j]}(); }\n` });
  }
  return { files: { 'board.scad': lib.content, 'enclosure.scad': script }, runs, pieces, facts: lib.facts, ...(brief ? { brief } : {}) };
}

/** Parts whose box meets `box` (grown a hair). */
function partsAt(facts: EnclosureFacts, box: { min: readonly number[]; max: readonly number[] }): string[] {
  const g = 0.05;
  return facts.parts.filter((p) => [0, 1, 2].every((i) => p.min[i]! <= box.max[i]! + g && p.max[i]! >= box.min[i]! - g)).map((p) => p.ref);
}

/** Read the runs' results into the report. */
export function enclosureReport(job: EnclosureJob, results: ScadRunResult[], script: string): EnclosureReport {
  const findings: EnclosureFinding[] = [];
  const by = new Map(results.map((r) => [r.id, r]));
  const ms = results.reduce((s, r) => s + r.ms, 0);
  // a script that does not render: its errors are all there is to say
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    const lines = [...new Set(failed.flatMap((r) => r.errors ?? []))].slice(0, 12);
    findings.push({ code: 'ENC.SCRIPT', severity: 'error', message: `OpenSCAD could not render it:\n${lines.join('\n') || 'no output'}` });
    return { script, pieces: [], findings, size: null, ms };
  }
  const warnings = [...new Set(results.flatMap((r) => r.warnings ?? []))];
  if (warnings.length) findings.push({ code: 'ENC.WARNING', severity: 'warning', message: `OpenSCAD warned:\n${warnings.slice(0, 8).join('\n')}` });

  const pieces: EnclosurePiece[] = [];
  for (const name of job.pieces) {
    const r = by.get(`piece:${name}`);
    if (!r || r.empty || !r.stl || !r.bbox) findings.push({ code: 'ENC.SCRIPT', severity: 'error', message: `The piece ${name}() is empty: it draws nothing.` });
    else pieces.push({ name, stl: r.stl, bbox: r.bbox });
  }

  for (const name of job.pieces) {
    const r = by.get(`collide:${name}`);
    if (!r || r.empty || !r.bbox) continue;
    const near = partsAt(job.facts, r.bbox);
    findings.push({
      code: 'ENC.COLLIDES',
      severity: 'error',
      message: `${name} runs into ${near.length ? near.join(', ') : 'the board itself'}: ${dims(r.bbox)} mm of it, between ${pt(r.bbox.min)} and ${pt(r.bbox.max)}.`,
      box: r.bbox,
      ...(near.length ? { parts: near } : {}),
    });
  }

  for (const ref of job.brief?.openings ?? []) {
    const part = job.facts.parts.find((x) => x.ref === ref);
    if (!part) continue;
    if (!part.mating) {
      findings.push({ code: 'ENC.NO_MATING', severity: 'error', message: `${ref} should have an opening, but where it is plugged from is unknown: set_mating (face and plug size from its datasheet).`, parts: [ref] });
      continue;
    }
    const r = by.get(`way:${ref}`);
    if (!r || r.empty || !r.bbox) continue;
    findings.push({
      code: 'ENC.BLOCKED',
      severity: 'error',
      message: `${ref}'s way out (plugged from ${part.mating.facing}, ${part.mating.size.join(' × ')} mm) is blocked: ${dims(r.bbox)} mm of the box, between ${pt(r.bbox.min)} and ${pt(r.bbox.max)}. Cut it with mating_path("${ref}", grow = clearance).`,
      box: r.bbox,
      parts: [ref],
    });
  }

  const lid = by.get('lid');
  if (lid && !lid.empty && lid.bbox) {
    const clear = job.brief?.lid_clearance_mm ?? DEFAULT_LID_CLEARANCE;
    const near = partsAt(job.facts, { min: [lid.bbox.min[0], lid.bbox.min[1], lid.bbox.min[2] - clear], max: lid.bbox.max }).filter((ref) => {
      const p = job.facts.parts.find((x) => x.ref === ref)!;
      return p.side === 'top' && p.max[2] <= lid.bbox!.max[2] && p.max[2] >= lid.bbox!.min[2] - clear - 0.05;
    });
    findings.push({
      code: 'ENC.LOW_LID',
      severity: 'error',
      message: `Less than ${clear} mm (the brief's lid clearance) over ${near.length ? near.join(', ') : 'some parts'}: the box comes down to z = ${r2(lid.bbox.min[2])} between ${pt(lid.bbox.min)} and ${pt(lid.bbox.max)}.`,
      box: lid.bbox,
      ...(near.length ? { parts: near } : {}),
    });
  }

  const holes = job.facts.holes;
  if (holes.length) {
    const loose = holes.filter((h) => by.get(`rest:${h.id}`)?.empty !== false);
    if (loose.length) {
      findings.push({
        code: 'ENC.LOOSE',
        severity: loose.length === holes.length ? 'error' : 'warning',
        message: `The board rests on ${holes.length - loose.length} of ${holes.length} mounting holes: nothing reaches the underside (z = 0) under ${loose.map((h) => h.id).join(', ')}. A post under each (hole_posts) holds it.`,
      });
    }
  } else if (by.get('rest:board')?.empty !== false) {
    findings.push({ code: 'ENC.LOOSE', severity: 'error', message: 'Nothing holds the board from below: no post, rib or ledge reaches its underside (z = 0).' });
  }

  for (const r of results.filter((x) => x.id.startsWith('overlap:') && !x.empty && x.bbox)) {
    const [, a, b] = r.id.split(':');
    findings.push({ code: 'ENC.PIECES_OVERLAP', severity: 'error', message: `${a} and ${b} overlap where they meet (${dims(r.bbox!)} mm between ${pt(r.bbox!.min)} and ${pt(r.bbox!.max)}): leave a clearance between them.`, box: r.bbox! });
  }

  let size: [number, number, number] | null = null;
  if (pieces.length) {
    const min = [0, 1, 2].map((i) => Math.min(...pieces.map((p) => p.bbox.min[i]!)));
    const max = [0, 1, 2].map((i) => Math.max(...pieces.map((p) => p.bbox.max[i]!)));
    size = [r2(max[0]! - min[0]!), r2(max[1]! - min[1]!), r2(max[2]! - min[2]!)];
    const limit = job.brief?.max_size_mm;
    if (limit && size.some((v, i) => v > limit[i]! + 1e-6)) {
      findings.push({ code: 'ENC.SIZE', severity: 'error', message: `The box is ${size.join(' × ')} mm; the brief allows ${limit.join(' × ')} mm.` });
    }
  }
  return { script, pieces, findings, size, ms };
}

/** The report as the agent reads it. */
export function reportText(r: EnclosureReport, facts?: EnclosureFacts): string {
  const errors = r.findings.filter((f) => f.severity === 'error');
  const lines: string[] = [];
  if (r.size) lines.push(`Box: ${r.size.join(' × ')} mm (x × y × z), pieces ${r.pieces.map((p) => `${p.name} ${dims(p.bbox)}`).join(', ')}.`);
  if (facts) lines.push(`Board: ${facts.size.join(' × ')} mm, top at z = ${facts.thickness}, tallest part to z = ${facts.tallestTop}, leads down to z = ${facts.lowestBottom}.`);
  lines.push(errors.length ? `${errors.length} finding(s) to fix:` : r.findings.length ? 'No errors; warnings:' : 'The report is clean: no collisions, every opening clear, the board held.');
  for (const f of r.findings) lines.push(`- ${f.severity === 'error' ? '' : 'warning: '}${f.code} ${f.message}`);
  return lines.join('\n');
}

/** Whether a part is used from outside, by what the board says (connectors that are plugged from an edge). */
export function edgeConnectors(b: BoardView): string[] {
  return b.parts.filter((p) => p.category === 'connector' && matingOf(p.pkgInfo) && matingOf(p.pkgInfo)!.face !== 'up').map((p) => p.refdes);
}
