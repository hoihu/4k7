/**
 * Rendering and measuring an enclosure script (docs/design/enclosure.md §5.1–5.2). The job: one
 * run per piece (its mesh) and one per check, each an intersection that is empty when the check
 * passes. The report: what OpenSCAD said and what the checks found, in words the agent can act on.
 */
import { DEFAULT_LID_CLEARANCE, enclosureKey, matingOf, scriptInlays, scriptPieces, scriptPrintRotations, type BoardView, type EnclosureBrief, type EnclosureGraphic, type ScadJob, type ScadRunResult } from '@4k7/schema';
import { boardScad, type EnclosureFacts } from './scad.ts';
import { orient, orientTogether, parseStl, plate, printIssues, thinWalls, threeMf, warping, writeStl, type PlateObject } from './print.ts';

export type EnclosureCode = 'ENC.SCRIPT' | 'ENC.COLLIDES' | 'ENC.BLOCKED' | 'ENC.NO_MATING' | 'ENC.LOOSE' | 'ENC.LOW_LID' | 'ENC.PIECES_OVERLAP' | 'ENC.SIZE' | 'ENC.OVERHANG' | 'ENC.BRIDGE' | 'ENC.THIN' | 'ENC.WARP' | 'ENC.WARNING';

export interface EnclosureFinding {
  code: EnclosureCode;
  severity: 'error' | 'warning';
  message: string;
  /** Where (board.scad coordinates), for the pictures. */
  box?: { min: [number, number, number]; max: [number, number, number] };
  /** The parts it is about. */
  parts?: string[];
  /** The piece it is on (the 3D view lifts its box with the piece). */
  piece?: string;
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
  /** What it was made from (the script and the graphics: enclosureKey); another key means it is out of date. */
  key: string;
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
  key: string;
}

const r2 = (v: number) => Math.round(v * 100) / 100 || 0;
const pt = (v: readonly number[]) => `(${v.map(r2).join(', ')})`;
const dims = (b: { min: readonly number[]; max: readonly number[] }) => b.max.map((v, i) => r2(v - b.min[i]!)).join(' × ');

