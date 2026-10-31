/**
 * Length tuning (docs/design/impedance.md §6): `tune_length` adds a meander to a drawn track until
 * its net is as long as asked, or as long as a partner or a group. The meander is a row of square
 * bumps with 45° corners on one side of a straight stretch of the track, on its own layer, its legs
 * `gap` apart edge to edge (3 widths at least, more where the net's rule keeps other signals
 * further off), clear of all other copper. IMP.SKEW and IMP.LENGTH are the checks that hold the result.
 */
import type { Design, DrawnTrack, EditOp, ImpedanceView, OpResult } from '@4k7/schema';
import { placedOf } from './board.ts';
import { firstClash, nearBox } from './copperclear.ts';
import { drawnOf } from './copperops.ts';
import { findNet, reject } from './doc.ts';
import { pointSegDist, r3, segmentsOf, segSegDist } from './geom.ts';
import { DEFAULT_SKEW, keepOf, trackLength } from './lines.ts';

const f2 = (v: number) => String(Math.round(v * 100) / 100);
const SQ2 = Math.SQRT2;
/** A bump's corners are cut by this many widths (a pair member's: half as many); smaller bumps cut less, down to CHAMFER_MIN. */
const CHAMFER = 1;
const CHAMFER_MIN = 0.3;
/** The straight part of a bump's legs, in widths, at least. */
const LEG = 0.5;
/** The tallest bump of a single line, mm (a pair member's: twice the pair's gap). */
const MAX_HEIGHT = 4;
/** Steps in which a bump's height is tried down from the tallest, mm. */
const HEIGHT_STEP = 0.1;
/** Rounds of meanders on one track when no stretch has room for all of it. */
const ROUNDS = 6;
/** The default tolerance on the length reached, mm. */
const TOLERANCE = 0.1;

/** A straight stretch of a track to meander in: piece i, from (ax, ay) along the unit vector (ux, uy). */
interface Slot {
  i: number;
  ax: number;
  ay: number;
  ux: number;
  uy: number;
  len: number;
}

/** A row of bumps in a slot. */
interface Plan {
  slot: Slot;
  side: 1 | -1;
  /** Bumps (each two legs). */
  m: number;
  h: number;
  /** Where the first leg stands along the slot, mm from its start. */
  s0: number;
}

/** The new points between the slot's ends for a plan (flat). */
function meanderPts(pl: Plan, cOf: (h: number) => number, p: number): number[] {
  const { slot: s, side } = pl;
  const [nx, ny] = [-s.uy * side, s.ux * side];
  const out: number[] = [];
  const c = cOf(pl.h);
  const at = (a: number, t: number) => out.push(r3(s.ax + s.ux * a + nx * t), r3(s.ay + s.uy * a + ny * t));
  for (let j = 0; j < 2 * pl.m; j++) {
    const a = pl.s0 + j * p;
    const [h, e] = [pl.h, c];
    if (j % 2 === 0) [[a - e, 0], [a, e], [a, h - e], [a + e, h]].forEach(([u, v]) => at(u!, v!));
    else [[a - e, h], [a, h - e], [a, e], [a + e, 0]].forEach(([u, v]) => at(u!, v!));
  }
  return out;
}

/** The track's points with the plan's meander in. */
function withMeander(pts: number[], pl: Plan, cOf: (h: number) => number, p: number): number[] {
  const k = 2 * (pl.slot.i + 1);
  return [...pts.slice(0, k), ...meanderPts(pl, cOf, p), ...pts.slice(k)];
}

/** The stretches of a track that run horizontal, vertical or at 45° and are at least `min` long. */
function slotsOf(pts: number[], min: number): Slot[] {
  const out: Slot[] = [];
  for (let q = 0; q + 3 < pts.length; q += 2) {
    const [ax, ay, bx, by] = [pts[q]!, pts[q + 1]!, pts[q + 2]!, pts[q + 3]!];
    const [dx, dy] = [bx - ax, by - ay];
    const len = Math.hypot(dx, dy);
    if (len < min || !(Math.abs(dx) < 0.002 || Math.abs(dy) < 0.002 || Math.abs(Math.abs(dx) - Math.abs(dy)) < 0.002)) continue;
    out.push({ i: q / 2, ax, ay, ux: dx / len, uy: dy / len, len });
  }
  return out;
}

