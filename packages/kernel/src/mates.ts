/**
 * Mates: how the boards of a design are joined, a connector on each (docs/design/multi-board.md §3).
 * A mate says which pin of one connector meets which of the other, from its kind (a stack: from
 * the two footprints facing each other) or an explicit map, and the checks hold the nets to it:
 * two mated pins on different nets, a signal that ends at a mated pin, a net on two boards that no
 * mated pin carries across, a net's current against the pins that carry it.
 */
import { footprintFor, packageOf } from '@4k7/parts';
import type { Component, Design, Diagnostic, EditOp, Mate, OpResult, PartCard, PartPin } from '@4k7/schema';
import { cardOf, isAutoNet, natCmp, netMembers, nextId, reject, resolveComponent } from './doc.ts';
import { boardOf, multiBoard } from './boards.ts';
import { statedLoads } from './current.ts';

/** Pads closer than this land on each other (mm). */
const LAND_MM = 0.2;

/** A pin by name or number (a name several pins share: the first of them). */
function pinOf(card: PartCard, ref: string): PartPin | undefined {
  return card.pins.find((p) => p.number === ref) ?? card.pins.find((p) => p.name === ref) ?? card.pins.find((p) => p.name.toUpperCase() === ref.toUpperCase());
}

/** "J2.3", or "J2.SDA" where the pin has a name. */
export function pinLabel(c: Component, card: PartCard | undefined, number: string): string {
  const p = card?.pins.find((x) => x.number === number);
  return `${c.refdes}.${p && p.name !== p.number ? p.name : number}`;
}

/** A connector's pads, top view in its footprint's frame, by pin number; or why there are none. */
function padsOf(d: Design, c: Component): { n: string; x: number; y: number }[] | string {
  const card = cardOf(d, c.part);
  const pkg = card && packageOf(card, c.params, d.packageDefaults);
  const fp = pkg ? footprintFor(pkg, card!.pins.map((p) => p.number)) : null;
  if (!card || !fp?.ok) return `${c.refdes} has no footprint`;
  const pins = new Set(card.pins.map((p) => p.number));
  const seen = new Set<string>();
  return fp.footprint.pads.filter((p) => pins.has(p.number) && !seen.has(p.number) && !!seen.add(p.number)).map((p) => ({ n: p.number, x: p.x, y: p.y }));
}

/**
 * A stack: the two footprints face each other, so b's is seen mirrored; the boards may stand at
 * any quarter turn to each other. Each pad of a meets the pad of b it lands on, for the turn at
 * which every pad lands (pin 1 on pin 1 where a turn gives that, else the first that fits).
 */
function stackPairs(d: Design, a: Component, b: Component): { pairs: [string, string][]; fit?: string } {
  const pa = padsOf(d, a);
  const pb = padsOf(d, b);
  if (typeof pa === 'string') return { pairs: [], fit: pa };
  if (typeof pb === 'string') return { pairs: [], fit: pb };
  if (pa.length !== pb.length) return { pairs: [], fit: `${a.refdes} has ${pa.length} pins and ${b.refdes} ${pb.length}: they do not plug into each other` };
  const centre = (ps: { x: number; y: number }[]) => [ps.reduce((s, p) => s + p.x, 0) / ps.length, ps.reduce((s, p) => s + p.y, 0) / ps.length] as const;
  const [ax, ay] = centre(pa);
  const fits: [string, string][][] = [];
  for (const turn of [0, 1, 2, 3]) {
    const q = pb.map((p) => {
      let [x, y] = [-p.x, p.y];
      for (let i = 0; i < turn; i++) [x, y] = [-y, x];
      return { n: p.n, x, y };
    });
    const [bx, by] = centre(q);
    const pairs: [string, string][] = [];
    for (const p of pa) {
      const hit = q.find((o) => Math.abs(o.x - bx - (p.x - ax)) < LAND_MM && Math.abs(o.y - by - (p.y - ay)) < LAND_MM);
      if (!hit) break;
      pairs.push([p.n, hit.n]);
    }
    if (pairs.length === pa.length) fits.push(pairs);
  }
  if (!fits.length) return { pairs: [], fit: `the pads of ${a.refdes} and ${b.refdes} do not land on each other (another pitch or layout): they do not plug into each other` };
  const first = [...pa].sort((x, y) => natCmp(x.n, y.n))[0]!.n;
  return { pairs: fits.find((ps) => ps.some(([x, y]) => x === first && y === first)) ?? fits[0]! };
}

