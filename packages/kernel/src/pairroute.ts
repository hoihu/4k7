/**
 * Lines at a set impedance, routed first (docs/design/impedance.md §6). The maze router knows one
 * net at a time, so a pair is routed as one fat track along its centre line: the two nets' pads are
 * joined in a stand-in net, a virtual pad sits between each two, and the search runs for a track
 * as wide as the pair (2 × width + gap) from one virtual pad to the other. The two tracks are then
 * drawn either side of the centre line it found, `half = (width + gap) / 2` off it with mitred
 * corners, each coming in from its pad at 45° (as draw_pair does); where the centre line changes
 * layer, the pair changes together, a via for each track side by side. The result is checked
 * exactly against all other copper; a pair that does not come out clean is routed as two nets after
 * all, with the reason recorded (RouteResult.lines). The copper then goes to the main run as drawn
 * copper, which also keeps the other nets off the plane under it (RouteInput.lines).
 *
 * A single line (one net) is routed ahead of the others for the same reason: the plane under it is
 * kept whole. If the frozen copper leaves a connection of another net open, the lines are routed
 * once more with everything else, and that is kept if it is better.
 */
import type { BoardPad, BoardPart, CopperLayer, RoutedLine, Track, Via } from '@4k7/schema';
import { firstClash, type Geometry } from './copperclear.ts';
import type { RouteInput, RouteResult } from './router.ts';

type Rule = NonNullable<RouteInput['controlled']>[number];
type Run = (input: RouteInput, passes?: number) => RouteResult;
interface Pt {
  x: number;
  y: number;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
/** A centre line's end is the virtual pad's centre, found within this of it, mm. */
const AT = 0.15;
/** Passes of a stand-in search (it routes one connection: more passes do not help). */
const SUB_PASSES = 3;
/** The longest a stand-in search may take, ms. */
const SUB_BUDGET_MS = 10_000;
/** Pads of a pair closer together than this (mm) are the two ends of one pair. */
const MATE_MM = 6;
/** A 90° corner of the centre line is cut into two 45° ones, each this long (mm) at most. */
const CUT_MM = 0.8;

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/* ------------------------------ the centre line ---------------------------- */

interface Piece {
  ux: number;
  uy: number;
  nx: number;
  ny: number;
  len: number;
}

const piecesOf = (c: Pt[]): Piece[] =>
  c.slice(1).map((q, i) => {
    const len = Math.hypot(q.x - c[i]!.x, q.y - c[i]!.y);
    const [ux, uy] = [(q.x - c[i]!.x) / len, (q.y - c[i]!.y) / len];
    return { ux, uy, nx: -uy, ny: ux, len };
  });

/** A centre line without repeated points and without points where it runs straight on. */
function tidy(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    if (out.length && dist(out.at(-1)!, p) < 1e-6) continue;
    if (out.length >= 2) {
      const [a, b] = [out.at(-2)!, out.at(-1)!];
      const cross = (b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x);
      const dot = (b.x - a.x) * (p.x - b.x) + (b.y - a.y) * (p.y - b.y);
      if (dot > 0 && Math.abs(cross) <= 0.002 * Math.hypot(b.x - a.x, b.y - a.y)) {
        out[out.length - 1] = p;
        continue;
      }
    }
    out.push(p);
  }
  return out;
}

/** The centre line with each corner sharper than 46° cut into two 45° ones, where the pieces are long enough. */
function chamfered(c: Pt[]): Pt[] {
  const out: Pt[] = [c[0]!];
  const d = piecesOf(c);
  for (let i = 1; i + 1 < c.length; i++) {
    const [p, q] = [d[i - 1]!, d[i]!];
    const turn = Math.acos(Math.max(-1, Math.min(1, p.ux * q.ux + p.uy * q.uy)));
    const cut = Math.min(CUT_MM, (i === 1 ? p.len : p.len / 2) - 0.05, (i + 2 === c.length ? q.len : q.len / 2) - 0.05);
    if (turn > (46 * Math.PI) / 180 && turn < (100 * Math.PI) / 180 && cut > 0.1) out.push({ x: c[i]!.x - p.ux * cut, y: c[i]!.y - p.uy * cut }, { x: c[i]!.x + q.ux * cut, y: c[i]!.y + q.uy * cut });
    else out.push(c[i]!);
  }
  out.push(c.at(-1)!);
  return out;
}

