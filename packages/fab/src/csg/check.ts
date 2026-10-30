/**
 * The report on what a script made (docs/design/enclosure.md §5.2): every check an intersection that
 * is empty when it passes, and the printing checks on each piece's triangles.
 */
import type { EnclosureBrief } from '@4k7/schema';
import { DEFAULT_LID_CLEARANCE, scriptInlays, scriptPrintRotations } from '@4k7/schema';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { warpLimit, type EnclosureFinding, type EnclosurePiece } from '../enclosure.ts';
import { orient, printIssues, thinWalls, warping, type Tris } from '../print.ts';
import type { EnclosureFacts } from '../scad.ts';
import type { BoardLib } from './board.ts';

type Box = { min: [number, number, number]; max: [number, number, number] };

const r2 = (v: number) => Math.round(v * 100) / 100 || 0;
const pt = (v: readonly number[]) => `(${v.map(r2).join(', ')})`;
const dims = (b: Box) => b.max.map((v, i) => r2(v - b.min[i]!)).join(' × ');

/** Closer than this to a part it should clear (mm): a fit that the first print can close. */
const NEAR_MM = 0.2;

/** Parts whose box meets `box` (grown a hair). */
function partsAt(facts: EnclosureFacts, box: { min: readonly number[]; max: readonly number[] }): string[] {
  const g = 0.05;
  return facts.parts.filter((p) => [0, 1, 2].every((i) => p.min[i]! <= box.max[i]! + g && p.max[i]! >= box.min[i]! - g)).map((p) => p.ref);
}

/** Where two solids meet, or null when they do not (touching is not meeting). */
function meets(s: Manifold): Box | null {
  if (s.isEmpty() || s.volume() <= 1e-6) return null;
  const b = s.boundingBox();
  return { min: [...b.min] as Box['min'], max: [...b.max] as Box['max'] };
}

/** A solid's triangles (9 numbers each), as the print checks and the 3D view take them. */
export function trisOf(s: Manifold): Tris {
  const { numProp, vertProperties: v, triVerts: t } = s.getMesh();
  const out = new Float32Array(t.length * 3);
  for (let i = 0; i < t.length; i++) {
    const k = t[i]! * numProp;
    out[i * 3] = v[k]!;
    out[i * 3 + 1] = v[k + 1]!;
    out[i * 3 + 2] = v[k + 2]!;
  }
  return out;
}

