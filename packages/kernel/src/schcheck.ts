/**
 * The SCH.* checks (docs/design/schematic-drawing.md §3): the drawing rules the kernel can measure,
 * run on the layout's view at the level the user set for each of them (Settings → Schematic). The rules marked (layout)
 * the layout follows by itself, so a finding there is a layout bug; the others say where the
 * drawing fell short, for the agent to improve with placement constraints.
 */
import { type Design, type Diagnostic, type EditOp, type LabelView, type PinView, type SchematicRule, type SchematicView, type SheetView, type SymbolView } from '@4k7/schema';
import { cardOf, natCmp } from './doc.ts';
import { clashWords, textOverlaps } from './parttext.ts';
import { supplyDir } from './scene.ts';
import { segmentsOf } from './geom.ts';
import { labelOverlaps, touches, wireCrossings, wireShape, type PinOn } from './sheetmeasures.ts';

interface Ctx {
  d: Design;
  rules: Record<string, SchematicRule>;
  out: Diagnostic[];
}

/** One diagnostic per finding, coded with the rule's id at the rule's level; nothing for a rule that is off or unknown. */
export function schematicChecks(d: Design, view: SchematicView, rules: Record<string, SchematicRule>): Diagnostic[] {
  const ctx: Ctx = { d, rules, out: [] };
  for (const sheet of view.sheets) {
    if (on(ctx, 'SCH.RAIL_UP') || on(ctx, 'SCH.GND_DOWN')) supplyChecks(ctx, sheet);
    if (on(ctx, 'SCH.RAIL_SIDE')) railSideChecks(ctx, sheet);
    if (on(ctx, 'SCH.ORTHOGONAL')) orthogonalChecks(ctx, sheet);
    if (on(ctx, 'SCH.DANGLING')) danglingChecks(ctx, sheet);
    if (on(ctx, 'SCH.TEXT_OVERLAP')) overlapChecks(ctx, sheet);
    if (on(ctx, 'SCH.JOG') || on(ctx, 'SCH.DETOUR')) shapeChecks(ctx, sheet);
    if (on(ctx, 'SCH.CROSSING')) crossingChecks(ctx, sheet);
  }
  return ctx.out;
}

const on = (ctx: Ctx, id: string) => !!ctx.rules[id] && ctx.rules[id]!.level !== 'off';

function push(ctx: Ctx, id: string, entities: string[], message: string, fixHints?: EditOp[]) {
  const rule = ctx.rules[id];
  if (!rule || rule.level === 'off') return;
  ctx.out.push({ code: id, severity: rule.level, entities, message, ...(fixHints ? { fixHints } : {}) });
}

const netName = (ctx: Ctx, id: string) => ctx.d.nets[id]?.name ?? id;
const netRef = (ctx: Ctx, id: string) => `net:${netName(ctx, id)}`;
const pinRef = (s: SymbolView, p: PinView) => `${s.refdes}.${p.name === p.number ? p.number : p.name}`;
const at = (x: number, y: number) => `(${x}, ${y})`;
const netsOn = (sheet: SheetView) => new Set(sheet.wires.map((w) => w.netId));

/** "R1", "R1 and R2", "R1, R2 and R3". */
const list = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/**
 * The entities of a finding name the net and the pins it is at, so two findings on one net (two
 * loose ends, two VIN symbols on one IC) stay apart: the Inspector lists and waivers go by code and
 * entities.
 */

type Pin = { sym: SymbolView; pin: PinView };

/** The pin at a point: the one there, else the nearest along the net's wires from it. */
function pinNear(sheet: SheetView, netId: string, x0: number, y0: number): Pin | undefined {
  const pinAt = (x: number, y: number) => {
    for (const s of sheet.symbols) for (const p of s.pins) if (p.x === x && p.y === y) return { sym: s, pin: p };
    return undefined;
  };
  const segs = sheet.wires.filter((w) => w.netId === netId).flatMap((w) => segmentsOf(w.pts));
  const seen = new Set<string>();
  const queue: [number, number][] = [[x0, y0]];
  while (queue.length) {
    const [x, y] = queue.shift()!;
    if (seen.has(`${x},${y}`)) continue;
    seen.add(`${x},${y}`);
    const p = pinAt(x, y);
    if (p) return p;
    for (const s of segs) if (touches(s, x, y)) queue.push([s[0], s[1]], [s[2], s[3]]);
  }
  return undefined;
}