/** By pin number: n to n, or reversed n to N+1−n. */
function numberPairs(d: Design, a: Component, b: Component, reversed: boolean): { pairs: [string, string][]; fit?: string } {
  const na = (cardOf(d, a.part)?.pins ?? []).map((p) => p.number).sort(natCmp);
  const nb = (cardOf(d, b.part)?.pins ?? []).map((p) => p.number).sort(natCmp);
  if (na.length !== nb.length) return { pairs: [], fit: `${a.refdes} has ${na.length} pins and ${b.refdes} ${nb.length}: say which meets which with map` };
  return { pairs: na.map((n, i) => [n, reversed ? nb[nb.length - 1 - i]! : nb[i]!]) };
}

/** Which pin of a meets which of b (pin numbers), and why the two do not fit where they do not. */
export function matePairs(d: Design, m: Mate): { pairs: [string, string][]; fit?: string } {
  const a = d.components[m.a];
  const b = d.components[m.b];
  if (!a || !b) return { pairs: [] };
  if (m.map) return { pairs: m.map };
  if (m.kind === 'stack') return stackPairs(d, a, b);
  return numberPairs(d, a, b, m.kind === 'cable' && m.cable === 'reversed');
}

/** The pairs as the agent reads them: "1↔1, 2↔2" (by name where the pins have names). */
export function pairsText(d: Design, m: Mate, pairs: [string, string][]): string {
  const a = d.components[m.a];
  const b = d.components[m.b];
  if (!a || !b) return '';
  const name = (c: Component, n: string) => pinLabel(c, cardOf(d, c.part), n).slice(c.refdes.length + 1);
  return pairs.map(([x, y]) => `${name(a, x)}↔${name(b, y)}`).join(', ');
}

/* ---------------------------------- ops ----------------------------------- */

