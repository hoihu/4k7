/**
 * The land against the part the house buys: does that part fit the pads it will be placed on? The
 * house's own footprint for the part (its library's, the one its placement and its engineers use)
 * is turned onto the part as it lies on the board, pin by pin: by function for a two-pin part that
 * goes one way round (the cathode, the plus terminal), else by the pins' numbers or names, whichever
 * lines up better. Its pads should then overlap ours. Where one barely does, the part does not fit
 * the land (another can size, a land made for another kind of part), and the house will not place
 * it: spiral2's electrolytics, October 2026 (docs/design/assembly.md).
 */
import { padPins, type BoardPart, type HouseFootprint, type PolarityKind } from '@4k7/schema';

/** A part's land as it lies on the board, for comparing with the house's. */
export interface PlacedLand {
  /** The footprint's name ("CAP-8x10"). */
  name: string;
  /**
   * Its pads from the part's centre (mm, board axes, y down) as placed, each with the numbers and the
   * names of the pins it carries.
   */
  pads: { numbers: string[]; names: string[]; x: number; y: number; w: number; h: number; drill?: boolean }[];
  /** Mounted on the bottom side: seen from the top, so mirrored. */
  bottom?: boolean;
  /** Which way round it goes: its marked pad (number) and what the mark says. */
  polarity?: { kind: PolarityKind; pad: string };
}

export interface LandFit {
  /** The house's footprint lies on ours turned by this (degrees counter-clockwise, as a pick-and-place file counts). */
  rotation: number;
  /** How its pins were paired with ours. */
  by: 'function' | 'number' | 'name';
  /** The farthest a paired pad's centre lies from ours (mm), after the best shift. */
  offset: number;
  /** The least an SMD pad of the house's overlaps the one it is paired with (shared area over joint area, 0–1). */
  overlap: number;
  /** Where the house's footprint's origin lies from the part's centre (mm, board axes, y down), turned and shifted onto our pads. */
  at: [number, number];
  /** Why the part does not fit the land, in words; empty when it fits. */
  problems: string[];
}

/** A part's land as it lies on the board (the pins' names by number from its card), for fitLand. Holes without copper are left out. */
export function placedLand(p: BoardPart, pinName: (pin: string) => string | undefined): PlacedLand {
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return {
    name: p.pkg,
    pads: p.pads
      .filter((q) => !q.npth)
      .map((q) => {
        const numbers = padPins(q);
        return { numbers, names: numbers.map(pinName).filter((n): n is string => !!n), x: r3(q.x - p.x), y: r3(q.y - p.y), w: q.w, h: q.h, ...(q.drill ? { drill: true } : {}) };
      }),
    ...(p.side === 'bottom' ? { bottom: true } : {}),
    ...(p.mark ? { polarity: { kind: p.mark.kind, pad: p.mark.pad } } : {}),
  };
}

/** Below this overlap a pad is not the land the part needs (an electrolytic on chip-style pads: 0.16). */
export const LAND_OVERLAP = 0.2;
/** A paired pad further off than this (mm) misses its pin; a drilled one already at a third of it. */
export const LAND_OFFSET = 1;

type Pad = { x: number; y: number; w: number; h: number; drill?: boolean };
const r2 = (v: number) => Math.round(v * 100) / 100;
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9+]/g, '');
/** What a pin is called, every way: its name and the words in it ("CC1_A5": CC1_A5, CC1, A5). */
const called = (name: string) => [norm(name), ...name.toUpperCase().split(/[^A-Z0-9+]+/).filter(Boolean)];
/** The contacts a house's pin number names ("A1B12", a USB-C pad: A1 and B12). */
const contacts = (number: string) => number.toUpperCase().match(/[A-Z]+\d+/g) ?? [];

/** The house's pad that is the marked pin of a two-pin part, when its pins' names say which. */
function marked(house: HouseFootprint['pads'], kind: PolarityKind): HouseFootprint['pads'][number] | undefined {
  if (house.length !== 2) return undefined;
  const named = (re: RegExp) => house.find((p) => p.name && re.test(p.name.trim()));
  const other = (p: HouseFootprint['pads'][number] | undefined) => (p ? house.find((q) => q !== p) : undefined);
  // an LED's "−" is its cathode, its "+" the anode
  if (kind === 'cathode') return named(/^(k|cathode|kathode)$/i) ?? named(/^(-|−)$/) ?? other(named(/^(a|anode|\+)$/i));
  if (kind === 'plus') return named(/^\+$/) ?? other(named(/^(-|−)$/));
  return undefined;
}