/** The pin a label stands at: at its anchor, else the nearest one along its net's wires from there. */
const pinOf = (sheet: SheetView, l: LabelView) => pinNear(sheet, l.netId, l.x, l.y);

/** The pins nearest the given points of a net, as "R1.2", each once. */
function pinsNear(sheet: SheetView, netId: string, pts: [number, number][]): string[] {
  const refs = pts.map(([x, y]) => pinNear(sheet, netId, x, y)).filter((p): p is Pin => !!p).map((p) => pinRef(p.sym, p.pin));
  return [...new Set(refs)].sort(natCmp);
}

/* -------------------------------- supplies -------------------------------- */

/**
 * A standing resistor between a signal and one supply has that supply's end where its symbol
 * points: a positive rail on top (a pull-up above its wire), ground or a negative rail at the bottom.
 * Parts between two supplies (decoupling) and lying parts are left alone.
 */
function railSideChecks(ctx: Ctx, sheet: SheetView) {
  for (const s of sheet.symbols) {
    const top = s.pins.find((p) => p.side === 'top');
    const bottom = s.pins.find((p) => p.side === 'bottom');
    if (s.pins.length !== 2 || !top || !bottom) continue;
    const comp = ctx.d.components[s.componentId];
    if (!comp || cardOf(ctx.d, comp.part)?.category !== 'resistor') continue;
    const netOf = (p: PinView) => (comp.pins[p.number] ? ctx.d.nets[comp.pins[p.number]!] : undefined);
    const [up, down] = [netOf(top), netOf(bottom)];
    const dirUp = up && supplyDir(up);
    const dirDown = down && supplyDir(down);
    if (!up || !down || (dirUp && dirDown)) continue;
    const wrong = dirDown === 'up' ? { rail: down, signal: up, end: 'bottom', want: 'up' } : dirUp === 'down' ? { rail: up, signal: down, end: 'top', want: 'down' } : null;
    if (!wrong) continue;
    push(
      ctx,
      'SCH.RAIL_SIDE',
      [s.refdes, `net:${wrong.signal.name}`],
      `${s.refdes} has ${wrong.rail.name} at its ${wrong.end}: ${wrong.want === 'up' ? 'a pull-up stands above' : 'a pull-down hangs below'} ${wrong.signal.name}'s wire`,
      [{ op: 'constrain', kind: 'arrangement', a: s.refdes, value: wrong.want, strength: 'soft' }],
    );
  }
}

/** A rail symbol points up (a negative rail down), a ground symbol down: supplyDir says which. */
function supplyChecks(ctx: Ctx, sheet: SheetView) {
  for (const l of sheet.labels) {
    if (l.kind === 'net') continue;
    const net = ctx.d.nets[l.netId];
    const want = (net && supplyDir(net)) ?? (l.kind === 'ground' ? 'down' : 'up');
    if (l.dir === want) continue;
    const p = pinOf(sheet, l);
    const name = netName(ctx, l.netId);
    push(ctx, l.kind === 'ground' ? 'SCH.GND_DOWN' : 'SCH.RAIL_UP', [netRef(ctx, l.netId), ...(p ? [pinRef(p.sym, p.pin)] : [])], `${name} ${p ? `on ${pinRef(p.sym, p.pin)}` : `at ${at(l.x, l.y)}`} points ${l.dir}`);
  }
}

/* --------------------------------- wires ---------------------------------- */

/**
 * A wire runs horizontally or vertically. The lead of a part drawn at 45° (a diode on the edge of a
 * bridge's diamond) continues the part's own slant to the grid: that is the diamond, not a diagonal wire.
 */
