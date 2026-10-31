import { afterAll, describe, expect, it } from 'vitest';
import { registerUserParts, unregisterUserPart } from '@4k7/parts';
import type { Design, PartCard, SheetView } from '@4k7/schema';
import { Kernel } from '../src/index.ts';

const NAMES: Record<string, string> = { '1': 'GND_A1', '2': 'GND_B12', '3': 'VBUS_A4', '4': 'CC1_A5', '5': 'SHELL', '6': 'VBUS_B9' };
/** A connector as an import lays it out, drawn the way it was before its pins' names showed. */
const usbc: PartCard = {
  id: 'acme:USBC-NAMES',
  mpn: 'USBC-NAMES',
  description: 'USB Type-C receptacle',
  category: 'connector',
  refPrefix: 'J',
  pins: Object.keys(NAMES).map((number) => ({ number, name: NAMES[number]!, type: 'passive' as const })),
  params: {},
  provenance: { source: 'datasheet' },
  symbolLayout: { left: [['3'], ['6'], ['4'], ['5']], right: [], top: [], bottom: [['1'], ['2']] },
};
registerUserParts([usbc]);
afterAll(() => unregisterUserPart(usbc.id));

const sheetOf = (k: Kernel): SheetView => k.state().view.sheets[0]!;
const pinOf = (k: Kernel, ref: string, number: string) => sheetOf(k).symbols.find((s) => s.refdes === ref)!.pins.find((p) => p.number === number)!;
function ok(k: Kernel, ops: unknown[]) {
  const r = k.transact({ summary: 'edit', ops } as never);
  expect(r.status, JSON.stringify(r)).toBe('ok');
  k.accept();
}

/** The design as a version before this change stored it: its card has names, its drawing the shape without them. */
function storedBefore(ops: unknown[], extra: unknown[] = []): Design {
  const k = new Kernel();
  const d = k.committedDesign();
  d.parts[usbc.id] = { ...usbc, pins: usbc.pins.map((p) => ({ ...p, name: p.number })) };
  k.load(d);
  ok(k, [
    { op: 'add_part', part: usbc.id, refdes: 'J1' },
    { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '5k1' } },
    { op: 'connect', pins: ['J1.1', 'J1.2', 'J1.5'], net: 'GND' },
    { op: 'connect', pins: ['J1.3', 'J1.6'], net: 'VBUS' },
    { op: 'connect', pins: ['J1.4', 'R1.1'], net: 'CC1' },
    { op: 'connect', pins: ['R1.2'], net: 'GND' },
    ...extra,
  ]);
  ok(k, ops);
  const out = k.committedDesign();
  out.parts[usbc.id]!.pins = usbc.pins;
  return out;
}
const opened = (d: Design) => {
  const k = new Kernel();
  k.load(d);
  return k;
};
const place = [
  { op: 'place_symbol', ref: 'J1', page: 1, x: 6000, y: 3000 },
  { op: 'place_symbol', ref: 'R1', page: 1, x: 3000, y: 3000, orient: 'lying' },
];
const drawn = (k: Kernel) => Object.values(k.committedDesign().drawing!)[0]!;

