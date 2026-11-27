/**
 * design_query get_pinmap: which MCU pin does what, for the firmware. An MCU is a part whose card
 * lists its GPIOs' functions (SwapGroup.functions). Per signal pin on a net (pins on a power or
 * ground net left out) the net, the function in use (the net's needs, else unknown: never guessed),
 * the functions the pin offers, and the parts' pins the net reaches; on several boards each reach's
 * board and the mated pin pairs the net meets, with what is wrong where the other side is on another
 * net or none (pairState, the rule mateChecks uses). Read-only. See docs/design/ops-api.md §6a.
 */
import type { Component, Design, PinMap, PinMapEntry, PinMapMcu, QueryError } from '@4k7/schema';
import { cardOf, closest, componentsSorted, findComponent, isPowerNet, natCmp, netMembers, queryError } from './doc.ts';
import { boardNameOf, boardOf, multiBoard } from './boards.ts';
import { matePairs, pairState, pinLabel } from './mates.ts';

type Crossing = NonNullable<PinMapEntry['crosses']>[number];

const isMcu = (d: Design, c: Component) => !!cardOf(d, c.part)?.swapGroups?.some((g) => g.functions);

export function pinMapAnswer(d: Design, ref?: string): PinMap | QueryError {
  let mcus = componentsSorted(d).filter((c) => isMcu(d, c));
  if (ref !== undefined) {
    const c = findComponent(d, ref);
    if (!c) return queryError(`No component ${ref}`, 'REF_UNKNOWN', closest(ref, Object.values(d.components).map((x) => x.refdes)));
    if (!isMcu(d, c)) return { mcus: [], note: `${c.refdes} is no MCU: its card lists no GPIO functions (swap groups with functions). MCUs here: ${mcus.map((m) => m.refdes).join(', ') || 'none'}.` };
    mcus = [c];
  }
  if (!mcus.length) return { mcus: [], note: 'No MCU in the design: get_pinmap maps a part whose card lists its GPIOs\' functions (swap groups with functions).' };

  const multi = multiBoard(d);
  const board = (c: Component) => boardNameOf(d, boardOf(d, c));
  const netName = (id: string | undefined) => (id ? d.nets[id]?.name ?? id : '');
  const members = netMembers(d);
  // every mated pin pair between two boards, with its state
  const mated: { mate: string; a: Component; b: Component; pa: string; pb: string }[] = [];
  for (const m of Object.values(d.mates ?? {}).sort((x, y) => natCmp(x.id, y.id))) {
    const [a, b] = [d.components[m.a], d.components[m.b]];
    if (!multi || !a || !b || boardOf(d, a) === boardOf(d, b)) continue;
    for (const [pa, pb] of matePairs(d, m).pairs) mated.push({ mate: m.id, a, b, pa, pb });
  }

  const mapOf = (u: Component): PinMapMcu => {
    const card = cardOf(d, u.part)!;
    const groups = card.swapGroups!.filter((g) => g.functions);
    const offers = (n: string) => [...new Set(groups.flatMap((g) => g.functions![n] ?? []))];
    const gpio = new Set(groups.flatMap((g) => g.members.flat()));
    const label = (n: string) => `${card.pins.find((p) => p.number === n)?.name ?? n} (pin ${n})`;
    const pins: PinMapEntry[] = [];
    for (const p of card.pins) {
      const net = u.pins[p.number];
      const n = net && d.nets[net];
      if (!n || isPowerNet(n)) continue;
      const crosses: Crossing[] = [];
      const atMate = new Set<string>();
      for (const x of mated) {
        if (x.a.pins[x.pa] !== net && x.b.pins[x.pb] !== net) continue;
        // the side on the MCU's board (or the one on the net) first
        const flip = boardOf(d, x.b) === boardOf(d, u) || (boardOf(d, x.a) !== boardOf(d, u) && x.a.pins[x.pa] !== net);
        const [a, b, pa, pb] = flip ? [x.b, x.a, x.pb, x.pa] : [x.a, x.b, x.pa, x.pb];
        const [la, lb] = [pinLabel(a, cardOf(d, a.part), pa), pinLabel(b, cardOf(d, b.part), pb)];
        atMate.add(la).add(lb);
        const state = pairState(a, b, pa, pb);
        const problem =
          state === 'mismatch' ? `${la} (${netName(a.pins[pa])}) meets ${lb} (${netName(b.pins[pb])}): two nets joined`
          : state === 'open_b' ? `${lb} is on no net: ${n.name} ends at ${la}`
          : state === 'open_a' ? `${la} is on no net: ${n.name} ends at ${lb}`
          : undefined;
        crosses.push({ mate: x.mate, pins: `${la} ⇄ ${lb}`, boards: [board(a), board(b)], ...(problem ? { problem } : {}) });
      }
      const reaches = (members.get(net) ?? [])
        .filter((m) => !(m.comp.id === u.id && m.pin.number === p.number))
        .map((m) => ({ pin: pinLabel(m.comp, cardOf(d, m.comp.part), m.pin.number), comp: m.comp }))
        .filter((r) => !atMate.has(r.pin))
        .map((r) => ({ pin: r.pin, ...(multi ? { board: board(r.comp) } : {}) }));
      const uses = n.attrs.needs?.length ? n.attrs.needs : ('unknown' as const);
      const problems = crosses.flatMap((c) => c.problem ?? []);
      const near = reaches.filter((r) => !multi || r.board === board(u)).map((r) => r.pin);
      const far = reaches.filter((r) => multi && r.board !== board(u)).map((r) => `${r.pin} on "${r.board}"`);
      const legs = [
        ...(near.length ? [near.join(', ')] : []),
        ...(crosses.length ? [`${crosses.map((c) => c.pins + (c.problem ? ` ⚠ ${c.problem}` : '')).join(', ')}${far.length ? ` → ${far.join(', ')}` : ''}`] : far.length ? [far.join(', ')] : []),
      ];
      const text = `${label(p.number)} → ${n.name} (${uses === 'unknown' ? 'function unknown' : `uses ${uses.join(', ')}`}) → ${legs.join('; ') || 'nothing else'}`;
      pins.push({ pin: p.number, name: p.name, net: n.name, uses, offers: offers(p.number), reaches, ...(crosses.length ? { crosses } : {}), ...(problems.length ? { flag: problems.join('; ') } : {}), text });
    }
    const unused = card.pins.filter((p) => gpio.has(p.number) && !u.pins[p.number]).map((p) => p.number).sort(natCmp).map(label);
    return { ref: u.refdes, part: u.part, ...(multi ? { board: board(u) } : {}), pins, unused };
  };
  return { mcus: mcus.map(mapOf) };
}
