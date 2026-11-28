/**
 * Where the boards of a design stand to one another (docs/design/multi-board.md §6): a `stack`
 * mate puts the second board where its connector meets the first's, at the mated height, turned
 * and, where both connectors are on the same side of their boards, turned over. A board placed by
 * hand (set_board placement3d: one on a cable) stands there, and what is stacked on it follows it.
 * A board neither reaches stands beside the others.
 *
 * Frame: the first board's, as its board view has it (x right, y down from its top-left corner,
 * mm), z up from its top surface. A board's place maps its own board-view point (u, v) and height
 * w above its top surface to (x, y) = R(rot)·(flipped ? −u : u, v) + (x0, y0), z = (flipped ? −w : w) + z0.
 */
import { packageOf } from '@4k7/parts';
import { FIRST_BOARD, type BoardPlace, type BoardPlacement3d, type BoardView, type Design, type Mate } from '@4k7/schema';
import { boardList, boardOf, multiBoard, resolveBoard } from './boards.ts';
import { cardOf, reject } from './doc.ts';
import { matePairs } from './mates.ts';

/** Board thickness (the 3D view's and the STEP file's). */
export const BOARD_THICKNESS = 1.6;
/** Between boards that stand beside each other (mm). */
const GAP = 10;
/** A header's height when the part says none. */
const DEFAULT_HEIGHT = 8.5;
/** Pads further apart than this after the fit do not land (mm). */
const LAND_MM = 0.3;

interface Tf {
  rot: number; // radians
  s: 1 | -1;
  x: number;
  y: number;
  z: number;
}

const ID: Tf = { rot: 0, s: 1, x: 0, y: 0, z: 0 };

/** t1 after t2: a point of t2's board into t1's frame. */
function compose(t1: Tf, t2: Tf): Tf {
  const [c, n] = [Math.cos(t1.rot), Math.sin(t1.rot)];
  const [x, y] = [t1.s * t2.x, t2.y];
  return { rot: t1.rot + t1.s * t2.rot, s: (t1.s * t2.s) as 1 | -1, x: c * x - n * y + t1.x, y: n * x + c * y + t1.y, z: t1.s * t2.z + t1.z };
}

/** The body height of a connector (from its package), else a header's. */
function heightOf(d: Design, id: string): number {
  const c = d.components[id];
  const card = c && cardOf(d, c.part);
  return (card && packageOf(card, c.params, d.packageDefaults)?.height_mm) || DEFAULT_HEIGHT;
}

/** A stack's place of b's board in a's: from the pads that meet (mated pairs), or why there is none. */
function stackPlace(d: Design, m: Mate, va: BoardView, vb: BoardView, aOn: boolean): { tf: Tf; height: number; assumed: boolean } | string {
  const [ida, idb] = aOn ? [m.a, m.b] : [m.b, m.a];
  const pa = va.parts.find((p) => p.componentId === ida);
  const pb = vb.parts.find((p) => p.componentId === idb);
  if (!pa || !pb) return 'a connector is not on its board (no footprint)';
  const { pairs, fit } = matePairs(d, m);
  if (fit) return fit;
  const pts: [number, number, number, number][] = [];
  for (const [x, y] of pairs) {
    const [na, nb] = aOn ? [x, y] : [y, x];
    const qa = pa.pads.find((q) => q.number === na);
    const qb = pb.pads.find((q) => q.number === nb);
    if (qa && qb) pts.push([qa.x, qa.y, qb.x, qb.y]);
  }
  if (!pts.length) return 'no pads to meet';
  // connectors on the same side of their boards: the second board is turned over to face the first
  const s: 1 | -1 = pa.side === pb.side ? -1 : 1;
  const mean = (k: number) => pts.reduce((t, p) => t + (k === 2 ? s * p[2] : p[k]!), 0) / pts.length;
  const [ax, ay, bx, by] = [mean(0), mean(1), mean(2), mean(3)];
  let [sc, sd] = [0, 0];
  for (const p of pts) {
    const [u, v, qx, qy] = [s * p[2] - bx, p[3] - by, p[0] - ax, p[1] - ay];
    sd += u * qx + v * qy;
    sc += u * qy - v * qx;
  }
  // a quarter turn when it is one (a header's pads are on a grid): no 89.9999°
  let rot = Math.atan2(sc, sd);
  const q = Math.round(rot / (Math.PI / 2)) * (Math.PI / 2);
  if (Math.abs(rot - q) < 1e-6) rot = q;
  const [c, n] = [Math.cos(rot), Math.sin(rot)];
  const x = ax - (c * bx - n * by);
  const y = ay - (n * bx + c * by);
  const off = Math.max(...pts.map((p) => Math.hypot(c * s * p[2] - n * p[3] + x - p[0], n * s * p[2] + c * p[3] + y - p[1])));
  if (off > LAND_MM) return `the connectors' pads do not land on each other as placed (${off.toFixed(2)} mm off)`;
  const height = m.height_mm ?? Math.max(heightOf(d, m.a), heightOf(d, m.b));
  const T = BOARD_THICKNESS;
  // the mating plane: above the first board's top, or below its underside
  const z = pa.side === 'top' ? (s === 1 ? height + T : height) : s === 1 ? -T - height : -2 * T - height;
  return { tf: { rot, s, x, y, z }, height, assumed: m.height_mm === undefined };
}

const stackMates = (d: Design) => Object.values(d.mates ?? {}).filter((m) => m.kind === 'stack' && d.components[m.a] && d.components[m.b]);

/**
 * set_board placement3d: put a board where it stands in the assembly by hand, or (null) back
 * beside the others. Refused for the first board (the frame) and for a board a stack places: one
 * whose stack mates join it to the first board or to another board placed by hand.
 */
