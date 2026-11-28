/**
 * Whether the boards of a stack fit (ASM.COLLIDES, docs/design/multi-board.md §6): every part's body
 * (its body outline on the board, as tall as its 3D body) and every board's PCB as boxes in the
 * assembly frame; a part of one stacked board that runs into a part or the PCB of another is reported.
 * The two connectors of the mate joining the pair are meant to meet and are left out; so are parts
 * with no 3D body (not checked, not cleared). Boxes: a round or odd body over-reports at its corners.
 * A part that clears the other board's part or PCB directly over or under it by less than
 * STACK_CLEARANCE is ASM.CLEARANCE, a warning: connector seating, solder and part height spread eat it.
 */
import { boardBodies } from '@4k7/parts';
import type { BoardPlace, BoardView, Design, Diagnostic } from '@4k7/schema';
import { assemblyOf, BOARD_THICKNESS as T } from './assembly.ts';
import { boardOf } from './boards.ts';

type Box = { min: [number, number, number]; max: [number, number, number] };
interface Solid { ref: string; box: Box }

/** Overlaps below this are touching (mm). */
const EPS = 0.01;
/** The vertical gap under which a stacked part is too close to the other board (mm); one value for every design. */
export const STACK_CLEARANCE = 1.0;
const mm = (v: number) => (Math.round(v * 10) / 10).toFixed(1);

/** A box of board-view (u, v) and height w above the board's top into the assembly frame. */
function place(at: BoardPlace, u0: number, v0: number, u1: number, v1: number, w0: number, w1: number): Box {
  const a = (at.rot * Math.PI) / 180;
  const [c, n, s] = [Math.cos(a), Math.sin(a), at.flipped ? -1 : 1];
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [u, v] of [[u0, v0], [u1, v0], [u0, v1], [u1, v1]] as const) {
    xs.push(c * s * u - n * v + at.x);
    ys.push(n * s * u + c * v + at.y);
  }
  const zs = [s * w0 + at.z, s * w1 + at.z];
  return { min: [Math.min(...xs), Math.min(...ys), Math.min(...zs)], max: [Math.max(...xs), Math.max(...ys), Math.max(...zs)] };
}

/** The PCB and the parts with a body of a board, in the assembly frame. */
function solids(v: BoardView, at: BoardPlace, skip: Set<string>): { pcb: Box; parts: Solid[] } {
  const bodies = boardBodies(v, { fitted: true });
  const parts: Solid[] = [];
  for (const p of v.parts) {
    const body = bodies.get(p.componentId);
    if (!body || skip.has(p.componentId)) continue;
    const { x, y, w, h } = p.body;
    // above the top, or below the underside for a part on the bottom
    const [w0, w1] = p.side === 'bottom' ? [-T - body.height, -T] : [0, body.height];
    parts.push({ ref: p.refdes, box: place(at, x, y, x + w, y + h, w0, w1) });
  }
  return { pcb: place(at, 0, 0, v.outline.w, v.outline.h, -T, 0), parts };
}

/** How far two boxes overlap in x and y, and in z how far one would have to move to clear the other. */
const overlap = (a: Box, b: Box) => [
  ...[0, 1].map((i) => Math.min(a.max[i]!, b.max[i]!) - Math.max(a.min[i]!, b.min[i]!)),
  Math.min(a.max[2] - b.min[2], b.max[2] - a.min[2]),
];