/** A pad of the house's footprint turned by `rot` (counter-clockwise, top view) and mirrored for the bottom side. */
function turned(p: Pad, rot: number, bottom: boolean): Pad {
  const x0 = bottom ? -p.x : p.x;
  const [x, y] = rot === 90 ? [p.y, -x0] : rot === 180 ? [-x0, -p.y] : rot === 270 ? [-p.y, x0] : [x0, p.y];
  const swap = rot === 90 || rot === 270;
  return { ...p, x, y, w: swap ? p.h : p.w, h: swap ? p.w : p.h };
}

/** Shared area over joint area of two pads. */
function overlap(a: Pad, b: Pad): number {
  const ix = Math.max(0, Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2));
  const iy = Math.max(0, Math.min(a.y + a.h / 2, b.y + b.h / 2) - Math.max(a.y - a.h / 2, b.y - b.h / 2));
  const shared = ix * iy;
  return shared / (a.w * a.h + b.w * b.h - shared);
}

type Theirs = Pad & { number: string; name?: string };

interface Trial {
  rotation: number;
  by: LandFit['by'];
  /** How many pins paired by function, number or name (the rest paired by position). */
  primary: number;
  /** Our pads with the house's they pair with, the house's shifted onto ours. */
  pairs: [PlacedLand['pads'][number], Theirs][];
  /** The house's pads left over, shifted the same. */
  rest: Theirs[];
  offset: number;
  overlap: number;
  /** The shift that lays the house's footprint (its origin) on ours. */
  dx: number;
  dy: number;
}

/**
 * The house's pads paired with ours for one way of pairing and one rotation, shifted by the mean of
 * the pairs; null when fewer than two pair up. The pads left over (a connector's shield legs, numbered
 * and named differently on each side) then pair by position.
 */
function trial(ours: PlacedLand, house: HouseFootprint, by: LandFit['by'], rotation: number): Trial | null {
  const theirs: Theirs[] = house.pads.map((p) => ({ ...turned(p, rotation, !!ours.bottom), number: p.number, ...(p.name ? { name: p.name } : {}) }));
  let pairs: [PlacedLand['pads'][number], Theirs][] = [];
  if (by === 'function') {
    const mine = ours.pads.find((p) => p.numbers.includes(ours.polarity!.pad));
    const m = marked(house.pads, ours.polarity!.kind);
    if (!mine || !m || ours.pads.length !== 2) return null;
    const i = house.pads.indexOf(m);
    pairs.push([mine, theirs[i]!], [ours.pads.find((p) => p !== mine)!, theirs[1 - i]!]);
  } else if (by === 'number') {
    const taken = new Set<Theirs>();
    for (const p of ours.pads) {
      const q = theirs.find((t) => !taken.has(t) && !!t.drill === !!p.drill && p.numbers.some((n) => norm(n) === norm(t.number)));
      if (q) {
        taken.add(q);
        pairs.push([p, q]);
      }
    }
  } else {
    // by name: the nearest of the house's pads called what one of the pad's pins is called (a name, a
    // word of it, a contact), the two centred on each other
    const cx = (ps: { x: number; y: number }[]) => [ps.reduce((s, p) => s + p.x, 0) / ps.length, ps.reduce((s, p) => s + p.y, 0) / ps.length] as const;
    const [ox, oy] = cx(ours.pads);
    const [tx, ty] = cx(theirs);
    const taken = new Set<Theirs>();
    for (const p of ours.pads) {
      const names = new Set(p.names.flatMap(called));
      let best: Theirs | null = null;
      let bestD = Infinity;
      for (const t of theirs) {
        if (taken.has(t) || !!t.drill !== !!p.drill || ![...(t.name ? called(t.name) : []), ...contacts(t.number)].some((n) => names.has(n))) continue;
        const d = Math.hypot(t.x - tx - (p.x - ox), t.y - ty - (p.y - oy));
        if (d < bestD) [best, bestD] = [t, d];
      }
      if (best) {
        taken.add(best);
        pairs.push([p, best]);
      }
    }
  }
  if (pairs.length < 2) return null;
  const primary = pairs.length;
  const used = new Set(pairs.map(([, q]) => q));
  const dx = pairs.reduce((s, [p, q]) => s + p.x - q.x, 0) / pairs.length;
  const dy = pairs.reduce((s, [p, q]) => s + p.y - q.y, 0) / pairs.length;
  const move = (q: Theirs): Theirs => ({ ...q, x: q.x + dx, y: q.y + dy });
  pairs = pairs.map(([p, q]) => [p, move(q)]);
  let rest = theirs.filter((t) => !used.has(t)).map(move);
  for (const p of ours.pads.filter((x) => !pairs.some(([q]) => q === x))) {
    const near = rest.filter((t) => !!t.drill === !!p.drill).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
    if (!near) continue;
    pairs.push([p, near]);
    rest = rest.filter((t) => t !== near);
  }
  const offset = Math.max(...pairs.map(([p, q]) => Math.hypot(p.x - q.x, p.y - q.y)));
  const smd = pairs.filter(([p, q]) => !p.drill && !q.drill);
  return { rotation, by, primary, pairs, rest, offset, overlap: smd.length ? Math.min(...smd.map(([p, q]) => overlap(p, q))) : 1, dx, dy };
}