/**
 * The centre line with its first piece lengthened to `need`, by sliding the first jog (a 45° piece
 * between two parallel ones) along it; null where the line has no such jog or no room for it.
 */
function slidStart(c: Pt[], need: number): Pt[] | null {
  if (c.length < 4) return null;
  const d = piecesOf(c);
  const [p, q, r] = [d[0]!, d[1]!, d[2]!];
  if (p.ux * r.ux + p.uy * r.uy < 0.999 || Math.abs(p.ux * q.ux + p.uy * q.uy) < 0.7 || Math.abs(p.ux * q.ux + p.uy * q.uy) > 0.72) return null;
  const by = need - p.len + 0.2;
  if (by <= 0 || r.len - by < 0.3) return null;
  return [c[0]!, { x: c[1]!.x + p.ux * by, y: c[1]!.y + p.uy * by }, { x: c[2]!.x + p.ux * by, y: c[2]!.y + p.uy * by }, ...c.slice(3)];
}

/** Which side of the first piece the positive track's end lies on, relative to the negative one's: +1 along the normal, -1 against it, 0 none. */
const sideAt = (o: Pt, u: Piece, ends: [Pt, Pt]) => Math.sign((ends[0].x - o.x) * u.nx + (ends[0].y - o.y) * u.ny - ((ends[1].x - o.x) * u.nx + (ends[1].y - o.y) * u.ny));

/**
 * The two tracks of a pair along a centre line `c`, `half` off it with mitred corners: each from its
 * start (`from`, positive first) in at 45° to its side of the line, and out at 45° to its end (`to`).
 * The positive track keeps to the side its start lies on. Or why it cannot be done.
 */
export function pairAlong(c: Pt[], from: [Pt, Pt], to: [Pt, Pt], half: number): { pts: [number[], number[]] } | { why: string; short?: { end: 'start' | 'end'; need: number } } {
  c = tidy(c);
  if (c.length < 2) return { why: 'the centre line is a point' };
  const dirs = piecesOf(c);
  for (let i = 1; i < dirs.length; i++) if (dirs[i - 1]!.ux * dirs[i]!.ux + dirs[i - 1]!.uy * dirs[i]!.uy < -1e-6) return { why: `the centre line turns back on itself at ${r3(c[i]!.x)}, ${r3(c[i]!.y)}` };
  const first = dirs[0]!;
  const last = dirs.at(-1)!;
  const lat = (e: Pt, o: Pt, u: Piece) => (e.x - o.x) * u.nx + (e.y - o.y) * u.ny;
  const sideStart = sideAt(c[0]!, first, from);
  const sideEnd = sideAt(c.at(-1)!, last, to);
  if (!sideStart || !sideEnd) return { why: 'the centre line leaves between the two pads along the line joining them' };
  if (sideStart !== sideEnd) return { why: 'the two tracks would cross' };
  const offs = [sideStart * half, -sideStart * half];
  // how far along the first (last) piece the tracks need to come in from their ends at 45°
  const reach = (ends: [Pt, Pt], o: Pt, u: Piece, sign: number) => Math.max(...ends.map((e, k) => sign * ((e.x - o.x) * u.ux + (e.y - o.y) * u.uy) + Math.abs(offs[k]! - lat(e, o, u))));
  const inAt = Math.max(0, reach(from, c[0]!, first, 1));
  const outAt = Math.max(0, reach(to, c.at(-1)!, last, -1));
  const setback = (j: number) => {
    if (j <= 0 || j >= c.length - 1) return 0;
    const [p, q] = [dirs[j - 1]!, dirs[j]!];
    return half * Math.tan(Math.acos(Math.max(-1, Math.min(1, p.ux * q.ux + p.uy * q.uy))) / 2);
  };
  for (let i = 0; i < dirs.length; i++) {
    const [a, b] = [i === 0 ? inAt : setback(i), i === dirs.length - 1 ? outAt : setback(i + 1)];
    if (dirs[i]!.len + 1e-6 < a + b) {
      const end = i === 0 ? 'start' : i === dirs.length - 1 ? 'end' : undefined;
      return { why: `a piece of the centre line at ${r3(c[i]!.x)}, ${r3(c[i]!.y)} is ${r3(dirs[i]!.len)} mm, the tracks need ${r3(a + b)} mm there to turn at its corners and to come in from the pads`, ...(end && dirs.length > 1 ? { short: { end, need: a + b } } : {}) };
    }
  }
  const pts = [0, 1].map((k) => {
    const o = offs[k]!;
    const [e0, e1] = [from[k]!, to[k]!];
    const d0 = o - lat(e0, c[0]!, first);
    const a0 = { x: e0.x + first.ux * Math.abs(d0) + first.nx * d0, y: e0.y + first.uy * Math.abs(d0) + first.ny * d0 };
    const j0 = { x: c[0]!.x + first.ux * inAt + first.nx * o, y: c[0]!.y + first.uy * inAt + first.ny * o };
    const corners = c.slice(1, -1).map((q, i) => {
      const [n1, n2] = [dirs[i]!, dirs[i + 1]!];
      const k2 = 1 + n1.nx * n2.nx + n1.ny * n2.ny;
      return { x: q.x + (o * (n1.nx + n2.nx)) / k2, y: q.y + (o * (n1.ny + n2.ny)) / k2 };
    });
    const cl = c.at(-1)!;
    const d1 = o - lat(e1, cl, last);
    const j1 = { x: cl.x - last.ux * outAt + last.nx * o, y: cl.y - last.uy * outAt + last.ny * o };
    const a1 = { x: e1.x - last.ux * Math.abs(d1) + last.nx * d1, y: e1.y - last.uy * Math.abs(d1) + last.ny * d1 };
    return tidy([e0, a0, j0, ...corners, j1, a1, e1]).flatMap((q) => [r3(q.x), r3(q.y)]);
  });
  return { pts: pts as [number[], number[]] };
}