export function addMate(d: Design, op: Extract<EditOp, { op: 'mate' }>): OpResult {
  const a = resolveComponent(d, op.a);
  const b = resolveComponent(d, op.b);
  if (a.id === b.id) reject({ code: 'INVALID_OP', message: `A mate joins two connectors; ${a.refdes} is given twice.` });
  if (!multiBoard(d) || boardOf(d, a) === boardOf(d, b)) {
    reject({ code: 'BOARD_INVALID', message: `${a.refdes} and ${b.refdes} are on the same board: a mate joins two boards (add_board, assign_board). On one board, connect the pins with connect.` });
  }
  const mates = Object.values(d.mates ?? {});
  const same = mates.find((m) => (m.a === a.id && m.b === b.id) || (m.a === b.id && m.b === a.id));
  for (const c of [a, b]) {
    const other = mates.find((m) => m !== same && (m.a === c.id || m.b === c.id));
    if (other) reject({ code: 'INVALID_OP', message: `${c.refdes} is mated already (${other.id}, with ${d.components[other.a === c.id ? other.b : other.a]?.refdes}); a connector mates once. remove_mate first.` });
  }
  if (op.kind === 'wire' && !op.map) reject({ code: 'INVALID_OP', message: 'A wire mate needs map: which pin of each is wired to which.' });
  if (op.cable !== undefined && op.kind !== 'cable') reject({ code: 'INVALID_OP', message: 'cable is for kind cable.' });
  if (op.height_mm !== undefined && op.kind !== 'stack') reject({ code: 'INVALID_OP', message: 'height_mm is for kind stack (the distance between the stacked boards).' });
  let map: [string, string][] | undefined;
  if (op.map) {
    const ca = cardOf(d, a.part)!;
    const cb = cardOf(d, b.part)!;
    map = op.map.map(([x, y]) => {
      const pa = pinOf(ca, x);
      const pb = pinOf(cb, y);
      if (!pa) reject({ code: 'PIN_UNKNOWN', message: `${a.refdes} has no pin "${x}".`, candidates: ca.pins.map((p) => p.number) });
      if (!pb) reject({ code: 'PIN_UNKNOWN', message: `${b.refdes} has no pin "${y}".`, candidates: cb.pins.map((p) => p.number) });
      return [pa!.number, pb!.number];
    });
    for (const side of [0, 1] as const) {
      const twice = map.map((p) => p[side]).find((n, i, all) => all.indexOf(n) !== i);
      if (twice) reject({ code: 'INVALID_OP', message: `map names pin ${twice} of ${(side ? b : a).refdes} twice.` });
    }
  }
  const id = same?.id ?? nextId(d, 'm');
  const m: Mate = { id, a: a.id, b: b.id, kind: op.kind, ...(op.cable ? { cable: op.cable } : {}), ...(map ? { map } : {}), ...(op.length_mm ? { length_mm: op.length_mm } : {}), ...(op.height_mm ? { height_mm: op.height_mm } : {}) };
  d.mates = { ...d.mates, [id]: m };
  const { pairs, fit } = matePairs(d, m);
  const said = fit ? `; they do not fit: ${fit}` : `: ${pairsText(d, m, pairs)}`;
  return { op: 'mate', effect: `${same ? 'changed' : 'mated'} ${a.refdes} ↔ ${b.refdes} (${op.kind}${op.cable ? `, ${op.cable}` : ''})${said}`, ids: [id] };
}

export function removeMate(d: Design, op: Extract<EditOp, { op: 'remove_mate' }>): OpResult {
  const mates = Object.values(d.mates ?? {});
  const c = d.mates?.[op.ref] ? undefined : resolveComponent(d, op.ref);
  const m = d.mates?.[op.ref] ?? mates.find((x) => x.a === c!.id || x.b === c!.id);
  if (!m) reject({ code: 'INVALID_OP', message: `${c?.refdes ?? op.ref} is in no mate.`, candidates: mates.map((x) => x.id) });
  delete d.mates![m!.id];
  if (!Object.keys(d.mates!).length) delete d.mates;
  return { op: 'remove_mate', effect: `removed mate ${d.components[m!.a]?.refdes} ↔ ${d.components[m!.b]?.refdes}`, ids: [m!.id] };
}

/** Mates of parts that are gone go; with one board again, all of them. */
export function tidyMates(d: Design) {
  if (!d.mates) return;
  const one = !multiBoard(d);
  for (const m of Object.values(d.mates)) if (one || !d.components[m.a] || !d.components[m.b]) delete d.mates[m.id];
  if (!Object.keys(d.mates).length) delete d.mates;
}

/* --------------------------------- checks --------------------------------- */

