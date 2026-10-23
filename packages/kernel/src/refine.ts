/**
 * Placement refinement on a placed board, measured as get_board's placement_measures are (the
 * ratsnest, the nets on a dedicated inner plane left out): fewer crossing ratsnest lines first,
 * then a shorter ratsnest. Two searches on one model of the board:
 *
 *  - refinePlacement: the small parts the placer put down (resistors, capacitors, diodes; no part
 *    someone placed, locked or plugs a cable in) are moved a little and turned, one at a time. A
 *    part at an IC's pin (a decoupling cap) stays close to it.
 *  - exploreMain: the main parts the agent arranged are turned, shifted and swapped, each with
 *    the small parts that belong with it (as the placer moves them along), one change at a time.
 *
 * A move is tried on the model alone (the ratsnest of the nets it touches drawn again, the lines
 * that change counted against all the others), so thousands are tried in a second; the caller
 * checks the result on the placement as the placer then makes it. Every move keeps the parts
 * clear of each other and inside the outline as the placer keeps them.
 */
import { cutoutDistance, insideBoard, matingOf, padHasPin, type BoardView } from '@4k7/schema';

/** A crossing costs as much as this much more ratsnest (mm): untangling comes first. */
const CROSSING_MM = 4;
/** A part at an IC's pin: its distance to the pin counts this many times over. */
const ATTACH_WEIGHT = 3;
/** Between courtyards, as the placer keeps them (board.ts SPACING). */
const SPACING = 0.3;
/** Steps tried round a small part's place (mm), in x, y and diagonally. */
const STEPS = [0.5, 1, 2];
const ROTATIONS = [0, 90, 180, 270];
/** Shifts tried for a main part (mm); main parts this close (or of one package) are tried swapped. */
const MAIN_SHIFTS = [1, 3];
const SWAP_MM = 25;

export interface RefineMove {
  componentId: string;
  refdes: string;
  x: number;
  y: number;
  rot: number;
  was: { x: number; y: number; rot: number };
}

export interface RefineResult {
  moves: RefineMove[];
  before: { ratsnestMm: number; crossings: number };
  after: { ratsnestMm: number; crossings: number };
}

/** A local point turned clockwise (y down) by a multiple of 90° (as board.ts turns footprints). */
function rotate(x: number, y: number, rot: number): [number, number] {
  switch (((rot % 360) + 360) % 360) {
    case 90:
      return [-y, x];
    case 180:
      return [-x, -y];
    case 270:
      return [y, -x];
    default:
      return [x, y];
  }
}

/** A ratsnest line of net `net` between its members a and b (indices into the net's pads). */
type Line = { net: number; a: number; b: number; x1: number; y1: number; x2: number; y2: number };
type Pose = { x: number; y: number; rot: number };

const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
/** Two ratsnest lines of different nets cross (as placementMeasures counts them). */
function crosses(a: Line, c: Line): boolean {
  if (a.net === c.net) return false;
  if (Math.max(a.x1, a.x2) < Math.min(c.x1, c.x2) || Math.max(c.x1, c.x2) < Math.min(a.x1, a.x2) || Math.max(a.y1, a.y2) < Math.min(c.y1, c.y2) || Math.max(c.y1, c.y2) < Math.min(a.y1, a.y2)) return false;
  return orient(a.x1, a.y1, a.x2, a.y2, c.x1, c.y1) * orient(a.x1, a.y1, a.x2, a.y2, c.x2, c.y2) < 0 && orient(c.x1, c.y1, c.x2, c.y2, a.x1, a.y1) * orient(c.x1, c.y1, c.x2, c.y2, a.x2, a.y2) < 0;
}

/** The parts refinement may move: the placer's small parts (two or three pads, no connector). */
export function refinable(b: Pick<BoardView, 'parts'>): Set<string> {
  return new Set(b.parts.filter((p) => !p.componentId.startsWith('hole:') && !p.locked && !p.intent && p.pads.length >= 2 && p.pads.length <= 3 && !matingOf(p.pkgInfo)).map((p) => p.componentId));
}

/**
 * The board as the searches see it. `planeNets`: nets on a dedicated inner plane (left out);
 * `margin`: how far the placer keeps its own parts' courtyards inside the outline (parts someone
 * placed may go up to the edge clearance).
 */