/** The job for a script on this board: the pieces, then the checks. */
export function enclosureJob(b: BoardView, project: string, script: string, brief?: EnclosureBrief, graphics?: EnclosureGraphic[]): EnclosureJob {
  const lib = boardScad(b, project, brief, graphics);
  const pieces = scriptPieces(script) ?? [];
  const inlays = scriptInlays(script);
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
    for (let j = i + 1; j < pieces.length; j++) {
      // an inlay fills the hollow cut for it in its host: they meet face to face, which OpenSCAD can leave as a sliver
      if (inlays[pieces[i]!]?.host === pieces[j] || inlays[pieces[j]!]?.host === pieces[i]) continue;
      runs.push({ id: `overlap:${pieces[i]}:${pieces[j]}`, code: `use <enclosure.scad>\nintersection() { ${pieces[i]}(); ${pieces[j]}(); }\n` });
    }
  }
  return { files: { 'board.scad': lib.content, 'enclosure.scad': script }, runs, pieces, facts: lib.facts, ...(brief ? { brief } : {}), key: enclosureKey({ script, ...(graphics ? { graphics } : {}) }) };
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
    return { script, key: job.key, pieces: [], findings, size: null, ms };
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

  // printing: overhangs and wide ceilings as each piece is printed, pieces that may warp, walls too thin to print
  // (not for inlays: they lie in or on their host, which carries them, and are as thin as they are meant to be)
  const turns = scriptPrintRotations(script);
  const inlays = scriptInlays(script);
  for (const p of pieces) {
    if (inlays[p.name]) continue;
    const tris = parseStl(p.stl);
    const how = turns[p.name] ? `printed turned ${turns[p.name]!.join(', ')}` : 'printed as built (no print orientation in the script)';
    for (const x of printIssues(tris, orient(tris, turns[p.name]))) {
      findings.push(
        x.kind === 'overhang'
          ? { code: 'ENC.OVERHANG', severity: 'warning', message: `${p.name}, ${how}: ${x.area} mm² hangs over steeper than 45° between ${pt(x.box.min)} and ${pt(x.box.max)}: it needs supports. Chamfer it, or turn the piece (print = [["${p.name}", [x, y, z]]];).`, box: x.box, piece: p.name }
          : { code: 'ENC.BRIDGE', severity: 'warning', message: `${p.name}, ${how}: a ceiling ${x.size} mm across with nothing under it, between ${pt(x.box.min)} and ${pt(x.box.max)}: wider than a printer bridges (about 20 mm). Turn the piece so it lies on the bed, or support it.`, box: x.box, piece: p.name },
      );
    }
    const w = warping(tris);
    const limit = warpLimit(job.brief);
    // a frame (a window, a lattice) shrinks towards its openings and twists: it warps sooner
    const max = Math.round(w && w.open >= 0.25 ? limit.slenderness * 0.8 : limit.slenderness);
    if (w && w.slenderness > max) {
      const frame = w.open >= 0.25 ? ` ${Math.round(w.open * 100)} % of its outline is open (a frame round a window, a lattice): it shrinks towards the openings and twists along its diagonals.` : '';
      findings.push({
        code: 'ENC.WARP',
        severity: 'warning',
        message: `${p.name} may warp: ${w.span} mm along ${w.along}, but only as stiff as a ${w.thickness} mm plate (slenderness ${w.slenderness}; keep it under ${max} for ${limit.process}).${frame} Stiffen it rather than thicken it all: ribs on its inside, 2–3 × the plate high and 0.6–0.8 × its thickness, at most ~30 mm apart (a cross or a grid, joined to the rim); a deeper rim or lip all round (4–6 mm); a rim round each large opening; a fillet where walls meet the plate. Or a plate about ${Math.ceil((w.span / max) * 10) / 10} mm thick.`,
        box: w.box,
        piece: p.name,
      });
    }
    for (const x of thinWalls(tris)) {
      findings.push({ code: 'ENC.THIN', severity: 'warning', message: `${p.name}: walls down to ${x.size} mm over ${x.area} mm² between ${pt(x.box.min)} and ${pt(x.box.max)}: thinner than two perimeters (0.8 mm) prints weak or not at all, unless it is meant to be (a light window). In a label or logo: details too fine to print; make it larger or bolder.`, box: x.box, piece: p.name });
    }
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
  return { script, key: job.key, pieces, findings, size, ms };
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

/** The pieces turned for printing as the script says (each on the bed), as STL files and one 3MF plate. */
export function printFiles(r: EnclosureReport, project: string): { stl: { name: string; data: Uint8Array }[]; plate: Uint8Array } {
  const turns = scriptPrintRotations(r.script);
  const inlays = scriptInlays(r.script);
  const hosts = r.pieces.filter((p) => !inlays[p.name] || !r.pieces.some((h) => h.name === inlays[p.name]!.host));
  // a piece and its inlays turned alike and set on the bed together, so the inlays stay where they belong
  const objects: PlateObject[] = hosts.map((h) => {
    const with_ = r.pieces.filter((p) => inlays[p.name]?.host === h.name);
    if (!with_.length) return { name: h.name, tris: orient(parseStl(h.stl), turns[h.name]) };
    const [tris, ...rest] = orientTogether([h, ...with_].map((p) => parseStl(p.stl)), turns[h.name]);
    return { name: h.name, tris: tris!, parts: with_.map((p, i) => ({ name: p.name, tris: rest[i]! })) };
  });
  const byName = new Map(objects.flatMap((o) => [[o.name, o.tris] as const, ...(o.parts ?? []).map((x) => [x.name, x.tris] as const)]));
  return {
    stl: r.pieces.map((p) => ({ name: p.name, data: writeStl(byName.get(p.name)!, `${project} ${p.name}`) })),
    plate: threeMf(plate(objects), `${project} enclosure`),
  };
}