function orthogonalChecks(ctx: Ctx, sheet: SheetView) {
  const slanted = new Set(sheet.symbols.filter((s) => (s.rotation ?? 0) % 90 !== 0).flatMap((s) => s.pins.map((p) => `${p.x},${p.y}`)));
  for (const w of sheet.wires) {
    for (const [x1, y1, x2, y2] of segmentsOf(w.pts)) {
      if (x1 === x2 || y1 === y2 || slanted.has(`${x1},${y1}`) || slanted.has(`${x2},${y2}`)) continue;
      push(ctx, 'SCH.ORTHOGONAL', [netRef(ctx, w.netId), ...pinsNear(sheet, w.netId, [[x1, y1], [x2, y2]])], `a wire of ${netName(ctx, w.netId)} runs diagonally from ${at(x1, y1)} to ${at(x2, y2)}`);
    }
  }
}

/** A wire end is on a pin, a junction, a label's anchor or another wire of its net. */
function danglingChecks(ctx: Ctx, sheet: SheetView) {
  const points = new Set<string>();
  for (const s of sheet.symbols) for (const p of s.pins) points.add(`${p.x},${p.y}`);
  for (const l of sheet.labels) points.add(`${l.x},${l.y}`);
  for (const j of sheet.junctions) points.add(`${j.x},${j.y}`);
  sheet.wires.forEach((w, i) => {
    if (w.pts.length < 4) return;
    const ends: [number, number][] = [[w.pts[0]!, w.pts[1]!], [w.pts.at(-2)!, w.pts.at(-1)!]];
    for (const [x, y] of ends) {
      const onWire = sheet.wires.some((o, j) => j !== i && o.netId === w.netId && segmentsOf(o.pts).some((s) => touches(s, x, y)));
      if (points.has(`${x},${y}`) || onWire) continue;
      // the part the wire comes from, at its other end
      const from = pinsNear(sheet, w.netId, ends.filter(([ox, oy]) => ox !== x || oy !== y));
      push(ctx, 'SCH.DANGLING', [netRef(ctx, w.netId), ...from], `a wire of ${netName(ctx, w.netId)}${from.length ? ` from ${list(from)}` : ''} ends at ${at(x, y)} on nothing`);
    }
  });
}

/* ---------------------------------- text ---------------------------------- */

/** What a label is, as the reader sees it: "the VIN symbol", "the FB label". */
const labelName = (ctx: Ctx, l: LabelView) => (l.kind === 'net' ? `the ${netName(ctx, l.netId)} label` : `the ${netName(ctx, l.netId)} symbol`);

function overlapChecks(ctx: Ctx, sheet: SheetView) {
  const nets = new Set(sheet.labels.map((l) => l.netId));
  for (const o of labelOverlaps(sheet, nets)) {
    const { label: l, hit } = o;
    const what = o.head ? (l.kind === 'rail' ? `${labelName(ctx, l)}'s name` : labelName(ctx, l)) : `${labelName(ctx, l)}'s stem`;
    const p = pinOf(sheet, l);
    const entities = [netRef(ctx, l.netId), ...(p ? [pinRef(p.sym, p.pin)] : [])];
    const add = (e: string) => entities.includes(e) || entities.push(e);
    const message = (): string => {
      switch (hit.on) {
        case 'wire':
          add(netRef(ctx, hit.net));
          return `${what} ${o.head ? 'stands on' : 'runs along'} a wire of ${netName(ctx, hit.net)}`;
        case 'symbol':
          add(hit.sym.refdes);
          return `${what} runs into ${hit.sym.refdes}${hit.sym.unit ?? ''}`;
        case 'text':
          add(hit.sym.refdes);
          return `${what} runs into ${hit.sym.refdes}${hit.sym.unit ?? ''}'s ${hit.which === 'name' ? 'name' : 'value text'}`;
        case 'label':
          if (hit.label.netId !== l.netId) add(netRef(ctx, hit.label.netId));
          return `${what} runs into ${labelName(ctx, hit.label)}`;
      }
    };
    const text = message();
    push(ctx, 'SCH.TEXT_OVERLAP', entities, text);
  }
  // a part's own name and value; on a sheet the layout draws it has found no clear spot for them
  const drawn = !!ctx.d.drawing?.[sheet.id];
  for (const c of textOverlaps(sheet)) {
    const { sym, which, hit } = c;
    const on = hit.on === 'wire' ? netRef(ctx, hit.net) : (hit.on === 'symbol' && hit.sym !== sym) || hit.on === 'text' ? hit.sym.refdes : '';
    push(ctx, 'SCH.TEXT_OVERLAP', [sym.refdes, `${sym.refdes}.${which}`, ...(on ? [on] : [])], clashWords(c, (id) => netName(ctx, id)), drawn ? [{ op: 'place_text', ref: `${sym.refdes}${sym.unit ?? ''}`, auto: true }] : undefined);
  }
}

