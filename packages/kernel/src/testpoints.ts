/**
 * Test points (add_test_points): a pad on each net to probe at bring-up, at the part that drives
 * the net, named TP<n> and labelled TP_<net> on the silkscreen. See docs/design/layout.md §4.
 */
import type { Component, Design, EditOp, Net, OpResult, PartCard } from '@4k7/schema';
import { addPart, connect } from './netops.ts';
import { cardOf, componentsSorted, findNet, isAutoNet, isGroundNet, isPowerNet, natCmp, nextId, reject } from './doc.ts';

/** The pad test point add_test_points adds (generic:TP, a 1.5 mm SMD pad). */
const TEST_POINT = 'generic:TP';

/** A test point: a one-pin part named TP… (the library's pad and loop, or one imported). */
export function isTestPoint(card: PartCard | undefined): boolean {
  return !!card && card.refPrefix === 'TP' && card.pins.length === 1;
}

/** What a test point's silkscreen says: TP_<its net>, or nothing (the refdes) while it is on no named net. */
export function testPointLabel(d: Design, c: Component, card: PartCard): string | undefined {
  if (!isTestPoint(card)) return undefined;
  const net = d.nets[c.pins[card.pins[0]!.number] ?? ''];
  return net && !isAutoNet(net) ? `TP_${net.name}` : undefined;
}

/**
 * The pin a net comes from, where its test point goes: a power or signal output (a regulator's),
 * else the connector it comes in on, else the series part feeding it (an inductor, a diode), else
 * an IC on it, else its first part.
 */
function sourcePin(d: Design, net: Net): { comp: Component; pin: string } | undefined {
  const rank = (card: PartCard, type: string) =>
    type === 'pwr_out' || type === 'out' ? 0 : card.category === 'connector' ? 1 : card.category === 'inductor' ? 2 : card.category === 'diode' ? 3 : card.category === 'ic' ? 4 : 5;
  const on: { comp: Component; pin: string; rank: number }[] = [];
  for (const c of componentsSorted(d)) {
    const card = cardOf(d, c.part);
    if (!card || isTestPoint(card)) continue;
    for (const p of card.pins) if (c.pins[p.number] === net.id) on.push({ comp: c, pin: p.number, rank: rank(card, p.type) });
  }
  return on.sort((a, b) => a.rank - b.rank || natCmp(a.comp.refdes, b.comp.refdes) || natCmp(a.pin, b.pin))[0];
}

export function addTestPoints(d: Design, op: Extract<EditOp, { op: 'add_test_points' }>, by: 'user' | 'agent'): OpResult {
  const nets: Net[] = [];
  for (const name of op.nets) {
    if (name.toLowerCase() === 'rails') {
      nets.push(...Object.values(d.nets).filter((n) => isPowerNet(n) && !isGroundNet(n) && !isAutoNet(n)).sort((a, b) => natCmp(a.name, b.name)));
      continue;
    }
    const net = findNet(d, name);
    if (!net) reject({ code: 'NET_UNKNOWN', message: `No net "${name}" to put a test point on ("rails" stands for every supply rail).`, candidates: Object.values(d.nets).filter((n) => !isAutoNet(n)).map((n) => n.name).sort(natCmp) });
    nets.push(net);
  }
  // a net with a test point already (one added before, or the user's own) gets no second one
  const probed = new Set(Object.values(d.components).flatMap((c) => (isTestPoint(cardOf(d, c.part)) ? Object.values(c.pins) : [])));
  const added: string[] = [];
  const ids: string[] = [];
  for (const net of nets) {
    if (probed.has(net.id)) continue;
    probed.add(net.id);
    const id = addPart(d, { op: 'add_part', part: TEST_POINT }).ids![0]!;
    const tp = d.components[id]!;
    connect(d, [`${tp.refdes}.1`], net.name);
    // at the pin the net comes from, as attach says it (the placer puts it there and it follows that part)
    const src = sourcePin(d, net);
    if (src) {
      const k = nextId(d, 'k');
      d.ledger[k] = { id: k, kind: 'belongs', a: tp.id, b: src.comp.id, key: src.pin, domain: 'placement', strength: 'soft', source: { type: by } };
      ids.push(k);
    }
    ids.push(id);
    added.push(`${tp.refdes} on ${net.name}${src ? ` at ${src.comp.refdes}` : ''}`);
  }
  const skipped = nets.length - added.length;
  const had = skipped ? `${skipped} net${skipped > 1 ? 's' : ''} already had one` : '';
  return { op: 'add_test_points', effect: added.length ? `added test points ${added.join(', ')}${had ? `; ${had}` : ''}` : `no test points added: ${had || 'no supply rails'}`, ids };
}
