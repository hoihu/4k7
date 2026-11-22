/**
 * The bring-up sheet of the design document: from the power tree (get_power_tree) and the test
 * points (add_test_points), the rails in the order to power them up, the voltage each should read,
 * where to probe it, and the current limit to set on the bench supply. See docs/design/layout.md §4.
 */
import type { BringUpPlan, BringUpRail, Design } from '@4k7/schema';
import { cardOf, componentsSorted, natCmp } from './doc.ts';
import { powerTreeAnswer } from './powertree.ts';
import { isTestPoint, sourcePin, testPointLabel } from './testpoints.ts';

/** The rail as get_power_tree gives it (the fields read here). */
interface TreeRail {
  net: string;
  voltage: number | 'unknown';
  source: { kind: 'regulator' | 'connector' | 'battery' | 'unknown'; ref?: string; regulator?: 'linear' | 'switching'; from?: string };
  through?: { ref: string; category: string; from: string }[];
  feeds?: string[];
  loads?: { pin: string; a: number }[];
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

  // the test points on each net, and (without one) the pin the net comes from
  const tps = new Map<string, { ref: string; label: string }[]>();
  for (const c of componentsSorted(d)) {
    const card = cardOf(d, c.part);
    if (c.dnp || !isTestPoint(card)) continue;
    const net = c.pins[card!.pins[0]!.number];
    if (net) (tps.get(net) ?? tps.set(net, []).get(net)!).push({ ref: c.refdes, label: testPointLabel(d, c, card!) ?? c.refdes });
  }
  const netByName = new Map(Object.values(d.nets).map((n) => [n.name, n]));
  const pinText = (net: string) => {
    const n = netByName.get(net);
    const at = n && sourcePin(d, n);
    if (!at) return undefined;
    const name = cardOf(d, at.comp.part)?.pins.find((p) => p.number === at.pin)?.name;
    return `${at.comp.refdes}.${name && name !== at.pin ? name : at.pin}`;
  };

  const sourceText = (r: TreeRail) => {
    const s = r.source;
    const what = s.kind === 'regulator' ? `${s.regulator ? `${s.regulator} ` : ''}regulator${s.from ? ` from ${s.from}` : ''}` : s.kind;
    const via = r.through?.length ? `, through ${r.through.map((h) => h.ref).join(', ')}` : '';
    return s.ref ? `${s.ref} (${what})${via}` : `unknown${via}`;
  };

  const rails: BringUpRail[] = order.map((r) => {
    const id = netByName.get(r.net)?.id ?? '';
    const testPoints = tps.get(id) ?? [];
    const probeAt = testPoints.length ? undefined : pinText(r.net);
    let supply: BringUpRail['supply'];
    if (outside(r)) {
      const { a, basis } = draw(r);
      supply = { draw_a: a, basis, limit_a: a === 'unknown' ? 'unknown' : Math.ceil((a * MARGIN * 100) - 1e-9) / 100 };
    }
    return { net: r.net, voltage: r.voltage, source: sourceText(r), input: outside(r), testPoints, ...(probeAt ? { probeAt } : {}), ...(supply ? { supply } : {}) };
  });

  const volts = (v: number | 'unknown') => (v === 'unknown' ? 'the voltage (not stated)' : `${v} V`);
  const amps = (a: number) => (a < 1 ? `${Math.round(a * 1000)} mA` : `${+a.toFixed(2)} A`);
  const where = (r: BringUpRail) => (r.testPoints.length ? `at ${r.testPoints.map((t) => `${t.ref} (${t.label})`).join(', ')}` : r.probeAt ? `at ${r.probeAt} (no test point)` : '(no test point, no pin found to probe)');
  const steps = [
    `Before power: with the board unpowered, measure the resistance from each rail to ground (${rails.map((r) => r.net).join(', ')}); a reading near 0 Ω is a short to find first.`,
    ...rails.map((r) => {
      if (r.supply) {
        const s = r.supply;
        const limit =
          s.limit_a === 'unknown'
            ? 'current limit unknown: start low (tens of mA) and raise it slowly while watching the current'
            : `current limit ${amps(s.limit_a)} (${MARGIN} × the ${amps(s.draw_a as number)} expected, from ${s.basis === 'loads' ? 'the loads stated' : 'the rails\' max_current'})`;
        return `Power ${r.net}: set the bench supply to ${volts(r.voltage)}, ${limit}, and connect it ${r.source.startsWith('unknown') ? 'to the rail' : `at ${r.source.split(' ')[0]}`}. Check ${volts(r.voltage)} ${where(r)}.`;
      }
      return `Check ${r.net}: expect ${volts(r.voltage)} ${where(r)}, made by ${r.source}. If it is off, switch off before going on.`;
    }),
  ];
  return { rails, steps };
}