/* ------------------------------ one coupled pair --------------------------- */

interface Chain {
  /** The centre line per layer, in order from the first virtual pad. */
  segs: { layer: CopperLayer; pts: Pt[] }[];
  /** The vias between them. */
  vias: Via[];
}

/** The path a stand-in search found as one chain from `a` to `b`, or null where the pieces do not join up. */
function chainOf(tracks: Track[], vias: Via[], a: Pt, b: Pt): Chain | null {
  const used = new Set<Track>();
  const out: Chain = { segs: [], vias: [] };
  let cur = a;
  for (let guard = 0; guard < 64; guard++) {
    const next = tracks.find((t) => !used.has(t) && (dist({ x: t.pts[0]!, y: t.pts[1]! }, cur) < AT || dist({ x: t.pts.at(-2)!, y: t.pts.at(-1)! }, cur) < AT) && t.layer !== out.segs.at(-1)?.layer);
    if (!next) return null;
    used.add(next);
    const pts: Pt[] = Array.from({ length: next.pts.length / 2 }, (_, i) => ({ x: next.pts[2 * i]!, y: next.pts[2 * i + 1]! }));
    if (dist(pts[0]!, cur) >= AT) pts.reverse();
    out.segs.push({ layer: next.layer, pts });
    cur = pts.at(-1)!;
    if (dist(cur, b) < AT) return used.size === tracks.length ? out : null;
    const via = vias.find((v) => dist(v, cur) <= v.pad / 2 + 0.01);
    if (!via) return null;
    out.vias.push(via);
    cur = { x: via.x, y: via.y };
  }
  return null;
}

/** The same pad of the pair, relabelled to the stand-in net so its centre line may end on both. */
const relabel = (parts: BoardPart[], nets: Set<string>, to: string): BoardPart[] =>
  parts.map((p) => (p.pads.some((q) => q.netId && nets.has(q.netId)) ? { ...p, pads: p.pads.map((q) => (q.netId && nets.has(q.netId) ? { ...q, netId: to } : q)) } : p));

/** What a coupled pair needs of the board and the copper laid so far. */
interface Ctx {
  input: RouteInput;
  geo: Geometry;
  run: Run;
  /** Copper in the way: the drawn copper and what the lines before were frozen as. */
  tracks: Track[];
  vias: Via[];
  /** Net names for messages. */
  name: (id: string) => string;
}

/** Pairs the pads of the positive net with those of the negative one, nearest first; null where they do not pair up. */
function matePads(pos: BoardPad[], neg: BoardPad[]): [BoardPad, BoardPad][] | null {
  if (pos.length !== neg.length || pos.length < 2 || pos.length > 4) return null;
  const left = [...neg];
  const out: [BoardPad, BoardPad][] = [];
  for (const p of pos) {
    left.sort((a, b) => dist(a, p) - dist(b, p));
    const n = left.shift()!;
    if (dist(n, p) > MATE_MM) return null;
    out.push([p, n]);
  }
  return out;
}

