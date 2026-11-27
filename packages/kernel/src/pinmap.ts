/**
 * design_query get_pinmap: which MCU pin does what, for the firmware. An MCU is a part whose card
 * lists its GPIOs' functions (SwapGroup.functions). Per signal pin on a net (pins on a power or
 * ground net left out) the net, the function in use (the net's needs, else unknown: never guessed),
 * the functions the pin offers, and the parts' pins the net reaches; on several boards each reach's
 * board and the mated pin pairs the net meets, with what is wrong where the other side is on another
 * net or none (pairState, the rule mateChecks uses). With format 'c' also a C header per MCU, built
 * from the same entries (cHeader). Read-only. See docs/design/ops-api.md §6a.
 */
import type { Component, Design, PinMap, PinMapEntry, PinMapMcu, QueryError } from '@4k7/schema';
import { cardOf, closest, componentsSorted, findComponent, isPowerNet, natCmp, netMembers, queryError } from './doc.ts';
import { boardNameOf, boardOf, multiBoard } from './boards.ts';
import { matePairs, pairState, pinLabel } from './mates.ts';

type Crossing = NonNullable<PinMapEntry['crosses']>[number];

const isMcu = (d: Design, c: Component) => !!cardOf(d, c.part)?.swapGroups?.some((g) => g.functions);

export function pinMapAnswer(d: Design, ref?: string, format: 'json' | 'c' = 'json'): PinMap | QueryError {
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
    const m: PinMapMcu = { ref: u.refdes, part: u.part, ...(multi ? { board: board(u) } : {}), pins, unused };
    return format === 'c' ? { ...m, header: cHeader(d.name, m) } : m;
  };
  return { mcus: mcus.map(mapOf) };
}

/** Upper-case C identifier: every run of other characters one "_" ("led-1" → LED_1). */
const ident = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'NET';
/** Text safe inside a C comment on one line. */
const cmt = (s: string) => s.replace(/\*\//g, '* /').replace(/\/\*/g, '/ *').replace(/\s+/g, ' ');

/**
 * The GPIO number in a pin's name, never guessed. The name's base (up to the first "/", "-", "_",
 * "(" or space) of GPIO<n>, GP<n> or IO<n> (RP2040, ESP32) gives n; P<letter><n> (AVR, STM32:
 * PB2, PA13) gives bit n of port <letter>. Any other name gives none.
 */
export function gpioOf(name: string): { n: number; port?: string } | undefined {
  const base = name.toUpperCase().split(/[-/_( ]/)[0]!;
  const g = /^(?:GPIO|GP|IO)(\d+)$/.exec(base);
  if (g) return { n: Number(g[1]) };
  const p = /^P([A-Z])(\d+)$/.exec(base);
  return p ? { n: Number(p[2]), port: p[1]! } : undefined;
}

/** A C header of the MCU's pin map: one PIN_<NET> define per signal pin. See docs/design/ops-api.md §6a. */
function cHeader(design: string, m: PinMapMcu): string {
  const guard = `PINMAP_${ident(design)}_${ident(m.ref)}_H`;
  const used = new Set<string>();
  const lines = [
    `/* Pin map of ${cmt(m.ref)} (${cmt(m.part)})${m.board ? ` on board "${cmt(m.board)}"` : ''}, design "${cmt(design)}".`,
    ' * Generated by 4k7 from the schematic (design_query get_pinmap): generate it again after a change, do not edit. */',
    `#ifndef ${guard}`,
    `#define ${guard}`,
    '',
  ];
  for (const e of m.pins) {
    const g = gpioOf(e.name);
    // a numeric suffix where two nets give the same identifier (the port define's name counts too)
    let id = `PIN_${ident(e.net)}`;
    for (let i = 2; used.has(id) || used.has(`${id}_PORT`); i++) id = `PIN_${ident(e.net)}_${i}`;
    used.add(id).add(`${id}_PORT`);
    const about = `${cmt(e.name)}, pin ${cmt(e.pin)}, ${e.uses === 'unknown' ? 'function unknown' : `uses ${cmt(e.uses.join(', '))}`}`;
    if (e.flag) lines.push(`/* WARNING: ${cmt(e.flag)} */`);
    if (!g) lines.push(`/* #define ${id}  -- ${about}: the pin name gives no GPIO number */`);
    else lines.push(`#define ${id} ${g.n}  /* ${about} */`, ...(g.port ? [`#define ${id}_PORT ${g.port}`] : []));
  }
  lines.push('', `/* Unused GPIOs: ${cmt(m.unused.join(', ')) || 'none'} */`, '', `#endif /* ${guard} */`);
  return lines.join('\n');
}