/* ---------------------------------- shape --------------------------------- */

/** The pins the measures saw, as "R1.2", each once. */
const refs = (pins: PinOn[]) => [...new Set(pins.map((p) => pinRef(p.sym, p.sym.pins.find((q) => q.x === p.x && q.y === p.y)!)))].sort(natCmp);

function shapeChecks(ctx: Ctx, sheet: SheetView) {
  for (const net of [...netsOn(sheet)].sort((a, b) => natCmp(netName(ctx, a), netName(ctx, b)))) {
    const s = wireShape(sheet, net);
    const name = netName(ctx, net);
    for (const j of s.jogs) {
      const parts = [...new Set([j.pin, ...j.facing].map((p) => p.sym.refdes))].sort(natCmp);
      push(ctx, 'SCH.JOG', [netRef(ctx, net), ...refs([j.pin, ...j.facing])], `${list(parts)} face each other on ${name} but are not in line: the wire jogs`);
    }
    for (const [x1, y1, x2, y2] of s.detours) {
      // (the clean-up leaves a wire drawn through corners it was given: only drawing it again helps)
      const given = sheet.wires.some((w) => w.netId === net && w.via && segmentsOf(w.pts).some((g) => touches(g, x1, y1) && touches(g, x2, y2)));
      push(ctx, 'SCH.DETOUR', [netRef(ctx, net), ...pinsNear(sheet, net, [[x1, y1], [x2, y2]])], `the ${name} wire turns back on itself between ${at(x1, y1)} and ${at(x2, y2)}${given ? '; it keeps the corners given to wire: to have it drawn plainly, erase it and wire it again without them' : ''}`);
    }
  }
}

/* -------------------------------- crossings ------------------------------- */

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/** Per net, its crossings with other nets' wires, when there are more than the rule's "max N" (any number in the param). */
function crossingChecks(ctx: Ctx, sheet: SheetView) {
  const max = ctx.rules['SCH.CROSSING']?.max ?? 0;
  const by = new Map<string, Map<string, number>>();
  const count = (net: string, other: string) => {
    const m = by.get(net) ?? new Map<string, number>();
    m.set(other, (m.get(other) ?? 0) + 1);
    by.set(net, m);
  };
  for (const c of wireCrossings(sheet, netsOn(sheet))) {
    count(c.net, c.other);
    count(c.other, c.net);
  }
  for (const [net, others] of [...by].sort((a, b) => natCmp(netName(ctx, a[0]), netName(ctx, b[0])))) {
    const n = [...others.values()].reduce((a, b) => a + b, 0);
    if (n <= max) continue;
    const with_ = [...others].sort((a, b) => b[1] - a[1] || natCmp(netName(ctx, a[0]), netName(ctx, b[0]))).map(([o, k]) => `${netName(ctx, o)} ${times(k)}`);
    push(ctx, 'SCH.CROSSING', [netRef(ctx, net)], `${netName(ctx, net)} crosses ${list(with_)}: ${n} crossing${n === 1 ? '' : 's'}, max ${max}`);
  }
}