/** The pad pairs in the order of a minimum spanning tree from the first, as edges (i, j). */
function chainEdges(mid: Pt[]): [number, number][] {
  const out: [number, number][] = [];
  const done = new Set([0]);
  while (done.size < mid.length) {
    let best: [number, number] | null = null;
    for (const i of done) for (let j = 0; j < mid.length; j++) if (!done.has(j) && (!best || dist(mid[i]!, mid[j]!) < dist(mid[best[0]]!, mid[best[1]]!))) best = [i, j];
    out.push(best!);
    done.add(best![1]);
  }
  return out;
}

/**
 * One pair coupled: its copper (tracks and vias of the two nets), or why it stays two nets.
 * `rule.nets` is positive first.
 */
function couple(cx: Ctx, rule: Rule): { tracks: Track[]; vias: Via[] } | { why: string } {
  const { input, geo, name } = cx;
  const [pn, nn] = rule.nets as [string, string];
  const all = input.parts.flatMap((p) => p.pads);
  const pairs = matePads(all.filter((p) => p.netId === pn), all.filter((p) => p.netId === nn));
  if (!pairs) return { why: `the pads of ${name(pn)} and ${name(nn)} do not pair up (two to four each, side by side)` };
  if (!rule.layers.length) return { why: 'the rule cannot be built on any layer' };
  const wide = Math.max(...rule.layers.map((l) => 2 * l.width + (l.gap ?? 0)));
  const stand = `pair:${rule.id}`;
  const viaPitch = input.rules.viaPad + geo.rules.clearance + 0.02;
  const mid = pairs.map(([p, n]) => ({ x: (p.x + n.x) / 2, y: (p.y + n.y) / 2 }));
  const own: { tracks: Track[]; vias: Via[] } = { tracks: [], vias: [] };
  for (const [k, [i, j]] of chainEdges(mid).entries()) {
    const virt = [i, j].map((n): BoardPad => {
      const [p, q] = pairs[n]!;
      const on = (x: BoardPad) => (x.drill ? geo.layers : x.layers);
      const layers = on(p).filter((l) => on(q).includes(l));
      return { number: `~${k}.${n}`, x: mid[n]!.x, y: mid[n]!.y, w: wide, h: wide, shape: 'rect', netId: stand, layers };
    }) as [BoardPad, BoardPad];
    if (!virt[0].layers.length || !virt[1].layers.length) return { why: `the pads of ${name(pn)} and ${name(nn)} share no copper layer` };
    const known = { tracks: [...cx.tracks, ...own.tracks], vias: [...cx.vias, ...own.vias] };
    // an outer layer the rule cannot be built on takes nothing of the pair: shut with one wide track of a net of its own
    // (the router takes copper of nets that have a pad: a pad in the corner, off the board's copper)
    const reach = 2 * Math.max(input.outline.w, input.outline.h);
    const shutNet = `${stand}:shut`;
    const shut: Track[] = input.layers.filter((l) => (l === 'F.Cu' || l === 'B.Cu') && !rule.layers.some((x) => x.layer === l)).map((layer) => ({ netId: shutNet, layer, width: reach, pts: [0, 0, input.outline.w, input.outline.h] }));
    const corner: BoardPad[] = shut.length ? [{ number: '~shut', x: 0, y: 0, w: 0.1, h: 0.1, shape: 'rect', netId: shutNet, layers: [shut[0]!.layer] }] : [];
    const subParts = [...relabel(input.parts, new Set([pn, nn]), stand), { ...input.parts[0]!, componentId: stand, refdes: '~', pads: [...virt, ...corner] }];
    const sub: RouteInput = {
      ...input,
      parts: subParts,
      netWidths: { ...input.netWidths, [stand]: wide },
      drawn: { tracks: [...known.tracks, ...shut], vias: known.vias, only: { pairs: [virt] } },
      controlled: undefined,
      keep: undefined,
      onProgress: undefined,
      onBest: undefined,
      budgetMs: Math.min(input.budgetMs ?? SUB_BUDGET_MS, SUB_BUDGET_MS),
      ...(input.vias ? { vias: { ...input.vias, fill: [], along: [], drops: [] } } : {}),
      // (an inner layer the rule does not cover takes no track of the pair: closed like a plane)
      planes: [...(input.planes ?? []), ...input.layers.filter((l) => l !== 'F.Cu' && l !== 'B.Cu' && !rule.layers.some((x) => x.layer === l) && !(input.planes ?? []).some((q) => q.layer === l && !q.area)).map((layer) => ({ netId: stand, layer }))],
    };
    const r = cx.run(sub, SUB_PASSES);
    if (!r.connected(stand, virt[0], virt[1])) {
      // (the stand-in's other pads, the real ones, are open by design: the one asked for is the pair of virtual pads)
      const open = r.failed.find((f) => f.netId === stand && (f.a === virt[0] || f.b === virt[0] || f.a === virt[1] || f.b === virt[1]));
      const why = open?.blockedBy?.length ? `${open.blockedBy.map(name).join(', ')} in the way` : open?.enclosed ? 'its pads are closed off' : 'no way found';
      return { why: `no way for the two tracks side by side (${why})` };
    }
    const seen = new Set<object>(known.tracks);
    const seenVia = new Set<object>(known.vias);
    const made = r.tracks.filter((t) => t.netId === stand && !seen.has(t));
    const viasMade = r.vias.filter((v) => v.netId === stand && !seenVia.has(v));
    const chain = chainOf(made, viasMade, mid[i]!, mid[j]!);
    if (!chain) return { why: 'the centre line the search found does not join up' };
    const res = derive(cx, rule, chain, [pairs[i]!, pairs[j]!], viaPitch);
    if ('why' in res) return res;
    own.tracks.push(...res.tracks);
    own.vias.push(...res.vias);
  }
  return own;
}