describe('a drawing stored before a connector showed its pins\' names', () => {
  it('keeps every pin on the side where it was and the wire on it; the names are there', () => {
    const d = storedBefore([...place, { op: 'wire', from: 'J1.CC1', to: 'R1.1' }].map((o) => (o.op === 'wire' ? { ...o, from: 'J1.4' } : o)));
    const was = opened({ ...structuredClone(d), parts: { ...d.parts, [usbc.id]: { ...usbc, pins: usbc.pins.map((p) => ({ ...p, name: p.number })) } } });
    const before = pinOf(was, 'J1', '4');
    const wires = drawn(was).wires.filter((w) => w.pts.includes(before.x) && w.pts.includes(before.y));
    expect(wires.length).toBeGreaterThan(0);

    const k = opened(d);
    const after = pinOf(k, 'J1', '4');
    expect([after.x, after.y]).toEqual([before.x, before.y]);
    expect(after.showName).toBe(true);
    expect(after.name).toBe('CC1_A5');
    for (const w of wires) expect(drawn(k).wires).toContainEqual(w);
  });

  it('what hangs only on pins that moved goes along: a bar joining the grounds stays one bar', () => {
    const d = storedBefore([...place, { op: 'wire', from: 'J1.1', to: 'J1.2' }]);
    const was = opened({ ...structuredClone(d), parts: { ...d.parts, [usbc.id]: { ...usbc, pins: usbc.pins.map((p) => ({ ...p, name: p.number })) } } });
    const [p1, p2] = [pinOf(was, 'J1', '1'), pinOf(was, 'J1', '2')];
    const bar = drawn(was).wires.filter((w) => w.pts.includes(p1.x) || w.pts.includes(p2.x));
    expect(bar.length).toBeGreaterThan(0);

    const k = opened(d);
    const [q1, q2] = [pinOf(k, 'J1', '1'), pinOf(k, 'J1', '2')];
    const [dx, dy] = [q1.x - p1.x, q1.y - p1.y];
    expect(dx).toBeGreaterThan(0); // aside, into the room beside the names on the left
    expect(dy).toBe(0);
    expect([q2.x - p2.x, q2.y - p2.y]).toEqual([dx, dy]);
    for (const w of bar) expect(drawn(k).wires).toContainEqual({ ...w, pts: w.pts.map((v, i) => v + (i % 2 ? dy : dx)) });
    // both pins are still on the same piece of wire, so no label stands in for it
    const onPin = (x: number, y: number) => drawn(k).wires.some((w) => w.pts.some((_, i) => i % 2 === 0 && w.pts[i] === x && w.pts[i + 1] === y));
    expect(onPin(q1.x, q1.y) && onPin(q2.x, q2.y)).toBe(true);
    expect(k.state().diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
  });

  it('a wire that also reaches another part is not dragged off it: it is cut back and the net stays whole', () => {
    const d = storedBefore([...place, { op: 'wire', from: 'J1.1', to: 'J1.2' }, { op: 'wire', from: 'J1.1', to: 'R1.2' }]);
    const k = opened(d);
    const tip = pinOf(k, 'J1', '1');
    // no wire on the pin's new spot: the connection shows as a label
    expect(drawn(k).wires.filter((w) => w.pts.some((_, i) => i % 2 === 0 && w.pts[i] === tip.x && w.pts[i + 1] === tip.y))).toEqual([]);
    expect(Object.values(k.committedDesign().components).find((c) => c.refdes === 'J1')!.pins['1']).toBeTruthy();
    expect(k.state().diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
  });

  it('one drawn with its names is not taken for that when its card changes later: its wires are not sent elsewhere', () => {
    // bottom pins beside the names, on spots where the shape without names has other pins
    const wide: PartCard = {
      ...usbc,
      id: 'acme:USBC-WIDE',
      pins: [...usbc.pins.filter((p) => p.number !== '6'), { number: '6', name: 'GND_C1', type: 'passive' }, { number: '7', name: 'GND_D1', type: 'passive' }, { number: '8', name: 'GND_E1', type: 'passive' }],
      symbolLayout: { left: [['3'], ['4'], ['5']], right: [], top: [], bottom: [['1'], ['2'], ['6'], ['7'], ['8']] },
    };
    registerUserParts([wide]);
    try {
      const k = new Kernel();
      ok(k, [
        { op: 'add_part', part: wide.id, refdes: 'J1' },
        { op: 'connect', pins: ['J1.1', 'J1.2', 'J1.5', 'J1.6', 'J1.7', 'J1.8'], net: 'GND' },
        { op: 'connect', pins: ['J1.3'], net: 'VBUS' },
        { op: 'no_connect', pins: ['J1.4'] },
      ]);
      ok(k, [{ op: 'place_symbol', ref: 'J1', page: 1, x: 6000, y: 3000 }, { op: 'wire', from: 'J1.1', to: 'J1.2' }]);
      const d = k.committedDesign();
      const wires = Object.values(d.drawing!)[0]!.wires.map((w) => JSON.stringify(w));
      expect(wires.length).toBeGreaterThan(0);
      d.parts[wide.id]!.pins.find((p) => p.number === '3')!.name = 'VBUS_WITH_A_MUCH_LONGER_NAME';
      for (const w of drawn(opened(d)).wires) expect(wires).toContain(JSON.stringify(w));
    } finally {
      unregisterUserPart(wide.id);
    }
  });

  it('mirrored afterwards, what hangs on its bottom pins goes along; the rest is laid out from its new side', () => {
    const k = opened(storedBefore([...place, { op: 'wire', from: 'J1.1', to: 'J1.2' }, { op: 'wire', from: 'J1.3', to: 'J1.6' }]));
    const [p1, p2] = [pinOf(k, 'J1', '1'), pinOf(k, 'J1', '2')];
    const bar = drawn(k).wires.filter((w) => w.pts.includes(p1.x) || w.pts.includes(p2.x)).length;
    expect(bar).toBeGreaterThan(0);
    const sym = drawn(k).symbols.find((s) => s.part === usbc.id)!;
    const page = drawn(k).pages[0]!;
    ok(k, [{ op: 'place_symbol', ref: 'J1', page: 1, x: sym.bbox.x + sym.bbox.w / 2 - page.x, y: sym.bbox.y + sym.bbox.h / 2 - page.y, mirror: true }]);
    const [q1, q2] = [pinOf(k, 'J1', '1'), pinOf(k, 'J1', '2')];
    expect(q1.x).not.toBe(p1.x); // it stands clear of the names, now on the right
    expect(q1.y).toBe(p1.y);
    const onPin = (x: number, y: number) => drawn(k).wires.some((w) => w.pts.some((_, i) => i % 2 === 0 && w.pts[i] === x && w.pts[i + 1] === y));
    expect(onPin(q1.x, q1.y) && onPin(q2.x, q2.y)).toBe(true);
    // pins that changed sides do not drag what hung on them into the body
    const vbus = pinOf(k, 'J1', '3');
    expect(vbus.side).toBe('right');
    const net = Object.values(k.committedDesign().nets).find((n) => n.name === 'VBUS')!;
    for (const w of drawn(k).wires.filter((x) => x.netId === net.id)) for (const x of w.pts.filter((_, i) => i % 2 === 0)) expect(x).toBeGreaterThanOrEqual(vbus.x);
    for (const l of drawn(k).labels.filter((x) => x.netId === net.id)) expect(l.x).toBeGreaterThanOrEqual(vbus.x);
  });

  it('opened again it changes nothing: the drawing is up to date', () => {
    const d = storedBefore([...place, { op: 'wire', from: 'J1.1', to: 'J1.2' }]);
    const once = opened(d).committedDesign();
    const twice = opened(once).committedDesign();
    expect(JSON.stringify(twice.drawing)).toBe(JSON.stringify(once.drawing));
  });

  it('a mirrored one keeps the corner its pins are on, and a name the user moved stays', () => {
    const d = storedBefore([{ op: 'place_symbol', ref: 'J1', page: 1, x: 6000, y: 3000, mirror: true }, { op: 'place_symbol', ref: 'R1', page: 1, x: 9000, y: 3000, orient: 'lying' }]);
    const sym = Object.values(d.drawing!)[0]!.symbols.find((s) => s.part === usbc.id)!;
    sym.textBy = 'user';
    sym.ref = { ...sym.ref, x: sym.ref.x + 333 };
    const was = opened({ ...structuredClone(d), parts: { ...d.parts, [usbc.id]: { ...usbc, pins: usbc.pins.map((p) => ({ ...p, name: p.number })) } } });
    const before = pinOf(was, 'J1', '4');

    const k = opened(d);
    const after = pinOf(k, 'J1', '4');
    expect(after.side).toBe('right');
    expect([after.x, after.y]).toEqual([before.x, before.y]);
    const now = drawn(k).symbols.find((s) => s.part === usbc.id)!;
    expect(now.textBy).toBe('user');
    expect(now.ref.x).toBe(sym.ref.x);
  });
});
