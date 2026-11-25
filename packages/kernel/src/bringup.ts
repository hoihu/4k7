/**
 * The bring-up sheet of the design document: from the power tree (get_power_tree) and the test
 * points (add_test_points), the rails in the order to power them up, the voltage each should read,
 * where to probe it, and the current limit to set on the bench supply. Of the whole design: on a design
 * of several boards one sheet, the rails in one power-up order across the boards, each naming its boards,
 * the mates it crosses and the board of each probe point. See docs/design/layout.md §4.
 */
import type { BringUpPlan, BringUpRail, Design } from '@4k7/schema';
import { boardNameOf, boardOf, multiBoard } from './boards.ts';
import { cardOf, componentsSorted, natCmp } from './doc.ts';
import { powerTreeAnswer } from './powertree.ts';
import { isTestPoint, sourcePin, testPointLabel } from './testpoints.ts';

/** The rail as get_power_tree gives it (the fields read here). */
interface TreeRail {
  net: string;
  voltage: number | 'unknown';
  source: { kind: 'regulator' | 'connector' | 'battery' | 'unknown'; ref?: string; regulator?: 'linear' | 'switching'; from?: string; board?: string };
  through?: { ref: string; category: string; from: string }[];
  feeds?: string[];
  loads?: { pin: string; a: number }[];
  boards?: string[];
  crosses?: { a: string; a_board: string; b: string; b_board: string; pins: number }[];
  current: { max_a: number | 'unknown'; basis: string };
}

/**
 * The bench supply's current limit: the expected draw times MARGIN, rounded up to the next 10 mA.
 * The margin leaves room for the capacitors charging and the loads not stated exactly, while a short
 * still trips it long before anything burns.
 */
const MARGIN = 1.5;
/** A switching regulator's efficiency, assumed, to turn its output current into its input current. */
const EFFICIENCY = 0.8;