/** Where a chain's centre line has a piece too short for the tracks to come together or turn: segment s, its start or end, mm needed. */
interface Short {
  s: number;
  end: 'start' | 'end';
  need: number;
}

/**
 * Lengthens the short piece at `at` by moving what ends it along the line: a via of the chain (the
 * centre line goes straight through it, so it slides along the line), or at a pad the first jog.
 * False where there is no room for that.
 */
function lengthen(ch: Chain, at: Short): boolean {
  const seg = ch.segs[at.s]!;
  const pts = tidy(seg.pts);
  // the piece at that end, pointing away from the end
  const toward = at.end === 'start' ? pts : pts.slice().reverse();
  const u = piecesOf(toward.slice(0, 2))[0]!;
  const j = at.end === 'start' ? at.s - 1 : at.s;
  const via = ch.vias[j];
  if (!via || j < 0) {
    const moved = slidStart(toward, at.need);
    if (!moved) return false;
    seg.pts = at.end === 'start' ? moved : moved.reverse();
    return true;
  }
  const by = at.need - u.len + 0.1;
  // the neighbour on the other side of the via keeps room for its own needs
  const other = tidy(at.end === 'start' ? ch.segs[at.s - 1]!.pts.slice().reverse() : ch.segs[at.s + 1]!.pts);
  const v = piecesOf(other.slice(0, 2))[0]!;
  if (by <= 0 || v.len - by < 1.3) return false;
  // the via moves away from the short piece's far end, into the neighbour
  via.x = r3(via.x - u.ux * by);
  via.y = r3(via.y - u.uy * by);
  ch.segs[j]!.pts = [...tidy(ch.segs[j]!.pts).slice(0, -1), { x: via.x, y: via.y }];
  ch.segs[j + 1]!.pts = [{ x: via.x, y: via.y }, ...tidy(ch.segs[j + 1]!.pts).slice(1)];
  return true;
}

/** The pair's tracks and vias along a centre line chain, checked against everything else. */
function derive(cx: Ctx, rule: Rule, chain: Chain, ends: [[BoardPad, BoardPad], [BoardPad, BoardPad]], viaPitch: number): { tracks: Track[]; vias: Via[] } | { why: string } {
  let why = '';
  for (const cut of [true, false]) {
    const ch: Chain = { segs: chain.segs.map((g) => ({ ...g, pts: g.pts.map((q) => ({ ...q })) })), vias: chain.vias.map((v) => ({ ...v })) };
    for (let fix = 0; fix < 8; fix++) {
      const res = attempt(cx, rule, ch, ends, viaPitch, cut);
      if (!('why' in res)) return res;
      why = res.why;
      if (!res.short || !lengthen(ch, res.short)) break;
    }
  }
  return { why };
}