function model(b: BoardView, planeNets: Set<string>, margin: number) {
  const parts = b.parts.map((p) => {
    // the pads and the courtyard as at rotation 0, round the part's centre
    const back = (360 - p.rot) % 360;
    const pads = p.pads.map((q) => {
      const [x, y] = rotate(q.x - p.x, q.y - p.y, back);
      return { x, y, net: q.netId, number: q.number, also: q.also };
    });
    const c = p.courtyard;
    const corners = [[c.x, c.y], [c.x + c.w, c.y], [c.x, c.y + c.h], [c.x + c.w, c.y + c.h]].map(([x, y]) => rotate(x! - p.x, y! - p.y, back));
    const box = [Math.min(...corners.map((q) => q[0])), Math.min(...corners.map((q) => q[1])), Math.max(...corners.map((q) => q[0])), Math.max(...corners.map((q) => q[1]))] as const;
    return { p, x: p.x, y: p.y, rot: p.rot, pads, box, tht: p.pads.some((q) => !!q.drill), placed: p.locked || !!p.intent };
  });
  const byRef = new Map(parts.map((q, i) => [q.p.refdes, i]));
  const poseOf = (i: number, over?: Map<number, Pose>) => over?.get(i) ?? parts[i]!;
  const padAt = (i: number, k: number, at: Pose = parts[i]!) => {
    const [dx, dy] = rotate(parts[i]!.pads[k]!.x, parts[i]!.pads[k]!.y, at.rot);
    return { x: at.x + dx, y: at.y + dy };
  };
  const boxAt = (i: number, at: Pose) => {
    const [x0, y0, x1, y1] = parts[i]!.box;
    const cs = [rotate(x0, y0, at.rot), rotate(x1, y1, at.rot)];
    return [at.x + Math.min(cs[0]![0], cs[1]![0]), at.y + Math.min(cs[0]![1], cs[1]![1]), at.x + Math.max(cs[0]![0], cs[1]![0]), at.y + Math.max(cs[0]![1], cs[1]![1])] as const;
  };

  // nets as small numbers, each with its pads (part, pad); the measured ones only
  const netNo = new Map<string, number>();
  const members: { i: number; k: number }[][] = [];
  parts.forEach((q, i) =>
    q.pads.forEach((pad, k) => {
      if (!pad.net || planeNets.has(pad.net)) return;
      let n = netNo.get(pad.net);
      if (n === undefined) {
        netNo.set(pad.net, (n = members.length));
        members.push([]);
      }
      members[n]!.push({ i, k });
    }),
  );
  const netsOf = parts.map((q) => [...new Set(q.pads.flatMap((x) => (x.net && netNo.has(x.net) ? [netNo.get(x.net)!] : [])))]);

  /** The net's ratsnest (minimum spanning tree, as ratsnest() draws it), the parts in `over` where it says. */
  let X = new Float64Array(256);
  let Y = new Float64Array(256);
  let D = new Float64Array(256);
  let F = new Int32Array(256);
  let U = new Uint8Array(256);
  const treeOf = (n: number, over?: Map<number, Pose>): Line[] => {
    const ms = members[n]!;
    const m = ms.length;
    if (m < 2) return [];
    if (m > X.length) [X, Y, D, F, U] = [new Float64Array(m), new Float64Array(m), new Float64Array(m), new Int32Array(m), new Uint8Array(m)];
    for (let q = 0; q < m; q++) {
      const { i, k } = ms[q]!;
      const at = padAt(i, k, poseOf(i, over));
      X[q] = at.x;
      Y[q] = at.y;
      D[q] = Math.hypot(at.x - X[0]!, at.y - Y[0]!);
      F[q] = 0;
      U[q] = 0;
    }
    U[0] = 1;
    const out: Line[] = [];
    for (let added = 1; added < m; added++) {
      let best = -1;
      for (let q = 0; q < m; q++) if (!U[q] && (best < 0 || D[q]! < D[best]!)) best = q;
      U[best] = 1;
      out.push({ net: n, a: F[best]!, b: best, x1: X[F[best]!]!, y1: Y[F[best]!]!, x2: X[best]!, y2: Y[best]! });
      const bx = X[best]!;
      const by = Y[best]!;
      for (let q = 0; q < m; q++) {
        if (U[q]) continue;
        const d = Math.hypot(X[q]! - bx, Y[q]! - by);
        if (d < D[q]!) {
          D[q] = d;
          F[q] = best;
        }
      }
    }
    return out;
  };
  const trees = members.map((_, n) => treeOf(n));
  const len = (ls: Line[]) => ls.reduce((s, l) => s + Math.hypot(l.x2 - l.x1, l.y2 - l.y1), 0);
  const measure = () => {
    const all = trees.flat();
    let crossings = 0;
    for (let a = 0; a < all.length; a++) for (let c = a + 1; c < all.length; c++) if (crosses(all[a]!, all[c]!)) crossings++;
    return { ratsnestMm: Math.round(len(all) * 10) / 10, crossings };
  };

  // a part at an IC's pin: the pad it shares with that pin, and the pin, so its distance there can be weighed
  const attach = parts.map((q) => {
    const pa = q.p.follows ? byRef.get(q.p.follows) : undefined;
    if (pa === undefined || !q.p.followsPin) return null;
    const pk = parts[pa]!.pads.findIndex((x) => padHasPin(x, q.p.followsPin!));
    const pin = parts[pa]!.pads[pk];
    const k = q.pads.findIndex((x) => !!x.net && x.net === pin?.net);
    return pin && k >= 0 ? { pa, pk, k } : null;
  });
  const attachCost = (i: number, over?: Map<number, Pose>) => {
    const a = attach[i];
    if (!a) return 0;
    const p = padAt(i, a.k, poseOf(i, over));
    const pin = padAt(a.pa, a.pk, poseOf(a.pa, over));
    return ATTACH_WEIGHT * Math.hypot(p.x - pin.x, p.y - pin.y);
  };

  /*
   * Where the parts may stand: inside the outline, clear of cutouts and of the parts they share
   * the area with. `among`: only these parts count, as movers and as obstacles (the main parts:
   * the placer puts the small parts round them again).
   */
  const { w, h } = b.outline;
  const shaped = b.cornerRadius > 0 || !!b.shape;
  const outline = { outline: b.outline, cornerRadius: b.cornerRadius, shape: b.shape };
  const fits = (over: Map<number, Pose>, among?: Set<number>) => {
    for (const [i, at] of over) {
      if (among && !among.has(i)) continue;
      const [x0, y0, x1, y1] = boxAt(i, at);
      const keep = parts[i]!.placed ? b.rules.edgeClearance : margin;
      if (x0 < keep || y0 < keep || x1 > w - keep || y1 > h - keep) return false;
      const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1], [at.x, at.y]] as const;
      if (shaped && pts.some(([px, py]) => insideBoard(outline, px, py) < keep)) return false;
      if (b.cutouts.some((c) => pts.some(([px, py]) => cutoutDistance(c, px, py) < SPACING))) return false;
      const me = parts[i]!;
      for (let j = 0; j < parts.length; j++) {
        if (j === i || (over.has(j) && j < i) || (among && !among.has(j))) continue;
        const o = parts[j]!;
        if (!me.tht && !o.tht && me.p.side !== o.p.side) continue;
        const [a0, b0, a1, b1] = boxAt(j, poseOf(j, over));
        if (x0 < a1 + SPACING - 1e-6 && a0 < x1 + SPACING - 1e-6 && y0 < b1 + SPACING - 1e-6 && b0 < y1 + SPACING - 1e-6) return false;
      }
    }
    return true;
  };

  /*
   * What moving the parts in `over` changes: their nets' trees are drawn again; the lines that
   * stay as they were (most of a big net's) cross what they crossed, so only the lines that go
   * and the lines that come are counted, against every other line.
   */
  // (a line is the same as before if it joins the same two pads and neither is on a moved part)
  const key = (l: Line) => (l.a < l.b ? l.a * 65536 + l.b : l.b * 65536 + l.a);
  const delta = (over: Map<number, Pose>) => {
    const ns = [...new Set([...over.keys()].flatMap((i) => netsOf[i]!))];
    const own = new Set(ns);
    const gone: Line[] = [];
    const come: Line[] = [];
    const kept: Line[] = [];
    for (const n of ns) {
      const ms = members[n]!;
      const still = (l: Line) => !over.has(ms[l.a]!.i) && !over.has(ms[l.b]!.i);
      const was = new Set<number>();
      for (const l of trees[n]!) if (still(l)) was.add(key(l));
      const now = new Set<number>();
      for (const l of treeOf(n, over)) {
        if (still(l) && was.has(key(l))) {
          kept.push(l);
          now.add(key(l));
        } else come.push(l);
      }
      for (const l of trees[n]!) if (!(still(l) && now.has(key(l)))) gone.push(l);
    }
    const crossingsOf = (set: Line[]) => {
      let c = 0;
      for (let a = 0; a < set.length; a++) {
        for (let b2 = a + 1; b2 < set.length; b2++) if (crosses(set[a]!, set[b2]!)) c++;
        for (const l of kept) if (crosses(set[a]!, l)) c++;
        for (let n = 0; n < trees.length; n++) {
          if (own.has(n)) continue;
          for (const l of trees[n]!) if (crosses(set[a]!, l)) c++;
        }
      }
      return c;
    };
    // the attached parts that moved, or whose pin moved
    let attached = 0;
    attach.forEach((a, i) => {
      if (a && (over.has(i) || over.has(a.pa))) attached += attachCost(i, over) - attachCost(i);
    });
    return CROSSING_MM * (crossingsOf(come) - crossingsOf(gone)) + len(come) - len(gone) + attached;
  };
  /** Take the moves in `over`. */
  const apply = (over: Map<number, Pose>) => {
    for (const [i, at] of over) Object.assign(parts[i]!, at);
    for (const n of new Set([...over.keys()].flatMap((i) => netsOf[i]!))) trees[n] = treeOf(n);
  };
  return { parts, byRef, netsOf, fits, delta, apply, measure };
}