export function mateChecks(d: Design): Diagnostic[] {
  if (!multiBoard(d)) return [];
  const out: Diagnostic[] = [];
  const name = (id: string) => d.boards?.[id]?.name ?? id;
  const netName = (id: string | undefined) => (id ? d.nets[id]?.name ?? '?' : '');
  /** For each net, the board pairs it is carried between by a mated pin pair. */
  const carried = new Map<string, [string, string][]>();
  for (const m of Object.values(d.mates ?? {})) {
    const a = d.components[m.a];
    const b = d.components[m.b];
    if (!a || !b) continue;
    const ca = cardOf(d, a.part);
    const cb = cardOf(d, b.part);
    const [ba, bb] = [boardOf(d, a), boardOf(d, b)];
    if (ba === bb) {
      out.push({ code: 'ERC.MATE_SAME_BOARD', severity: 'warning', entities: [a.refdes, b.refdes], message: `${a.refdes} and ${b.refdes} are mated but both on board "${name(ba)}": a mate joins two boards. Move one (assign_board) or remove the mate (remove_mate).` });
      continue;
    }
    const { pairs, fit } = matePairs(d, m);
    if (fit) {
      out.push({ code: 'ERC.MATE_FIT', severity: 'error', entities: [a.refdes, b.refdes], message: `${a.refdes} (board "${name(ba)}") and ${b.refdes} (board "${name(bb)}") are mated (${m.kind}), but ${fit}. Use connectors that mate, or say which pin meets which with map.` });
      continue;
    }
    const wrong: string[] = [];
    /** Per net, the mated pin pairs that carry it here. */
    const through = new Map<string, [string, string][]>();
    for (const [pa, pb] of pairs) {
      const [na, nb] = [a.pins[pa], b.pins[pb]];
      const [la, lb] = [pinLabel(a, ca, pa), pinLabel(b, cb, pb)];
      if (na && nb && na !== nb) {
        wrong.push(la);
        out.push({ code: 'ERC.MATE_MISMATCH', severity: 'error', entities: [la, lb], message: `${la} (${netName(na)}) meets ${lb} (${netName(nb)}) through the ${m.kind}: two nets joined.` });
      } else if (na && !nb && !b.noConnect.includes(pb)) {
        out.push({ code: 'ERC.MATE_OPEN', severity: 'warning', entities: [lb], message: `${la} is on ${netName(na)}, but the pin it meets, ${lb}, is on no net: ${netName(na)} ends at the connector on board "${name(bb)}".` });
      } else if (nb && !na && !a.noConnect.includes(pa)) {
        out.push({ code: 'ERC.MATE_OPEN', severity: 'warning', entities: [la], message: `${lb} is on ${netName(nb)}, but the pin it meets, ${la}, is on no net: ${netName(nb)} ends at the connector on board "${name(ba)}".` });
      } else if (na && na === nb) {
        carried.set(na, [...(carried.get(na) ?? []), [ba, bb]]);
        through.set(na, [...(through.get(na) ?? []), [pa, pb]]);
      }
    }
    out.push(...mateCurrent(d, m, through));
    // several pins wrong at once: the connector is mirrored or shifted, more likely than each net wrong
    if (wrong.length > 1) {
      const last = out.filter((x) => x.code === 'ERC.MATE_MISMATCH').at(-1)!;
      last.message += ` ${wrong.length} pins of ${a.refdes} ↔ ${b.refdes} disagree (${wrong.slice(0, 6).join(', ')}${wrong.length > 6 ? ', …' : ''}): is a footprint mirrored, turned or one pin off? The mate's pins: ${pairsText(d, m, pairs)}.`;
    }
  }
  // a net on several boards is carried between each of them by a mated pin pair
  for (const [net, pins] of netMembers(d)) {
    const n = d.nets[net];
    if (!n) continue;
    const on = new Map<string, string[]>();
    for (const p of pins) on.set(boardOf(d, p.comp), [...(on.get(boardOf(d, p.comp)) ?? []), p.comp.refdes]);
    if (on.size < 2) continue;
    // the boards that reach one another through mated pins of this net
    const group = new Map([...on.keys()].map((b) => [b, b]));
    const root = (b: string): string => (group.get(b) === b ? b : root(group.get(b)!));
    for (const [x, y] of carried.get(net) ?? []) if (group.has(x) && group.has(y)) group.set(root(x), root(y));
    const parts = new Map<string, string[]>();
    for (const b of on.keys()) parts.set(root(b), [...(parts.get(root(b)) ?? []), b]);
    if (parts.size < 2) continue;
    const where = [...on].map(([b, refs]) => `"${name(b)}" (${[...new Set(refs)].sort(natCmp).slice(0, 4).join(', ')}${new Set(refs).size > 4 ? ', …' : ''})`).join(' and ');
    const label = isAutoNet(n) ? `The net of ${pins[0]!.comp.refdes}` : n.name;
    out.push({
      code: 'ERC.BOARD_CROSSING',
      severity: 'error',
      entities: [`net:${n.name}`],
      message: `${label} has pins on ${where}, but no mated connector pin carries it from one board to the other: on the boards it is ${parts.size} nets. Put a pin of each mated connector on it${Object.keys(d.mates ?? {}).length ? '' : ' (join the boards with mate first)'}.`,
    });
  }
  return out;
}