/** One try at deriving the pair along the chain (the centre line with its corners cut, or as found). */
function attempt(cx: Ctx, rule: Rule, chain: Chain, ends: [[BoardPad, BoardPad], [BoardPad, BoardPad]], viaPitch: number, cut: boolean): { tracks: Track[]; vias: Via[] } | { why: string; short?: Short } {
  const { input, geo, name } = cx;
  const [pn, nn] = rule.nets as [string, string];
  const tracks: Track[] = [];
  const vias: Via[] = [];
  let from: [Pt, Pt] = ends[0];
  for (const [s, seg] of chain.segs.entries()) {
    const lay = rule.layers.find((l) => l.layer === seg.layer);
    if (!lay) return { why: `${seg.layer} cannot carry this pair` };
    const half = (lay.width + (lay.gap ?? 0)) / 2;
    const c = cut ? chamfered(tidy(seg.pts)) : tidy(seg.pts);
    let to: [Pt, Pt];
    const v = chain.vias[s];
    if (v) {
      // the vias side by side across the centre line, the positive track's on its side
      const u = piecesOf(c.slice(-2))[0]!;
      const un = piecesOf(chain.segs[s + 1]!.pts.slice(0, 2))[0]!;
      if (u.ux * un.ux + u.uy * un.uy < 0.995) return { why: 'the centre line turns at its via' };
      const side = sideAt(c[0]!, piecesOf(c)[0]!, from);
      const h = Math.max(viaPitch, 2 * half) / 2;
      to = [
        { x: v.x + side * h * u.nx, y: v.y + side * h * u.ny },
        { x: v.x - side * h * u.nx, y: v.y - side * h * u.ny },
      ];
      vias.push({ netId: pn, x: r3(to[0].x), y: r3(to[0].y), drill: v.drill, pad: v.pad }, { netId: nn, x: r3(to[1].x), y: r3(to[1].y), drill: v.drill, pad: v.pad });
    } else to = ends[1];
    const res = pairAlong(c, from, to, half);
    if ('why' in res) return { why: res.why, ...(res.short ? { short: { s, end: res.short.end, need: res.short.need } } : {}) };
    tracks.push({ netId: pn, layer: seg.layer, width: lay.width, pts: res.pts[0] }, { netId: nn, layer: seg.layer, width: lay.width, pts: res.pts[1] });
    from = to;
  }
  // exactly against all other copper, and the two nets of the pair against each other
  const existing = { parts: input.parts, tracks: [...cx.tracks, ...tracks], vias: [...cx.vias, ...vias] };
  for (const net of [pn, nn]) {
    const hit = firstClash(geo, existing, net, { tracks: tracks.filter((t) => t.netId === net), vias: vias.filter((x) => x.netId === net) }, { name });
    if (hit) return { why: `its copper would come ${Math.max(0, Math.round(hit.gap * 100) / 100)} mm from ${hit.what} at ${r3(hit.x)}, ${r3(hit.y)}` };
  }
  return { tracks, vias };
}

/* ------------------------------- the whole run ----------------------------- */

/**
 * Routes the lines at a set impedance first, then everything else round them with `run` (the plain
 * router). Pairs are coupled; single lines are routed ahead of the rest. See the file header.
 */