export function placeBoard(d: Design, ref: string, p: BoardPlacement3d | null): string {
  const b = resolveBoard(d, ref);
  if (!multiBoard(d) || b.id === FIRST_BOARD) reject({ code: 'INVALID_OP', message: `"${b.name}" is the first board: the assembly is in its frame, so it stays at 0, 0, 0. Place the other boards relative to it.` });
  if (p !== null) {
    const bad = (['x', 'y', 'z', 'rot'] as const).filter((k) => !Number.isFinite(p[k]));
    if (bad.length) reject({ code: 'INVALID_OP', message: `placement3d ${bad.join(', ')} must be finite numbers (mm, rot in degrees).` });
    // the boards its stacks reach, through the stacks of those
    const stacks = stackMates(d);
    const reach = new Set([b.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const m of stacks) {
        const [x, y] = [boardOf(d, d.components[m.a]!), boardOf(d, d.components[m.b]!)];
        if (reach.has(x) === reach.has(y)) continue;
        reach.add(x).add(y);
        grew = true;
      }
    }
    const anchor = boardList(d).find((o) => o.id !== b.id && reach.has(o.id) && (o.id === FIRST_BOARD || d.boards?.[o.id]?.placement3d));
    if (anchor) {
      const own = stacks.filter((m) => [m.a, m.b].some((c) => boardOf(d, d.components[c]!) === b.id)).map((m) => `${d.components[m.a]!.refdes} ↔ ${d.components[m.b]!.refdes}`);
      reject({ code: 'INVALID_OP', message: `"${b.name}" is placed by its stack mate (${own.join(', ')}) on "${anchor.name}": the stack decides where it stands. Change the stack (its connectors' places, height_mm), or remove_mate to place it by hand.` });
    }
  }
  const e = d.boards![b.id]!;
  if (p === null) delete e.placement3d;
  else e.placement3d = { x: p.x, y: p.y, z: p.z, rot: p.rot, flipped: p.flipped };
  return p === null ? 'beside the others in the assembly' : `placed in the assembly at ${p.x}, ${p.y}, ${p.z} mm, turned ${p.rot}°${p.flipped ? ', turned over' : ''}`;
}

/** Where every board stands (first board first). `views`: each board placed (its parts and pads). */
export function assemblyOf(d: Design, views: ReadonlyMap<string, BoardView>): BoardPlace[] {
  const boards = boardList(d);
  const at = new Map<string, { tf: Tf; by: string; height?: number; assumed?: boolean }>([[FIRST_BOARD, { tf: ID, by: 'the first board' }]]);
  const notes = new Map<string, string>();
  const stacks = stackMates(d);
  // boards placed by hand, in board order: each seeds the stacks on it (a stack that reaches it first decides)
  const hand = boards.filter((b) => b.id !== FIRST_BOARD && b.placement3d);
  for (let grew = true; grew || hand.length; ) {
    if (!grew) {
      const b = hand.shift()!;
      const p = b.placement3d!;
      if (!at.has(b.id)) at.set(b.id, { tf: { rot: (p.rot * Math.PI) / 180, s: p.flipped ? -1 : 1, x: p.x, y: p.y, z: p.z }, by: 'placed (placement3d)' });
    }
    grew = false;
    for (const m of stacks) {
      const [ba, bb] = [boardOf(d, d.components[m.a]!), boardOf(d, d.components[m.b]!)];
      if (ba === bb || at.has(ba) === at.has(bb)) continue;
      const aOn = at.has(ba);
      const [from, to] = aOn ? [ba, bb] : [bb, ba];
      const [vf, vt] = [views.get(from), views.get(to)];
      if (!vf || !vt) continue;
      const r = stackPlace(d, m, vf, vt, aOn);
      const refs = `${d.components[m.a]!.refdes} ↔ ${d.components[m.b]!.refdes}`;
      if (typeof r === 'string') {
        notes.set(to, `${refs}: ${r}`);
        continue;
      }
      at.set(to, { tf: compose(at.get(from)!.tf, r.tf), by: `stacked on ${refs}`, height: r.height, assumed: r.assumed });
      grew = true;
    }
  }
  // the others beside the boards placed, left to right
  let right = 0;
  for (const b of boards) {
    const p = at.get(b.id);
    const v = views.get(b.id);
    if (!p || !v) continue;
    const { rot, s, x, y } = p.tf;
    for (const [u, w] of [[0, 0], [v.outline.w, 0], [0, v.outline.h], [v.outline.w, v.outline.h]] as const) right = Math.max(right, Math.cos(rot) * s * u - Math.sin(rot) * w + x);
  }
  for (const b of boards) {
    if (at.has(b.id)) continue;
    const v = views.get(b.id);
    const why = notes.get(b.id);
    at.set(b.id, { tf: { ...ID, x: right + GAP }, by: why ? `beside the others (not stacked: ${why})` : 'beside the others (no stack mate places it)' });
    right += GAP + (v?.outline.w ?? 0);
  }
  return boards.map((b) => {
    const p = at.get(b.id)!;
    const r2 = (v: number) => Math.round(v * 1000) / 1000;
    return {
      board: b.id,
      name: b.name,
      x: r2(p.tf.x),
      y: r2(p.tf.y),
      z: r2(p.tf.z),
      rot: r2((((p.tf.rot * 180) / Math.PI) % 360 + 360) % 360),
      flipped: p.tf.s === -1,
      by: p.by,
      ...(p.height !== undefined ? { height_mm: p.height } : {}),
      ...(p.assumed ? { height_assumed: true } : {}),
    };
  });
}