const pieceDist = (a: Slot, x: number, y: number) => {
  const t = Math.max(0, Math.min(a.len, (x - a.ax) * a.ux + (y - a.ay) * a.uy));
  return Math.hypot(a.ax + a.ux * t - x, a.ay + a.uy * t - y);
};

/**
 * Self-spacing: no piece of the meander (pieces from..to-1) within `gap` (edge to edge) of a piece of
 * the track that lies further than a leg spacing along it (pieces near each other along the track
 * are bends of the same stretch, close by nature).
 */
function selfClash(pts: number[], from: number, to: number, width: number, gap: number): boolean {
  const n = pts.length / 2 - 1;
  const len = Array.from({ length: n }, (_, i) => Math.hypot(pts[2 * i + 2]! - pts[2 * i]!, pts[2 * i + 3]! - pts[2 * i + 1]!));
  // the track's length between the end of piece a and the start of piece b (a < b)
  const between = (a: number, b: number) => len.slice(a + 1, b).reduce((s, v) => s + v, 0);
  for (let q = from; q < to; q++) {
    for (let r = 0; r < n; r++) {
      if (r >= from && r < to) continue;
      if ((r < q ? between(r, q) : between(q, r)) < width + gap) continue;
      if (segSegDist(pts[2 * q]!, pts[2 * q + 1]!, pts[2 * q + 2]!, pts[2 * q + 3]!, pts[2 * r]!, pts[2 * r + 1]!, pts[2 * r + 2]!, pts[2 * r + 3]!) < width + gap - 0.005) return true;
    }
  }
  return false;
}