export function routeLines(input: RouteInput, passes: number, run: Run): RouteResult {
  const only = input.drawn?.only;
  // (a single connection asked for, or drawn copper with nothing to route: no lines of its own)
  if (only?.pairs || (input.drawn && !only?.nets) || input.keep) return run(input, passes);
  const allPads = input.parts.flatMap((p) => p.pads);
  const withPads = new Set(allPads.flatMap((p) => (p.netId ? [p.netId] : [])));
  const scope = new Set(only?.nets ?? withPads);
  const drawnNets = new Set([...(input.drawn?.tracks ?? []), ...(input.drawn?.vias ?? [])].map((x) => x.netId));
  const geo: Geometry = { outline: input.outline, cornerRadius: input.cornerRadius, shape: input.shape, cutouts: input.cutouts, layers: input.layers, rules: input.rules };
  const name = (id: string) => input.netNames?.[id] ?? id;
  const lines: RoutedLine[] = [];
  const frozen: { rule: Rule; tracks: Track[]; vias: Via[] }[] = [];
  const cx: Ctx = { input, geo, run, tracks: [...(input.drawn?.tracks ?? [])], vias: [...(input.drawn?.vias ?? [])], name };
  const todo = input.controlled!.filter((r) => r.layers.length && r.nets.every((n) => scope.has(n) && withPads.has(n)));
  const singles: Rule[] = [];
  for (const rule of todo) {
    if (rule.nets.some((n) => drawnNets.has(n))) continue;
    if (rule.nets.length === 1) {
      singles.push(rule);
      continue;
    }
    if (rule.nets.length !== 2 || rule.layers.every((l) => l.gap === undefined)) continue;
    const res = couple(cx, rule);
    if ('why' in res) {
      lines.push({ id: rule.id, nets: rule.nets, coupled: false, why: res.why });
      continue;
    }
    frozen.push({ rule, ...res });
    cx.tracks.push(...res.tracks);
    cx.vias.push(...res.vias);
    lines.push({ id: rule.id, nets: rule.nets, coupled: true });
  }
  // single lines before the rest, if there is a rest to keep off the plane under them
  const rest = [...scope].filter((n) => !todo.some((r) => r.nets.includes(n)));
  if (singles.length && rest.length) {
    const nets = singles.flatMap((r) => r.nets);
    const sub: RouteInput = { ...input, controlled: undefined, keep: undefined, onProgress: undefined, onBest: undefined, drawn: { tracks: cx.tracks, vias: cx.vias, only: { nets } }, budgetMs: Math.min(input.budgetMs ?? SUB_BUDGET_MS, SUB_BUDGET_MS) };
    const r = run(sub, passes);
    const failed = new Set(r.failed.map((f) => f.netId));
    const seen = new Set<object>([...cx.tracks, ...cx.vias]);
    for (const rule of singles) {
      if (rule.nets.some((n) => failed.has(n))) {
        lines.push({ id: rule.id, nets: rule.nets, coupled: false, why: 'routed with the other nets: not all of it could be routed first' });
        continue;
      }
      const mine = (x: { netId: string }) => rule.nets.includes(x.netId);
      const f = { rule, tracks: r.tracks.filter((t) => mine(t) && !seen.has(t)), vias: r.vias.filter((v) => mine(v) && !seen.has(v)) };
      frozen.push(f);
      cx.tracks.push(...f.tracks);
      cx.vias.push(...f.vias);
      lines.push({ id: rule.id, nets: rule.nets, coupled: false });
    }
  }
  if (!frozen.length) {
    const r = run(input, passes);
    return lines.length ? { ...r, lines } : r;
  }
  const mainOf = (list: typeof frozen): RouteInput => {
    const done = new Set(list.flatMap((f) => f.rule.nets));
    return {
      ...input,
      drawn: {
        tracks: [...(input.drawn?.tracks ?? []), ...list.flatMap((f) => f.tracks)],
        vias: [...(input.drawn?.vias ?? []), ...list.flatMap((f) => f.vias)],
        only: { nets: [...scope].filter((n) => !done.has(n)) },
      },
    };
  };
  let r = run(mainOf(frozen), passes);
  // a line that left another net's connection open is not worth it if routing it with the rest does better
  const blocking = frozen.filter((f) => r.failed.some((x) => x.blockedBy?.some((n) => f.rule.nets.includes(n))));
  if (blocking.length) {
    const r2 = run(mainOf(frozen.filter((f) => !blocking.includes(f))), passes);
    const better = r2.failed.length < r.failed.length;
    const inWay = [...new Set(r.failed.flatMap((x) => x.blockedBy ?? []))].filter((n) => blocking.some((f) => f.rule.nets.includes(n)));
    const left = `${r.failed.length} connection${r.failed.length === 1 ? '' : 's'} open (${inWay.map(name).join(', ')} in the way)`;
    for (const f of blocking) {
      const l = lines.find((x) => x.id === f.rule.id)!;
      const pair = f.rule.nets.length === 2;
      if (better) Object.assign(l, { coupled: false, why: `${pair ? 'kept together' : 'routed first'} it left ${left}; ${pair ? 'routed apart' : 'routed with the rest'} ${r2.failed.length} are open` });
      else l.why = `${pair ? 'kept together' : 'routed first'} it left ${left}, and routing ${pair ? 'it apart' : 'it with the rest'} did not help`;
    }
    if (better) r = r2;
  }
  return { ...r, lines };
}