const snap = (v: number) => Math.round(v * 10) / 10;

/**
 * Sets of moves screened on the model (suggest_moves): for each, null where the parts would not
 * fit (overlapping, off the outline), else what it changes, as the refinement weighs it (crossing
 * ratsnest lines × CROSSING_MM, plus ratsnest mm; lower is better).
 */
export function screenMoves(b: BoardView, planeNets: Set<string>, margin: number, sets: { refdes: string; x: number; y: number; rot: number }[][]): (number | null)[] {
  const m = model(b, planeNets, margin);
  return sets.map((moves) => {
    const over = new Map<number, Pose>();
    for (const mv of moves) {
      const i = m.byRef.get(mv.refdes);
      if (i === undefined) return null;
      over.set(i, { x: mv.x, y: mv.y, rot: mv.rot });
    }
    return m.fits(over) ? m.delta(over) : null;
  });
}

/**
 * Refine the placement of `movable` parts (component ids) on the placed board `b` (see the
 * header). Stops after `budgetMs`.
 */
export function refinePlacement(b: BoardView, movable: Set<string>, planeNets: Set<string>, margin: number, budgetMs = 1500): RefineResult {
  const t0 = Date.now();
  const m = model(b, planeNets, margin);
  const before = m.measure();
  const moved = new Set<number>();
  // a few sweeps over the movable parts, each taking the best place and turn round it that is better
  for (let sweep = 0; sweep < 4 && Date.now() - t0 < budgetMs; sweep++) {
    let better = false;
    for (let i = 0; i < m.parts.length && Date.now() - t0 < budgetMs; i++) {
      const q = m.parts[i]!;
      if (!movable.has(q.p.componentId) || !m.netsOf[i]!.length) continue;
      let best: { cost: number; at: Pose | null } = { cost: -0.05, at: null };
      for (const rot of ROTATIONS) {
        for (const [dx, dy] of [[0, 0], ...STEPS.flatMap((s) => [[s, 0], [-s, 0], [0, s], [0, -s], [s, s], [s, -s], [-s, s], [-s, -s]])] as const) {
          const at = { x: snap(q.x + dx), y: snap(q.y + dy), rot };
          if (dx === 0 && dy === 0 && rot === q.rot) continue;
          const over = new Map([[i, at]]);
          if (!m.fits(over)) continue;
          const c = m.delta(over);
          if (c < best.cost) best = { cost: c, at };
        }
      }
      if (!best.at) continue;
      m.apply(new Map([[i, best.at]]));
      moved.add(i);
      better = true;
    }
    if (!better) break;
  }
  const moves = [...moved]
    .map((i) => m.parts[i]!)
    .filter((q) => q.x !== q.p.x || q.y !== q.p.y || q.rot !== q.p.rot)
    .map((q) => ({ componentId: q.p.componentId, refdes: q.p.refdes, x: q.x, y: q.y, rot: q.rot, was: { x: q.p.x, y: q.p.y, rot: q.p.rot } }));
  return { moves, before, after: m.measure() };
}