export function tuneLength(d: Design, op: Extract<EditOp, { op: 'tune_length' }>): OpResult {
  const { b, dc } = drawnOf(d);
  const board = placedOf(d);
  const name = (id: string) => d.nets[id]?.name ?? id;
  const netByName = (n: string) => {
    const net = findNet(d, n);
    if (!net) reject({ code: 'NET_UNKNOWN', message: `No net "${n}".`, candidates: Object.values(d.nets).map((x) => x.name) });
    return net!.id;
  };
  // what is tuned
  const named = op.track ? dc.tracks.find((t) => t.id === op.track!.toLowerCase()) : undefined;
  if (op.track && !named) reject({ code: 'REF_UNKNOWN', message: `No drawn track ${op.track}.`, candidates: dc.tracks.map((t) => t.id).slice(0, 40) });
  if (!op.track && !op.net) reject({ code: 'INVALID_OP', message: 'tune_length needs the track (its id) or the net to lengthen.' });
  const netId = named ? named.netId : netByName(op.net!);
  if (named && op.net && netByName(op.net) !== netId) reject({ code: 'NET_MISMATCH', message: `${named.id} is on ${name(named.netId)}, not on ${op.net}.` });
  const mine = dc.tracks.filter((t) => t.netId === netId);
  if (!mine.length) reject({ code: 'INVALID_OP', message: `${name(netId)} has no drawn track to put a meander in. Draw its copper first (draw_track, draw_pair).` });
  const view: ImpedanceView | undefined = board.impedance?.find((v) => v.nets.includes(netId));

  // the length to reach
  const lengthOf = (id: string) => dc.tracks.filter((t) => t.netId === id).reduce((s, t) => s + trackLength(t), 0);
  const have = lengthOf(netId);
  const open = (ids: string[]) => ids.filter((id) => board.unrouted.some((u) => u.netId === id));
  let target: number;
  let why: string;
  if (op.target_mm !== undefined) {
    target = op.target_mm;
    why = `${f2(target)} mm`;
  } else {
    const others = op.match?.map(netByName) ?? (view?.pair ? view.nets.filter((n) => n !== netId) : []);
    if (!others.length) reject({ code: 'INVALID_OP', message: `${name(netId)} is in no pair: say the length (target_mm) or the nets to match (match).` });
    const lens = others.filter((n) => n !== netId).map((n) => ({ n, len: lengthOf(n) }));
    if (!lens.length || lens.every((x) => x.len === 0)) reject({ code: 'INVALID_OP', message: `${others.map(name).join(', ')} has no drawn copper to match yet.` });
    const longest = lens.reduce((a, c) => (c.len > a.len ? c : a));
    target = longest.len;
    why = `${name(longest.n)}, ${f2(target)} mm`;
  }
  const skewLimit = view?.pair ? (view.skew ?? DEFAULT_SKEW) : undefined;
  const tol = op.tolerance_mm ?? Math.min(TOLERANCE, skewLimit ?? TOLERANCE);
  const need = target - have;
  const unfinished = open([netId, ...(op.match?.map(netByName) ?? [])]);
  const unfinishedNote = unfinished.length ? `; ${unfinished.map(name).join(', ')} not drawn to the end yet, so its length is what is drawn` : '';
  if (Math.abs(need) <= tol) return { op: op.op, effect: `${name(netId)} is ${f2(have)} mm, within ${f2(tol)} mm of ${why}: nothing to add${unfinishedNote}`, ids: [] };
  if (need < 0) reject({ code: 'INVALID_OP', message: `${name(netId)} is ${f2(have)} mm, already ${f2(-need)} mm longer than ${why}. A meander only adds length: lengthen the other nets, or draw this one shorter (edit_copper via).` });

  const clearance = b.rules.clearance;
  const geo = { outline: board.outline, cornerRadius: board.cornerRadius, shape: board.shape, cutouts: board.cutouts, layers: board.layers, rules: board.rules };

  let tracks = mine.filter((t) => !named || t === named);
  // longest first: the meander goes where there is most track
  tracks = tracks.slice().sort((a, c) => trackLength(c) - trackLength(a));
  const failures: string[] = [];
  for (const track of tracks) {
    const res = tuneTrack(track);
    if (typeof res === 'string') {
      failures.push(res);
      continue;
    }
    const { plans, gained, c, gap, width } = res;
    const after = lengthOf(netId);
    // keep the track's identity: it is yours now, and its ends stay
    delete track.by;
    d.board = b;
    const bumps = plans.reduce((s, p) => s + p.m, 0);
    const high = plans.map((p) => p.h);
    const where = plans.map((p) => `${r3(p.slot.ax + p.slot.ux * (p.s0 + p.m * (gap + width)))}, ${r3(p.slot.ay + p.slot.uy * (p.s0 + p.m * (gap + width)))}`);
    const partner = view?.pair ? view.nets.find((n) => n !== netId) : undefined;
    const skew = partner !== undefined && lengthOf(partner) > 0 ? Math.abs(after - lengthOf(partner)) : undefined;
    const longer = view?.maxLength !== undefined && after > view.maxLength + 1e-6;
    return {
      op: op.op,
      effect:
        `tuned ${track.id} (${name(netId)}) on ${track.layer}: +${f2(gained)} mm with ${bumps} bump${bumps === 1 ? '' : 's'} (${plans.length > 1 ? `${plans.length} stretches, ` : ''}${f2(Math.min(...high))}${Math.max(...high) - Math.min(...high) > 0.005 ? `–${f2(Math.max(...high))}` : ''} mm high, legs ${f2(gap)} mm apart, ${f2(c)} mm corners) near ${where.join('; ')}; ` +
        `${name(netId)} is now ${f2(after)} mm against ${why}${Math.abs(after - target) > 0.005 ? ` (${f2(after - target)} mm off, within ${f2(tol)})` : ''}` +
        (skew !== undefined ? `, pair skew ${f2(skew)} mm (limit ${skewLimit} mm)` : '') +
        (longer ? `; longer than its ${view!.maxLength} mm maximum (IMP.LENGTH)` : '') +
        unfinishedNote,
      ids: ['board', track.id],
    };
  }
  reject({
    code: 'INVALID_OP',
    message: `${name(netId)} needs ${f2(need)} mm more (to ${why}); ${failures.length ? failures.join(' ') : `no track of it has a straight stretch to meander in.`}`,
    fixHints: [{ op: 'tune_length', net: name(netId), ...(op.target_mm !== undefined ? { target_mm: op.target_mm } : {}), height_mm: 2 * MAX_HEIGHT }],
  });

  /** A meander in one track, the plans made, or why there is no room (a message). */
  function tuneTrack(track: DrawnTrack): { plans: Plan[]; gained: number; c: number; gap: number; width: number } | string {
    const width = track.width;
    // the gap its rule asks for (other signals kept off by it), 3 widths at least
    const lay = view?.layers.find((l) => l.layer === track.layer);
    const keep = lay && view?.keep !== undefined ? keepOf(view, lay) : 0;
    const minGap = Math.max(3 * width, clearance);
    const gap = op.gap_mm ?? Math.max(minGap, keep);
    if (gap < minGap - 1e-9) reject({ code: 'INVALID_OP', message: `A gap of ${gap} mm between the legs of a meander of ${width} mm tracks couples them to each other: at least ${r3(minGap)} mm (3 widths).`, fixHints: [{ op: op.op, ...(op.track ? { track: op.track } : { net: op.net }), gap_mm: r3(minGap) }] });
    const pairGap = view?.pair ? lay?.gap : undefined;
    const small = !!pairGap;
    // the corners cut by c (wide ones only where the bump is tall enough), two legs and four corners to a bump:
    // it adds 2h, less what each 45° corner saves (c · (2 − √2))
    const c0 = r3(Math.min(width * (small ? CHAMFER / 2 : CHAMFER), 1));
    const cmin = r3(Math.min(c0, Math.max(width * CHAMFER_MIN, 0.05)));
    const ell = width * LEG;
    const cOf = (h: number) => r3(Math.max(cmin, Math.min(c0, (h - ell) / 2)));
    const gainOf = (h: number) => 2 * h - 4 * cOf(h) * (2 - SQ2);
    const p = width + gap;
    const hmin = r3(2 * cmin + ell);
    const hmax = Math.max(hmin, op.height_mm ?? (small ? 2 * pairGap! : MAX_HEIGHT));
    // (the height that adds g per bump)
    const heightFor = (g: number) => {
      let [lo, hi] = [hmin, hmax];
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (gainOf(mid) < g) lo = mid;
        else hi = mid;
      }
      return r3(hi);
    };
    const c = c0;
    const margin = Math.max(2 * width, 2 * c);
    const span = (m: number) => (2 * m - 1) * p + 2 * c;
    const plans: Plan[] = [];
    let pts = track.pts.slice();
    let left = need;
    const startLen = trackLength(track);
    const reasons: string[] = [];
    // (what the smallest bump adds, where that is more than is missing)
    let smallest = Infinity;
    const stop = Math.max(tol, 0.01);
    const [firstOf, lastOf] = [{ x: pts[0]!, y: pts[1]! }, { x: pts.at(-2)!, y: pts.at(-1)! }];
    const toward = op.near === 'start' ? firstOf : op.near === 'end' ? lastOf : Array.isArray(op.near) ? { x: op.near[0], y: op.near[1] } : null;
    // the other member of a pair: bumps go away from it
    const partnerTracks = view?.pair ? board.tracks.filter((t) => view.nets.includes(t.netId) && t.netId !== netId && t.layer === track.layer) : [];
    for (let round = 0; round < ROUNDS && left > stop; round++) {
      const ex = nearBox(board, bounds(pts), hmax + 2 * (gap + width) + clearance + 2);
      const existing = ex;
      const tryPlan = (pl: Plan): boolean => {
        const next = withMeander(pts, pl, cOf, p);
        const first = pl.slot.i + 1;
        const added = (next.length - pts.length) / 2;
        // the bump's own copper: from its first point to its last (the track either side was there before)
        const mineNew = [{ layer: track.layer, width, pts: next.slice(2 * first, 2 * (first + added)) }];
        if (firstClash(geo, existing, netId, { tracks: mineNew }, { name })) return false;
        return !selfClash(next, first, first + added - 1, width, gap);
      };
      const slots = slotsOf(pts, span(1) + 2 * margin);
      if (toward) slots.sort((a, e) => pieceDist(a, toward.x, toward.y) - pieceDist(e, toward.x, toward.y));
      else slots.sort((a, e) => e.len - a.len);
      let done: Plan | null = null;
      let best: { plan: Plan; gain: number } | null = null;
      for (const slot of slots) {
        const cap = Math.floor((slot.len - 2 * margin - 2 * c + p) / (2 * p));
        // the side away from the partner first
        let sides: (1 | -1)[] = op.side ? [op.side === 'left' ? -1 : 1] : [1, -1];
        if (!op.side && partnerTracks.length) {
          const mx = slot.ax + (slot.ux * slot.len) / 2;
          const my = slot.ay + (slot.uy * slot.len) / 2;
          const near = partnerTracks.map((t) => ({ t, dd: Math.min(...segmentsOf(t.pts).map(([ax, ay, bx, by]) => pointSegDist(mx, my, ax, ay, bx, by))) })).sort((a, e) => a.dd - e.dd)[0]!;
          const q = nearestPoint(near.t.pts, mx, my);
          const lat = (q.x - mx) * -slot.uy + (q.y - my) * slot.ux;
          sides = lat > 0 ? [-1, 1] : [1, -1];
        } else if (!op.side) {
          // the side with more room for a bump
          const room = (side: 1 | -1) => {
            const s0 = Math.max(margin + c, slot.len / 2 - c);
            for (let h = hmax; h >= hmin - 1e-9; h -= HEIGHT_STEP) if (tryPlan({ slot, side, m: 1, h: Math.max(hmin, r3(h)), s0 })) return h;
            return 0;
          };
          sides = room(-1) > room(1) ? [-1, 1] : [1, -1];
        }
        for (const side of sides) {
          for (let m = 1; m <= cap; m++) {
            // where along the slot: centred, or toward the point asked for
            const free = slot.len - 2 * margin - span(m);
            if (free < -1e-6) break;
            const wantS = toward ? Math.max(0, Math.min(slot.len, (toward.x - slot.ax) * slot.ux + (toward.y - slot.ay) * slot.uy)) : slot.len / 2;
            const lo = margin + c;
            const s0 = Math.max(lo, Math.min(lo + free, wantS - span(m) / 2 + c));
            const mk = (h: number): Plan => ({ slot, side, m, h, s0 });
            // the tallest bump that fits
            let hfit = -1;
            for (let h = hmax; h >= hmin - 1e-9; h -= HEIGHT_STEP) {
              const hh = Math.max(hmin, r3(h));
              if (tryPlan(mk(hh))) {
                hfit = hh;
                break;
              }
              if (hh === hmin) break;
            }
            if (hfit < 0) {
              reasons.push(`${m === 1 ? 'no bump of' : `${m} bumps of`} ${f2(hmin)} mm on the ${side > 0 ? 'right' : 'left'} of the stretch at ${f2(slot.ax)}, ${f2(slot.ay)} → ${f2(slot.ax + slot.ux * slot.len)}, ${f2(slot.ay + slot.uy * slot.len)} fit${m === 1 ? 's' : ''}`);
              break;
            }
            const lowGain = m * gainOf(hmin);
            const highGain = m * gainOf(hfit);
            if (left >= lowGain - stop && left <= highGain + stop) {
              // this many bumps reach it: the height that gives exactly what is missing
              const h = Math.max(hmin, Math.min(hfit, heightFor(Math.min(left, highGain) / m)));
              const plan = mk(h);
              if (tryPlan(plan)) {
                done = plan;
                break;
              }
            }
            if (left < lowGain - stop) {
              // more bumps only overshoot
              if (m === 1) smallest = Math.min(smallest, lowGain);
              break;
            }
            if (!best || highGain > best.gain) best = { plan: mk(hfit), gain: highGain };
          }
          if (done) break;
        }
        if (done) break;
      }
      const use = done ?? best?.plan;
      if (!use) break;
      pts = withMeander(pts, use, cOf, p);
      plans.push(use);
      left = need - (trackLength({ pts }) - startLen);
      if (done) break;
    }
    if (left > stop) {
      const spots = slotsOf(track.pts, 0.1)
        .sort((a, e) => e.len - a.len)
        .slice(0, 2)
        .map((s) => `${f2(s.ax)}, ${f2(s.ay)} → ${f2(s.ax + s.ux * s.len)}, ${f2(s.ay + s.uy * s.len)} (${f2(s.len)} mm)`);
      const reach = need - left;
      if (!plans.length && smallest < Infinity && smallest > left + stop) {
        return `${track.id}: the smallest bump of ${f2(width)} mm tracks adds ${f2(smallest)} mm, more than the ${f2(left)} mm missing. Accept a longer result (tolerance_mm of at least ${f2(smallest - left)}), or tune another net.`;
      }
      return (
        `${track.id} has no room for it: ${plans.length ? `${f2(reach)} mm fit, ${f2(left)} mm short` : `none fits`}. ` +
        `A meander of ${f2(width)} mm tracks needs a straight stretch of at least ${f2(span(1) + 2 * margin)} mm, ${f2(hmin)}–${f2(hmax)} mm of free copper to one side of it (legs ${f2(gap)} mm apart, ${f2(clearance)} mm from other copper)` +
        `${spots.length ? `; the longest stretches are ${spots.join(' and ')}` : '; the track has no straight stretch that long'}` +
        `${reasons.length ? `; ${reasons.slice(0, 2).join('; ')}` : ''}. ` +
        `Fix: move what is in the way (edit_copper move, erase_copper), allow taller bumps (height_mm), a smaller gap_mm down to ${f2(Math.max(3 * width, clearance))} mm, give the track a longer straight stretch (edit_copper via), or put the length on the other nets (target_mm).`
      );
    }
    for (const pl of plans) pl.h = r3(pl.h);
    track.pts = simplify2(pts);
    return { plans, gained: trackLength(track) - startLen, c: cOf(Math.max(...plans.map((q) => q.h))), gap, width };
  }
}

/** The piece list of a polyline. */
/** The point of a polyline nearest to (x, y). */
function nearestPoint(pts: number[], x: number, y: number): { x: number; y: number } {
  let best = { x: pts[0]!, y: pts[1]!, d: Infinity };
  for (const [ax, ay, bx, by] of segmentsOf(pts)) {
    const [dx, dy] = [bx - ax, by - ay];
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    const [px, py] = [ax + t * dx, ay + t * dy];
    const dd = Math.hypot(px - x, py - y);
    if (dd < best.d) best = { x: px, y: py, d: dd };
  }
  return best;
}

const bounds = (pts: number[]): [number, number, number, number] => {
  const xs = pts.filter((_, i) => i % 2 === 0);
  const ys = pts.filter((_, i) => i % 2 === 1);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

/** The track's points without repeats. */
function simplify2(pts: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    if (out.length && Math.abs(out.at(-2)! - pts[i]!) < 1e-6 && Math.abs(out.at(-1)! - pts[i + 1]!) < 1e-6) continue;
    out.push(pts[i]!, pts[i + 1]!);
  }
  return out;
}