/**
 * How the house's footprint for the part lies on our land: turned and paired the way that lines its
 * pins up best, and whether the part fits (problems in words when it does not).
 */
export function fitLand(ours: PlacedLand, house: HouseFootprint): LandFit {
  const ways: LandFit['by'][] = ours.polarity && ours.polarity.kind !== 'pin1' && ours.pads.length === 2 && marked(house.pads, ours.polarity.kind) ? ['function'] : ['number', 'name'];
  const trials = ways.flatMap((by) => [0, 90, 180, 270].map((rot) => trial(ours, house, by, rot))).filter((t): t is Trial => !!t);
  // most pins paired by what they are, then the best lined up
  const best = trials.sort((a, b) => b.primary - a.primary || a.offset - b.offset || b.overlap - a.overlap)[0];
  const problems: string[] = [];
  if (!best) {
    problems.push(`its pins (${house.pads.map((p) => p.number).join(', ')}) do not pair up with the pads of ${ours.name} (${ours.pads.map((p) => p.numbers[0]).join(', ')})`);
    return { rotation: 0, by: ways[0]!, offset: Infinity, overlap: 0, at: [0, 0], problems };
  }
  // soldered pads with nothing to pair with: a pin without a pad, a pad without a pin
  const lone = ours.pads.filter((p) => !p.drill && !best.pairs.some(([q]) => q === p)).map((p) => p.numbers[0]);
  if (lone.length) problems.push(`no pin of it lands on pad${lone.length > 1 ? 's' : ''} ${lone.join(', ')} of ${ours.name}`);
  const loose = best.rest.filter((t) => !t.drill).map((t) => t.number);
  if (loose.length) problems.push(`its pin${loose.length > 1 ? 's' : ''} ${loose.join(', ')} ${loose.length > 1 ? 'have' : 'has'} no pad on ${ours.name}`);
  // a pin that misses its pad
  const off = best.pairs.map(([p, q]) => ({ p, q, d: Math.hypot(p.x - q.x, p.y - q.y) })).sort((a, b) => b.d - a.d)[0]!;
  const limit = off.p.drill || off.q.drill ? LAND_OFFSET / 3 : LAND_OFFSET;
  if (off.d > limit) problems.push(`its pin ${off.q.number} lands ${r2(off.d)} mm off pad ${off.p.numbers[0]} of ${ours.name}`);
  // a pad that is not the land the part needs
  if (best.overlap < LAND_OVERLAP) {
    const smd = best.pairs.filter(([p, q]) => !p.drill && !q.drill);
    const [p, q] = smd.reduce((w, x) => (overlap(x[0], x[1]) < overlap(w[0], w[1]) ? x : w));
    const size = (x: Pad) => `${r2(x.w)} × ${r2(x.h)} mm`;
    if (ours.pads.length === 2 && house.pads.length === 2) {
      const apart = (a: Pad, b: Pad) => r2(Math.hypot(a.x - b.x, a.y - b.y));
      const [a, b] = [best.pairs[0]!, best.pairs[1]!];
      problems.push(`its pads are ${size(q)}, ${apart(a[1], b[1])} mm apart; the pads of ${ours.name} ${size(p)}, ${apart(a[0], b[0])} mm apart`);
    } else problems.push(`its pad ${q.number} (${size(q)}) and pad ${p.numbers[0]} of ${ours.name} (${size(p)}) share only ${Math.round(overlap(p, q) * 100)} % of their area`);
  }
  const r3 = (v: number) => Math.round(v * 1000) / 1000 || 0;
  return { rotation: best.rotation, by: best.by, offset: r2(best.offset), overlap: Math.round(best.overlap * 100) / 100, at: [r3(best.dx), r3(best.dy)], problems };
}