/**
 * Improve the arrangement of the main parts `mains` (refdes) on the placed board `b`: each turned
 * by 90°, 180° or 270° round its centre, shifted, or two swapped (of one package, or close
 * together), always with the parts that follow it (belongs_to, as the placer moves them along).
 * The first change that helps is taken, and the search goes on round the list until a full round
 * finds none or `budgetMs` is up. Returns the main parts' new places (only those that changed).
 */
export function exploreMain(b: BoardView, mains: string[], planeNets: Set<string>, margin: number, budgetMs = 3000): RefineResult {
  const t0 = Date.now();
  const m = model(b, planeNets, margin);
  const before = m.measure();
  const main = mains.map((r) => m.byRef.get(r)).filter((i): i is number => i !== undefined);
  // each main part's followers: the parts that belong with it (directly or through another), not placed by anyone
  const followers = main.map((i) => {
    const out: number[] = [];
    const walk = (ref: string) => {
      m.parts.forEach((q, j) => {
        if (q.p.follows === ref && !q.p.locked && !main.includes(j) && !out.includes(j)) {
          out.push(j);
          walk(q.p.refdes);
        }
      });
    };
    walk(m.parts[i]!.p.refdes);
    return out;
  });
  /** The group of main part number g moved: turned by `turn` round the main part's centre, then by (dx, dy). */
  const moveGroup = (g: number, turn: number, dx: number, dy: number, over = new Map<number, Pose>()) => {
    const c = m.parts[main[g]!]!;
    for (const j of [main[g]!, ...followers[g]!]) {
      const q = m.parts[j]!;
      const [ox, oy] = rotate(q.x - c.x, q.y - c.y, turn);
      over.set(j, { x: snap(c.x + ox + dx), y: snap(c.y + oy + dy), rot: (q.rot + turn) % 360 });
    }
    return over;
  };
  const pkg = (g: number) => m.parts[main[g]!]!.p.pkg;
  const near = (g: number, k: number) => Math.hypot(m.parts[main[g]!]!.x - m.parts[main[k]!]!.x, m.parts[main[g]!]!.y - m.parts[main[k]!]!.y) <= SWAP_MM;
  const changes: (() => Map<number, Pose>)[] = [];
  main.forEach((_, g) => {
    for (const turn of [90, 180, 270]) changes.push(() => moveGroup(g, turn, 0, 0));
    for (const s of MAIN_SHIFTS) for (const [dx, dy] of [[s, 0], [-s, 0], [0, s], [0, -s]] as const) changes.push(() => moveGroup(g, 0, dx, dy));
  });
  main.forEach((_, g) => {
    for (let k = g + 1; k < main.length; k++) {
      if (pkg(g) !== pkg(k) && !near(g, k)) continue;
      changes.push(() => {
        const [a, c] = [m.parts[main[g]!]!, m.parts[main[k]!]!];
        return moveGroup(k, 0, a.x - c.x, a.y - c.y, moveGroup(g, 0, c.x - a.x, c.y - a.y));
      });
    }
  });
  // obstacles: the main parts, and what stays where it is whatever happens (locked, holes, placed by someone)
  const among = new Set(m.parts.flatMap((q, j) => (main.includes(j) || q.placed || q.p.componentId.startsWith('hole:') ? [j] : [])));
  for (let v = 0, since = 0; changes.length && since < changes.length && Date.now() - t0 < budgetMs; v = (v + 1) % changes.length, since++) {
    const over = changes[v]!();
    if (!m.fits(over, among) || m.delta(over) >= -0.5) continue;
    m.apply(over);
    since = 0;
  }
  const moves = main
    .map((i) => m.parts[i]!)
    .filter((q) => q.x !== q.p.x || q.y !== q.p.y || q.rot !== q.p.rot)
    .map((q) => ({ componentId: q.p.componentId, refdes: q.p.refdes, x: q.x, y: q.y, rot: q.rot, was: { x: q.p.x, y: q.p.y, rot: q.p.rot } }));
  return { moves, before, after: m.measure() };
}
