/**
 * design_query get_power_tree: what feeds what, and whether it runs hot. Per power rail its source
 * (the regulator, connector or battery nearest upstream, or unknown), the series parts between that
 * source and the rail, the rails it feeds, its loads and current budget, and for a linear regulator's
 * output the dissipation SEM.LDO_DISSIPATION computes (linearRegulators). A current not stated is
 * "unknown", never 0 or fine. See docs/design/ops-api.md §6.
 */
import type { Design, Net } from '@4k7/schema';
import { isSwitcher, linearRegulators } from './checks.ts';
import { cardOf, isGroundNet, isPowerNet, natCmp } from './doc.ts';
import { powerWalk, seriesEdges, type SeriesEdge } from './power.ts';
import { statedLoads } from './current.ts';
import { r3 } from './geom.ts';

type Unknown = 'unknown';
interface Source {
  kind: 'regulator' | 'connector' | 'battery' | 'unknown';
  ref?: string;
  regulator?: 'linear' | 'switching';
  from?: string;
}
interface Hop {
  ref: string;
  category: string;
  from: string;
}

/** A part that is a battery or a cell: no category of its own, so its card or refdes says so. */
const BATTERY = /\b(batter(y|ies)|coin cell|li-?ion|lipo|cr\d{4})\b/i;

