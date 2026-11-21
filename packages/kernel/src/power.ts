/**
 * The power walk: how supply flows from net to net through series parts (seriesPaths: resistors,
 * inductors, diodes, fuses, ferrite beads, a choke's windings), and where a net's current comes in.
 * powerChecks (checks.ts) uses it to tell a driven net, the current check (current.ts) to find a
 * net's source. See docs/design/layout.md §14.
 */
import { seriesPaths } from '@4k7/parts';
import type { Design } from '@4k7/schema';
import { cardOf } from './doc.ts';

/** One series part's path between two nets: from `net` (its pin there) to `to`. */
export interface SeriesEdge {
  to: string;
  componentId: string;
  /** Its pin on the net the edge starts from. */
  pin: string;
  category: string;
}

/** The series parts between the nets, both ways: net id → the edges leaving it. */
export function seriesEdges(d: Design): Map<string, SeriesEdge[]> {
  const edges = new Map<string, SeriesEdge[]>();
  const add = (from: string, e: SeriesEdge) => (edges.get(from) ?? edges.set(from, []).get(from)!).push(e);
  for (const c of Object.values(d.components)) {
    const card = cardOf(d, c.part);
    for (const [x, y] of card ? seriesPaths(card) : []) {
      const [a, b] = [c.pins[x], c.pins[y]];
      if (!a || !b || a === b) continue;
      add(a, { to: b, componentId: c.id, pin: x, category: card!.category });
      add(b, { to: a, componentId: c.id, pin: y, category: card!.category });
    }
  }
  return edges;
}

/** The nets reached from `driven` through series parts (breadth first); `depth` how many parts away. */
export function powerWalk(d: Design, driven: Iterable<string>, edges = seriesEdges(d), pass: (e: SeriesEdge) => boolean = () => true): Map<string, number> {
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const n of driven) if (!depth.has(n)) (depth.set(n, 0), queue.push(n));
  while (queue.length) {
    const n = queue.shift()!;
    for (const e of edges.get(n) ?? []) {
      if (depth.has(e.to) || !pass(e)) continue;
      depth.set(e.to, depth.get(n)! + 1);
      queue.push(e.to);
    }
  }
  return depth;
}

/** A pin where a net's current comes in. */
export interface PowerSource {
  componentId: string;
  pins: string[];
  why: 'pwr_out' | 'connector' | 'series';
}

/**
 * Where each net's current comes in, inferred: its `pwr_out` pins, a connector's pins on an
 * external net, and the far pin of a series part (inductor, ferrite bead, fuse, diode: not a
 * resistor, which feeds a divider or a pull-up more often than a rail) from a net nearer the
 * supply. One entry per part.
 */
export function powerSources(d: Design): Map<string, PowerSource[]> {
  const out = new Map<string, PowerSource[]>();
  const add = (net: string, s: Omit<PowerSource, 'pins'>, pin: string) => {
    const list = out.get(net) ?? out.set(net, []).get(net)!;
    const had = list.find((x) => x.componentId === s.componentId);
    if (had) {
      if (!had.pins.includes(pin)) had.pins.push(pin);
    } else list.push({ ...s, pins: [pin] });
  };
  const seeds = new Set<string>();
  for (const c of Object.values(d.components)) {
    const card = cardOf(d, c.part);
    if (!card || c.dnp) continue;
    for (const p of card.pins) {
      const net = c.pins[p.number];
      if (!net) continue;
      if (p.type === 'pwr_out') (add(net, { componentId: c.id, why: 'pwr_out' }, p.number), seeds.add(net));
      else if (card.category === 'connector' && d.nets[net]?.attrs.external) (add(net, { componentId: c.id, why: 'connector' }, p.number), seeds.add(net));
    }
  }
  const edges = seriesEdges(d);
  const series = (e: SeriesEdge) => e.category !== 'resistor' && !d.components[e.componentId]?.dnp;
  const depth = powerWalk(d, seeds, edges, series);
  // the far pin of a series part whose other end is nearer the supply
  for (const [net, list] of edges) {
    const here = depth.get(net);
    if (here === undefined || here === 0) continue;
    for (const e of list) {
      const there = depth.get(e.to);
      if (series(e) && there !== undefined && there < here) add(net, { componentId: e.componentId, why: 'series' }, e.pin);
    }
  }
  return out;
}