export function bringUpPlan(d: Design): BringUpPlan {
  const tree = (powerTreeAnswer(d) as { rails: TreeRail[] }).rails;
  if (!tree.length) return { rails: [], steps: [], note: 'No supply rails: give each supply net a voltage (set_net voltage) and mark the one that comes in on a connector external.' };
  const byName = new Map(tree.map((r) => [r.net, r]));
  const fed = new Set(tree.flatMap((r) => r.feeds ?? []));

  // power-up order: the rails no other rail feeds (those from outside first), then down the tree, breadth first
  const outside = (r: TreeRail) => r.source.kind === 'connector' || r.source.kind === 'battery';
  const roots = tree.filter((r) => !fed.has(r.net)).sort((a, b) => Number(outside(b)) - Number(outside(a)) || natCmp(a.net, b.net));
  const order: TreeRail[] = [];
  const seen = new Set<string>();
  for (const queue = [...roots]; queue.length; ) {
    const r = queue.shift()!;
    if (seen.has(r.net)) continue;
    seen.add(r.net);
    order.push(r);
    queue.push(...(r.feeds ?? []).map((n) => byName.get(n)!).filter(Boolean));
  }
  order.push(...tree.filter((r) => !seen.has(r.net)));

  /**
   * What a rail is expected to draw: its stated loads plus what the rails it feeds draw from it (a
   * series part or a linear regulator passes their current; a switching regulator takes
   * Vout·Iout / (Vin·EFFICIENCY)); else, where that is not known, its max_current; else unknown.
   * Nothing is guessed: a rail with neither loads nor max_current makes every rail above it unknown.
   */
  const draw = (r: TreeRail, path = new Set<string>()): { a: number | 'unknown'; basis: 'loads' | 'max_current' | 'unknown' } => {
    const max = r.current.basis === 'max_current' && typeof r.current.max_a === 'number' ? { a: r.current.max_a, basis: 'max_current' as const } : { a: 'unknown' as const, basis: 'unknown' as const };
    if (path.has(r.net)) return max;
    let sum = (r.loads ?? []).reduce((s, l) => s + l.a, 0);
    // 'max_current' as soon as a rail below counts with its max_current, not its loads
    let basis: 'loads' | 'max_current' = 'loads';
    for (const name of r.feeds ?? []) {
      const child = byName.get(name)!;
      const below = draw(child, new Set([...path, r.net]));
      if (below.a === 'unknown') return max;
      if (below.basis === 'max_current') basis = 'max_current';
      // as get_power_tree: a rail behind a series part passes its current, else its regulator decides
      const series = child.through?.some((h) => byName.has(h.from));
      const kind = series || child.source.regulator === 'linear' ? 'same' : child.source.regulator;
      if (kind === 'same') sum += below.a;
      else if (kind === 'switching' && typeof child.voltage === 'number' && typeof r.voltage === 'number' && r.voltage > 0) sum += (below.a * child.voltage) / (r.voltage * EFFICIENCY);
      else return max;
    }
    return sum > 0 ? { a: Math.round(sum * 1000) / 1000, basis } : max;
  };

  // several boards: each part's board, named on the rails, the test points and the pins to probe
  const multi = multiBoard(d);
  const boardAt = (c: Design['components'][string]) => (multi ? { board: boardNameOf(d, boardOf(d, c)) } : {});
  const byRef = new Map(Object.values(d.components).map((c) => [c.refdes, c]));

  // the test points on each net, and (without one) the pin the net comes from
  const tps = new Map<string, { ref: string; label: string; board?: string }[]>();
  for (const c of componentsSorted(d)) {
    const card = cardOf(d, c.part);
    if (c.dnp || !isTestPoint(card)) continue;
    const net = c.pins[card!.pins[0]!.number];
    if (net) (tps.get(net) ?? tps.set(net, []).get(net)!).push({ ref: c.refdes, label: testPointLabel(d, c, card!) ?? c.refdes, ...boardAt(c) });
  }
  const netByName = new Map(Object.values(d.nets).map((n) => [n.name, n]));
  const pinName = (comp: Design['components'][string], pin: string) => {
    const name = cardOf(d, comp.part)?.pins.find((p) => p.number === pin)?.name;
    return `${comp.refdes}.${name && name !== pin ? name : pin}`;
  };
  const pinAt = (net: string) => {
    const n = netByName.get(net);
    const at = n && sourcePin(d, n);
    return at ? { probeAt: pinName(at.comp, at.pin), ...(multi ? { probeBoard: boardNameOf(d, boardOf(d, at.comp)) } : {}) } : {};
  };
  // a rail crossing a mate: the board it reaches and the connector pin there, to probe it on the far side too
  const crossings = (r: TreeRail, id: string): NonNullable<BringUpRail['crosses']> =>
    (r.crosses ?? []).map((x) => {
      const far = x.b_board === r.source.board ? 'a' : 'b';
      const [near, farRef, farBoard] = far === 'b' ? [x.a, x.b, x.b_board] : [x.b, x.a, x.a_board];
      const c = byRef.get(farRef);
      const pin = c && Object.keys(c.pins).sort(natCmp).find((p) => c.pins[p] === id);
      return { board: farBoard, through: `${near}↔${farRef}`, pins: x.pins, ...(c && pin ? { probeAt: pinName(c, pin) } : {}) };
    });

  const sourceText = (r: TreeRail) => {
    const s = r.source;
    const what = s.kind === 'regulator' ? `${s.regulator ? `${s.regulator} ` : ''}regulator${s.from ? ` from ${s.from}` : ''}` : s.kind;
    const via = r.through?.length ? `, through ${r.through.map((h) => h.ref).join(', ')}` : '';
    return s.ref ? `${s.ref} (${what})${via}` : `unknown${via}`;
  };

  const rails: BringUpRail[] = order.map((r) => {
    const id = netByName.get(r.net)?.id ?? '';
    const testPoints = tps.get(id) ?? [];
    const probe = testPoints.length ? {} : pinAt(r.net);
    const crosses = multi ? crossings(r, id) : [];
    let supply: BringUpRail['supply'];
    if (outside(r)) {
      const { a, basis } = draw(r);
      supply = { draw_a: a, basis, limit_a: a === 'unknown' ? 'unknown' : Math.ceil((a * MARGIN * 100) - 1e-9) / 100 };
    }
    return {
      net: r.net,
      voltage: r.voltage,
      source: sourceText(r),
      input: outside(r),
      ...(multi ? { boards: r.boards ?? [] } : {}),
      ...(crosses.length ? { crosses } : {}),
      testPoints,
      ...probe,
      ...(supply ? { supply } : {}),
    };
  });

  const volts = (v: number | 'unknown') => (v === 'unknown' ? 'the voltage (not stated)' : `${v} V`);
  const amps = (a: number) => (a < 1 ? `${Math.round(a * 1000)} mA` : `${+a.toFixed(2)} A`);
  const on = (b?: string) => (b ? ` on ${b}` : '');
  const where = (r: BringUpRail) =>
    r.testPoints.length ? `at ${r.testPoints.map((t) => `${t.ref} (${t.label})${on(t.board)}`).join(', ')}` : r.probeAt ? `at ${r.probeAt}${on(r.probeBoard)} (no test point)` : '(no test point, no pin found to probe)';
  // several boards: each step names the rail's boards, and where it crosses a mate, to check it on the far side too
  const head = (r: BringUpRail) => (r.boards?.length ? ` (${r.boards.join(' + ')})` : '');
  const across = (r: BringUpRail) =>
    (r.crosses ?? []).map((x) => ` It reaches ${x.board} through ${x.through} (${x.pins} pin${x.pins === 1 ? '' : 's'}): check it there too${x.probeAt ? `, at ${x.probeAt}` : ''}.`).join('');
  const steps = [
    `Before power: with ${multi ? 'the boards mated and' : 'the board'} unpowered, measure the resistance from each rail to ground (${rails.map((r) => r.net).join(', ')}); a reading near 0 Ω is a short to find first.`,
    ...rails.map((r) => {
      if (r.supply) {
        const s = r.supply;
        const limit =
          s.limit_a === 'unknown'
            ? 'current limit unknown: start low (tens of mA) and raise it slowly while watching the current'
            : `current limit ${amps(s.limit_a)} (${MARGIN} × the ${amps(s.draw_a as number)} expected, from ${s.basis === 'loads' ? 'the loads stated' : 'the rails\' max_current'})`;
        return `Power ${r.net}${head(r)}: set the bench supply to ${volts(r.voltage)}, ${limit}, and connect it ${r.source.startsWith('unknown') ? 'to the rail' : `at ${r.source.split(' ')[0]}`}. Check ${volts(r.voltage)} ${where(r)}.${across(r)}`;
      }
      return `Check ${r.net}${head(r)}: expect ${volts(r.voltage)} ${where(r)}, made by ${r.source}.${across(r)} If it is off, switch off before going on.`;
    }),
  ];
  return { rails, steps };
}