/** What the script's pieces do on this board. */
export function geometryFindings(w: ManifoldToplevel, lib: BoardLib, facts: EnclosureFacts, solids: { name: string; solid: Manifold }[], script: string, brief?: EnclosureBrief): EnclosureFinding[] {
  const { Manifold } = w;
  const findings: EnclosureFinding[] = [];
  const all = Manifold.union(solids.map((p) => p.solid));
  const inlays = scriptInlays(script);

  const board = lib.assembly();
  for (const { name, solid } of solids) {
    const box = meets(solid.intersect(board));
    if (!box) continue;
    const near = partsAt(facts, box);
    findings.push({
      code: 'ENC.COLLIDES',
      severity: 'error',
      message: `${name} runs into ${near.length ? near.join(', ') : 'the board itself'}: ${dims(box)} mm of it, between ${pt(box.min)} and ${pt(box.max)}.`,
      box,
      ...(near.length ? { parts: near } : {}),
    });
  }

  for (const ref of brief?.openings ?? []) {
    const part = facts.parts.find((x) => x.ref === ref);
    if (!part) continue;
    if (!part.mating) {
      findings.push({ code: 'ENC.NO_MATING', severity: 'error', message: `${ref} should have an opening, but where it is plugged from is unknown: set_mating (face and plug size from its datasheet).`, parts: [ref] });
      continue;
    }
    const box = meets(all.intersect(lib.mating_path(ref)));
    if (!box) continue;
    findings.push({
      code: 'ENC.BLOCKED',
      severity: 'error',
      message: `${ref}'s way out (plugged from ${part.mating.facing}, ${part.mating.size.join(' × ')} mm) is blocked: ${dims(box)} mm of the box, between ${pt(box.min)} and ${pt(box.max)}. Cut it with mating_path('${ref}', { grow: clearance }).`,
      box,
      parts: [ref],
    });
  }

  // the room over every part on top, as high as the brief's lid clearance
  const clear = brief?.lid_clearance_mm ?? DEFAULT_LID_CLEARANCE;
  const topParts = facts.parts.filter((p) => p.side === 'top');
  if (clear > 0 && topParts.length) {
    const room = Manifold.union(topParts.map((p) => Manifold.cube([p.max[0] - p.min[0], p.max[1] - p.min[1], clear]).translate([p.min[0], p.min[1], p.max[2]])));
    const lid = meets(all.intersect(room));
    if (lid) {
      const near = partsAt(facts, { min: [lid.min[0], lid.min[1], lid.min[2] - clear], max: lid.max }).filter((ref) => {
        const p = facts.parts.find((x) => x.ref === ref)!;
        return p.side === 'top' && p.max[2] <= lid.max[2] && p.max[2] >= lid.min[2] - clear - 0.05;
      });
      findings.push({
        code: 'ENC.LOW_LID',
        severity: 'error',
        message: `Less than ${clear} mm (the brief's lid clearance) over ${near.length ? near.join(', ') : 'some parts'}: the box comes down to z = ${r2(lid.min[2])} between ${pt(lid.min)} and ${pt(lid.max)}.`,
        box: lid,
        ...(near.length ? { parts: near } : {}),
      });
    }
  }

  // the board rests on something under each hole (or anywhere under it when it has none)
  if (facts.holes.length) {
    const loose = facts.holes.filter((h) => !meets(all.intersect(Manifold.cylinder(0.25, h.d / 2 + 1.5, h.d / 2 + 1.5, 24).translate([h.x, h.y, -0.25]))));
    if (loose.length) {
      findings.push({
        code: 'ENC.LOOSE',
        severity: loose.length === facts.holes.length ? 'error' : 'warning',
        message: `The board rests on ${facts.holes.length - loose.length} of ${facts.holes.length} mounting holes: nothing reaches the underside (z = 0) under ${loose.map((h) => h.id).join(', ')}. A post under each (hole_posts) holds it.`,
      });
    }
  } else if (!meets(all.intersect(lib.pcb_shape().extrude(0.25).translate([0, 0, -0.25])))) {
    findings.push({ code: 'ENC.LOOSE', severity: 'error', message: 'Nothing holds the board from below: no post, rib or ledge reaches its underside (z = 0).' });
  }

  for (let i = 0; i < solids.length; i++) {
    for (let j = i + 1; j < solids.length; j++) {
      const [a, b] = [solids[i]!, solids[j]!];
      // an inlay fills the hollow cut for it in its host: they meet face to face
      if (inlays[a.name]?.host === b.name || inlays[b.name]?.host === a.name) continue;
      const box = meets(a.solid.intersect(b.solid));
      if (box) findings.push({ code: 'ENC.PIECES_OVERLAP', severity: 'error', message: `${a.name} and ${b.name} overlap where they meet (${dims(box)} mm between ${pt(box.min)} and ${pt(box.max)}): leave a clearance between them.`, box });
    }
  }

  // a wall nearly on a part that is not meant to go through it: the print's tolerance can close that (connectors in their openings are close on purpose)
  const collided = new Set(findings.filter((f) => f.code === 'ENC.COLLIDES').flatMap((f) => f.parts ?? []));
  const open = new Set(brief?.openings ?? []);
  for (const { name, solid } of solids) {
    if (inlays[name]) continue;
    for (const p of facts.parts) {
      if (open.has(p.ref) || collided.has(p.ref)) continue;
      const gap = solid.minGap(lib.part(p.ref), NEAR_MM + 0.01);
      if (gap < NEAR_MM) findings.push({ code: 'ENC.NEAR', severity: 'warning', message: `${name} is only ${r2(gap)} mm from ${p.ref}: printed parts come out a little off, so leave at least ${NEAR_MM} mm (or say why it may touch).`, parts: [p.ref], piece: name });
    }
  }
  return findings;
}

/** The printing checks: overhangs and wide ceilings as each piece is printed, pieces that may warp, walls too thin to print. */
export function printFindings(pieces: EnclosurePiece[], script: string, brief?: EnclosureBrief): EnclosureFinding[] {
  const findings: EnclosureFinding[] = [];
  const turns = scriptPrintRotations(script);
  const inlays = scriptInlays(script);
  // not for inlays: they lie in or on their host, which carries them, and are as thin as they are meant to be
  for (const p of pieces) {
    if (inlays[p.name]) continue;
    const tris = p.tris;
    const how = turns[p.name] ? `printed turned ${turns[p.name]!.join(', ')}` : 'printed as built (no print orientation in the script)';
    for (const x of printIssues(tris, orient(tris, turns[p.name]))) {
      findings.push(
        x.kind === 'overhang'
          ? { code: 'ENC.OVERHANG', severity: 'warning', message: `${p.name}, ${how}: ${x.area} mm² hangs over steeper than 45° between ${pt(x.box.min)} and ${pt(x.box.max)}: it needs supports. Chamfer it, or turn the piece (const print = { ${p.name}: [x, y, z] };).`, box: x.box, piece: p.name }
          : { code: 'ENC.BRIDGE', severity: 'warning', message: `${p.name}, ${how}: a ceiling ${x.size} mm across with nothing under it, between ${pt(x.box.min)} and ${pt(x.box.max)}: wider than a printer bridges (about 20 mm). Turn the piece so it lies on the bed, or support it.`, box: x.box, piece: p.name },
      );
    }
    const w = warping(tris);
    const limit = warpLimit(brief);
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
  return findings;
}