const amps = (a: number) => `${Math.round(a * 1000) / 1000} A`;

/**
 * ERC.MATE_CURRENT: a net's current against the mated pin pairs that carry it, each pair rated the
 * lower of its two pins' maxCurrent (one side's where only one card states it). The current is the
 * net's max_current, else the sum of its stated loads: an upper bound, as in the copper's current
 * check (layout.md §14). Unrated pins where the rated ones do not suffice: ERC.MATE_CURRENT_UNKNOWN
 * (info, not fine); no current known: nothing. See docs/design/multi-board.md §3.1.
 */
function mateCurrent(d: Design, m: Mate, through: Map<string, [string, string][]>): Diagnostic[] {
  const a = d.components[m.a]!;
  const b = d.components[m.b]!;
  const ca = cardOf(d, a.part);
  const cb = cardOf(d, b.part);
  const out: Diagnostic[] = [];
  for (const [id, pairs] of through) {
    const n = d.nets[id];
    if (!n) continue;
    const own = n.attrs.maxCurrent && n.attrs.maxCurrent > 0 ? n.attrs.maxCurrent : undefined;
    const loads = statedLoads(d, id).reduce((s, l) => s + l.amps, 0);
    const want = own ?? (loads > 0 ? loads : undefined);
    if (!want) continue;
    const basis = own ? 'max_current' : 'its stated loads';
    const rates = pairs.map(([pa, pb]) => {
      const r = [ca?.pins.find((p) => p.number === pa)?.maxCurrent, cb?.pins.find((p) => p.number === pb)?.maxCurrent].filter((x): x is number => x !== undefined);
      return r.length ? Math.min(...r) : undefined;
    });
    const rated = rates.filter((x): x is number => x !== undefined);
    const total = rated.reduce((s, x) => s + x, 0);
    if (total >= want - 1e-9) continue;
    const label = isAutoNet(n) ? `The net of ${pinLabel(a, ca, pairs[0]![0])}` : n.name;
    const pins = `${pairs.length} mated pin pair${pairs.length > 1 ? 's' : ''} (${pairsText(d, m, pairs)})`;
    const entities = [`net:${n.name}`, a.refdes, b.refdes];
    if (rated.length < rates.length) {
      out.push({ code: 'ERC.MATE_CURRENT_UNKNOWN', severity: 'info', entities, message: `${label} carries up to ${amps(want)} (${basis}) through ${a.refdes} ↔ ${b.refdes} on ${pins}, but ${rated.length ? 'some of these pins have' : 'the connector\'s card has'} no current rating, so whether the pins carry it is unknown (not checked, not fine). Look the contact rating up in the connector's datasheet, and put the net on enough pins for it.` });
      continue;
    }
    const each = Math.min(...rated);
    out.push({ code: 'ERC.MATE_CURRENT', severity: 'error', entities, message: `${label} carries up to ${amps(want)} (${basis}) through ${a.refdes} ↔ ${b.refdes} on ${pins}, rated ${amps(total)} in all (${amps(each)} per pin). Put the net on more pin pairs of the connector (at least ${Math.ceil(want / each - 1e-9)}), or use a connector rated for more.` });
  }
  return out;
}