export function powerTreeAnswer(d: Design): unknown {
  const nets = Object.values(d.nets);
  const rail = (id: string | undefined) => !!id && !!d.nets[id] && !isGroundNet(d.nets[id]!) && isPowerNet(d.nets[id]!);
  const name = (id: string) => d.nets[id]?.name ?? id;
  const linear = new Map(linearRegulators(d).map((r) => [r.component.id, r]));

  // where current comes in on a net: a pwr_out pin, a connector on an external net, a battery's pins
  const direct = new Map<string, Source[]>();
  for (const c of Object.values(d.components).sort((a, b) => natCmp(a.refdes, b.refdes))) {
    const card = cardOf(d, c.part);
    if (!card || c.dnp) continue;
    const battery = BATTERY.test(`${card.description} ${card.id}`) || /^BT\d/.test(c.refdes);
    const ins = [...new Set(card.pins.filter((p) => p.type === 'pwr_in').map((p) => c.pins[p.number]).filter((n): n is string => !!n && !isGroundNet(d.nets[n]!)))];
    for (const p of card.pins) {
      const net = c.pins[p.number];
      if (!net || isGroundNet(d.nets[net]!) || direct.get(net)?.some((s) => s.ref === c.refdes)) continue;
      let s: Source | undefined;
      if (battery) s = { kind: 'battery', ref: c.refdes };
      else if (card.category === 'connector' && d.nets[net]?.attrs.external) s = { kind: 'connector', ref: c.refdes };
      else if (p.type === 'pwr_out') {
        const type = linear.has(c.id) ? 'linear' : card.category === 'ic' && isSwitcher(d, card, net) ? 'switching' : undefined;
        s = { kind: 'regulator', ref: c.refdes, ...(type ? { regulator: type } : {}), ...(ins[0] ? { from: name(ins[0]) } : {}) };
      }
      if (s) (direct.get(net) ?? direct.set(net, []).get(net)!).push(s);
    }
  }

  // the series parts current flows through, away from the sources; a resistor only between two rails
  // (between a rail and a signal it is a pull-up or a divider)
  const edges = seriesEdges(d);
  const pass = (e: SeriesEdge, from?: string) => !d.components[e.componentId]?.dnp && (e.category !== 'resistor' || (rail(e.to) && (from === undefined || rail(from))));
  const from = new Map<SeriesEdge, string>([...edges].flatMap(([n, list]) => list.map((e) => [e, n] as const)));
  const depth = powerWalk(d, direct.keys(), edges, (e) => pass(e, from.get(e)));

  /** The source upstream of a net and the series parts from it down to the net. */
  const resolve = (net: string): { source: Source; through: Hop[] } => {
    const here = direct.get(net);
    if (here?.length) return { source: here[0]!, through: [] };
    const at = depth.get(net);
    const up = at === undefined ? undefined : (edges.get(net) ?? []).filter((e) => pass(e, net) && (depth.get(e.to) ?? Infinity) < at).sort((a, b) => natCmp(d.components[a.componentId]!.refdes, d.components[b.componentId]!.refdes))[0];
    if (!up) return { source: { kind: 'unknown' }, through: [] };
    const above = resolve(up.to);
    return { source: above.source, through: [...above.through, { ref: d.components[up.componentId]!.refdes, category: up.category, from: name(up.to) }] };
  };

  const rails = nets.filter((n) => rail(n.id)).sort((a, b) => natCmp(a.name, b.name));
  const byName = new Map(rails.map((n) => [n.name, n]));
  const info = new Map(rails.map((n) => [n.id, resolve(n.id)]));
  /** The rail a rail is fed from, and whether its current passes unchanged (series parts, a linear regulator). */
  const upstream = (n: Net): { rail: Net; same: boolean } | undefined => {
    const { source, through } = info.get(n.id)!;
    for (let i = through.length - 1; i >= 0; i--) {
      const r = byName.get(through[i]!.from);
      if (r) return { rail: r, same: true };
    }
    const r = source.from ? byName.get(source.from) : undefined;
    return r ? { rail: r, same: source.regulator === 'linear' } : undefined;
  };
  const amps = (n: Net): { a: number | Unknown; basis: 'max_current' | 'loads' | Unknown; loads: number } => {
    const loads = statedLoads(d, n.id).reduce((s, l) => s + l.amps, 0);
    if (n.attrs.maxCurrent && n.attrs.maxCurrent > 0) return { a: n.attrs.maxCurrent, basis: 'max_current', loads };
    return loads > 0 ? { a: loads, basis: 'loads', loads } : { a: 'unknown', basis: 'unknown', loads };
  };
  const feeds = new Map<string, { net: Net; same: boolean }[]>();
  for (const n of rails) {
    const u = upstream(n);
    if (u && u.rail.id !== n.id) (feeds.get(u.rail.id) ?? feeds.set(u.rail.id, []).get(u.rail.id)!).push({ net: n, same: u.same });
  }

  const out = rails.map((n) => {
    const { source, through } = info.get(n.id)!;
    const own = amps(n);
    const down = feeds.get(n.id) ?? [];
    let feedsA: number | Unknown | undefined;
    if (down.length) {
      const each = down.map((x) => (x.same ? amps(x.net).a : 'unknown'));
      feedsA = each.includes('unknown') ? 'unknown' : r3((each as number[]).reduce((s, a) => s + a, 0));
    }
    // the budget: max_current against the loads stated plus what the rails it feeds draw
    let budget: 'ok' | 'over' | Unknown = 'unknown';
    if (own.basis === 'max_current') {
      const drawn = own.loads + (typeof feedsA === 'number' ? feedsA : 0);
      if (drawn > (own.a as number) + 1e-9) budget = 'over';
      else if (feedsA !== 'unknown' && (own.loads > 0 || feedsA !== undefined)) budget = 'ok';
    }
    const supplies = Object.values(d.components)
      .filter((c) => !c.dnp && cardOf(d, c.part)?.pins.some((p) => p.type === 'pwr_in' && c.pins[p.number] === n.id))
      .map((c) => c.refdes)
      .sort(natCmp);
    const loads = statedLoads(d, n.id).map((l) => ({ pin: `${d.components[l.componentId]?.refdes ?? '?'}.${l.pins.join('/')}`, a: l.amps }));
    const ldo = !through.length && source.regulator === 'linear' ? [...linear.values()].find((r) => r.outNet.id === n.id && r.component.refdes === source.ref) : undefined;
    return {
      net: n.name,
      voltage: n.attrs.voltage ?? 'unknown',
      source,
      ...(through.length ? { through } : {}),
      ...(down.length ? { feeds: down.map((x) => x.net.name) } : {}),
      ...(supplies.length ? { supplies } : {}),
      ...(loads.length ? { loads } : {}),
      current: {
        max_a: own.a,
        basis: own.basis,
        ...(own.loads > 0 ? { loads_a: r3(own.loads) } : {}),
        ...(feedsA !== undefined ? { feeds_a: feedsA } : {}),
        budget,
      },
      ...(ldo
        ? {
            dissipation: {
              ref: ldo.component.refdes,
              ...(ldo.pkg ? { package: ldo.limit?.name ?? ldo.pkg } : {}),
              ...(ldo.watts !== undefined ? { watts: Math.round(ldo.watts * 100) / 100 } : {}),
              ...(ldo.limit ? { limit_w: ldo.limit.maxW } : {}),
              status: ldo.status,
              ...(ldo.missing ? { missing: ldo.missing } : {}),
            },
          }
        : {}),
    };
  });
  return out.length
    ? { rails: out }
    : { rails: [], note: 'No power nets: give each supply net a voltage (set_net voltage), and mark one that comes in on a connector external.' };
}