/** ASM.COLLIDES and ASM.CLEARANCE between every two boards stacked or placed by hand (not those beside the others). `views`: each board placed (as assemblyOf takes them). */
export function stackCollisions(d: Design, views: ReadonlyMap<string, BoardView>): Diagnostic[] {
  if (views.size < 2) return [];
  const places = assemblyOf(d, views).filter((p) => !p.by.startsWith('beside'));
  const stacks = Object.values(d.mates ?? {}).filter((m) => m.kind === 'stack' && d.components[m.a] && d.components[m.b]);
  const anyAssumed = places.some((p) => p.height_assumed);
  const out: Diagnostic[] = [];
  for (const [i, pa] of places.entries()) {
    for (const pb of places.slice(i + 1)) {
      const [va, vb] = [views.get(pa.board)!, views.get(pb.board)!];
      // the mates joining these two boards: their connectors are meant to meet
      const joins = stacks.filter((m) => {
        const bs = [boardOf(d, d.components[m.a]!), boardOf(d, d.components[m.b]!)];
        return bs.includes(pa.board) && bs.includes(pb.board) && bs[0] !== bs[1];
      });
      const skip = new Set(joins.flatMap((m) => [m.a, m.b]));
      // the height between them is assumed if their own mate's is, or (not mated directly) any in the stack
      const assumed = joins.length ? !!(pa.height_assumed || pb.height_assumed) : anyAssumed;
      // not stacked on each other, one placed by hand: the place is what to change
      const hand = !joins.length && [pa, pb].find((p) => p.by.startsWith('placed'));
      const fix = hand ? `Move "${hand.name}" (set_board placement3d) or the part, or use a lower part.` : null;
      const [A, B] = [solids(va, pa, skip), solids(vb, pb, skip)];
      const report = (ref: string, name: string, box: Box, other: string | null, otherName: string, with_: Box) => {
        const o = overlap(box, with_);
        if (o[0]! <= EPS || o[1]! <= EPS) return;
        const entities = other ? [ref, other] : [ref];
        const what = other ? `${other} on ${otherName}` : `the PCB of ${otherName}`;
        if (o[2]! <= EPS) {
          const gap = Math.max(0, -o[2]!);
          if (gap >= STACK_CLEARANCE - EPS) return;
          out.push({
            code: 'ASM.CLEARANCE',
            severity: 'warning',
            entities,
            message:
              `${ref} on ${name} clears ${what} by only ${mm(gap)} mm (under the ${mm(STACK_CLEARANCE)} mm clearance), over ${mm(o[0]!)} × ${mm(o[1]!)} mm; connector seating, solder and part heights can close it. ` +
              (fix ??
              (assumed
                ? `The height between the boards is assumed (the taller connector's body); set the mate's height_mm from the connectors' datasheets, then move the part or raise the stack if it is still this close.`
                : `Move or turn the part, use a lower part, or raise the stack (the mate's height_mm, with taller connectors).`)),
          });
          return;
        }
        out.push({
          code: 'ASM.COLLIDES',
          severity: assumed ? 'warning' : 'error',
          entities,
          message:
            `${ref} on ${name} runs into ${what}: it reaches ${mm(o[2]!)} mm into it, over ${mm(o[0]!)} × ${mm(o[1]!)} mm. ` +
            (fix ??
            (assumed
              ? `The height between the boards is assumed (the taller connector's body); set the mate's height_mm from the connectors' datasheets, then move the part or raise the stack.`
              : `Move or turn the part, put it on the other side, use a lower part, or raise the stack (the mate's height_mm, with taller connectors).`)),
        });
      };
      for (const [own, ownName, oth, othName] of [[A, pa.name, B, pb.name], [B, pb.name, A, pa.name]] as const) {
        for (const p of own.parts) report(p.ref, ownName, p.box, null, othName, oth.pcb);
      }
      for (const p of A.parts) for (const q of B.parts) report(p.ref, pa.name, p.box, q.ref, pb.name, q.box);
    }
  }
  return out;
}

/**
 * ASM.CABLE_SHORT (docs/design/multi-board.md §6): a cable or wire mate with length_mm whose two
 * connectors stand further apart in the assembly than that, straight. Only where both boards have a
 * real place (the first board, placed by hand, or stacked from those; not beside the others).
 * A connector's mating point: the centre of its body outline, at the surface of the side it is on,
 * raised by its 3D body's height where it has one (the plug goes in at the top of the body).
 */
export function cableLengths(d: Design, views: ReadonlyMap<string, BoardView>): Diagnostic[] {
  const cables = Object.values(d.mates ?? {}).filter((m) => (m.kind === 'cable' || m.kind === 'wire') && m.length_mm && d.components[m.a] && d.components[m.b]);
  if (views.size < 2 || !cables.length) return [];
  const places = new Map(assemblyOf(d, views).filter((p) => !p.by.startsWith('beside')).map((p) => [p.board, p]));
  const point = (id: string) => {
    const at = places.get(boardOf(d, d.components[id]!));
    const v = at && views.get(at.board);
    const p = v?.parts.find((q) => q.componentId === id);
    if (!at || !v || !p) return null;
    const h = boardBodies(v, { fitted: true }).get(id)?.height ?? 0;
    const w = p.side === 'bottom' ? -T - h : h;
    const [u, t] = [p.body.x + p.body.w / 2, p.body.y + p.body.h / 2];
    const b = place(at, u, t, u, t, w, w);
    return { board: at.name, on: { x: u, y: t }, xyz: b.min };
  };
  const out: Diagnostic[] = [];
  for (const m of cables) {
    const [a, b] = [point(m.a), point(m.b)];
    if (!a || !b) continue;
    const dist = Math.hypot(...a.xyz.map((c, i) => c - b.xyz[i]!));
    if (m.length_mm! >= dist) continue;
    const [ra, rb] = [d.components[m.a]!.refdes, d.components[m.b]!.refdes];
    const [n, len] = [Math.ceil(dist), Math.round(m.length_mm!)];
    const what = m.kind === 'wire' ? `Wires ${ra}–${rb} are ${len} mm` : `Cable ${ra}–${rb} is ${len} mm`;
    // the board to move: the one placed by hand (the other is the first board or stacked)
    const move = [...places.values()].find((p) => p.name === b.board && p.by.startsWith('placed')) ?? [...places.values()].find((p) => p.name === a.board && p.by.startsWith('placed'));
    out.push({
      code: 'ASM.CABLE_SHORT',
      severity: 'error',
      entities: [ra, rb],
      at: a.on,
      message: `${what} but ${m.kind === 'wire' ? 'their' : 'its'} connectors stand ${n} mm apart in the assembly: make it at least ${n} mm (mate length_mm)${move ? ` or move "${move.name}" (set_board placement3d)` : ' or move the boards'}.`,
    });
  }
  return out;
}
