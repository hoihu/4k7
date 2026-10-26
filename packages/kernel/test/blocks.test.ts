import { describe, expect, it } from 'vitest';
import { PAGE, type EditOp, type PartCard, type Rect, type SheetView } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { labelRect } from '../src/scene.ts';
import { buckTransaction } from './fixtures.ts';

/** An addressable LED (WS2812-like): supply on top and bottom, data in on the left, out on the right. */
const led: PartCard = {
  id: 'acme:LED',
  mpn: 'acme:LED',
  description: 'addressable LED',
  category: 'ic',
  refPrefix: 'D',
  pins: [
    { number: '1', name: 'VDD', type: 'pwr_in', side: 'top' },
    { number: '2', name: 'DOUT', type: 'out', side: 'right' },
    { number: '3', name: 'VSS', type: 'pwr_in', side: 'bottom' },
    { number: '4', name: 'DIN', type: 'in', side: 'left' },
  ],
  params: {},
  provenance: { source: 'datasheet' },
};

/** A chain of `n` LEDs D1…Dn, fed from `from` on DIN, the data passed on from DOUT to DIN. */
function chainOps(n: number, from: string): EditOp[] {
  const ds = Array.from({ length: n }, (_, i) => `D${i + 1}`);
  return [
    ...ds.map((ref): EditOp => ({ op: 'add_part', part: 'acme:LED', refdes: ref })),
    { op: 'connect', pins: ds.map((d) => `${d}.VDD`), net: '+5V' },
    { op: 'connect', pins: ds.map((d) => `${d}.VSS`), net: 'GND' },
    { op: 'connect', pins: [from, 'D1.DIN'], net: 'LED_DIN' },
    ...ds.slice(1).map((d, i): EditOp => ({ op: 'connect', pins: [`D${i + 1}.DOUT`, `${d}.DIN`], net: `LED${i + 1}_${i + 2}` })),
    { op: 'no_connect', pins: [`D${n}.DOUT`] },
  ];
}

/** 5 V in (J1, C1), an ATtiny85 with its decoupling and reset pull-up, a supply monitor divider, and four LEDs it drives. */
const circuit: EditOp[] = [
  { op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J1' },
  { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '10uF' } },
  { op: 'add_part', part: 'microchip:ATTINY85-20SU', refdes: 'U1' },
  { op: 'add_part', part: 'generic:C', refdes: 'C2', params: { capacitance: '100nF' } },
  { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '10k' } },
  { op: 'add_part', part: 'generic:R', refdes: 'R6', params: { resistance: '20k' } },
  { op: 'add_part', part: 'generic:R', refdes: 'R7', params: { resistance: '10k' } },
  { op: 'add_part', part: 'generic:C', refdes: 'C6', params: { capacitance: '100nF' } },
  { op: 'connect', pins: ['J1.1', 'C1.1', 'U1.VCC', 'C2.1', 'R1.1', 'R6.1'], net: '+5V' },
  { op: 'set_net', net: '+5V', external: true, voltage: 5 },
  { op: 'connect', pins: ['J1.2', 'C1.2', 'U1.GND', 'C2.2', 'R7.2', 'C6.2'], net: 'GND' },
  { op: 'connect', pins: ['R1.2', 'U1.1'], net: 'RESET' },
  { op: 'connect', pins: ['R6.2', 'R7.1', 'C6.1', 'U1.PB3'], net: 'VMON' },
  ...chainOps(4, 'U1.PB0'),
];

const BLOCKS = [
  { title: 'Power input', refs: ['J1', 'C1'] },
  // C2 in none: the layout puts it with the IC it decouples
  { title: 'Microcontroller', refs: ['U1', 'R1'] },
  { title: 'Supply monitor', refs: ['R6', 'R7', 'C6'] },
  { title: 'LED chain', refs: ['D1', 'D2', 'D3', 'D4'] },
];

function kernelWith(ops: EditOp[], blocks: { title: string; refs: string[]; text?: string }[] | null = BLOCKS): Kernel {
  const k = new Kernel();
  const d = k.committedDesign();
  d.parts[led.id] = led;
  k.load(d);
  const r = k.transact({ summary: 'circuit', ops: [...ops, ...(blocks ? [{ op: 'describe', blocks } as EditOp] : [])] });
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  return k;
}

const sheetOf = (k: Kernel): SheetView => k.state().view.sheets[0]!;
const sym = (s: SheetView, ref: string) => s.symbols.find((x) => x.refdes === ref)!;
const frameOf = (s: SheetView, title: string) => s.blocks!.find((b) => b.title === title)!.rect;
const inside = (r: Rect, a: Rect) => r.x >= a.x && r.y >= a.y && r.x + r.w <= a.x + a.w && r.y + r.h <= a.y + a.h;
const within = (a: Rect, x: number, y: number) => x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h;
const hits = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const netLabels = (s: SheetView, name: string) => s.labels.filter((l) => l.kind === 'net' && l.text === name);
const netId = (k: Kernel, name: string) => Object.values(k.draftDesign().nets).find((n) => n.name === name)!.id;
const wiresOf = (k: Kernel, s: SheetView, name: string) => s.wires.filter((w) => w.netId === netId(k, name));
const drawArea = (p: Rect): Rect => ({ x: p.x + PAGE.margin, y: p.y + PAGE.margin, w: p.w - 2 * PAGE.margin, h: p.h - 2 * PAGE.margin - PAGE.title });
/** The frame's centre in page mils (as place_block takes it), and its page. */
function framePlace(s: SheetView, title: string) {
  const c = centre(frameOf(s, title));
  const pg = s.pages.find((p) => within(p.rect, c.x, c.y))!;
  return { page: pg.number, x: c.x - pg.rect.x, y: c.y - pg.rect.y };
}

describe('functional blocks on the schematic', () => {
  it('draws each block in a frame of its own, round all its parts, in the description order', () => {
    const s = sheetOf(kernelWith(circuit));
    expect(s.blocks!.map((b) => b.title)).toEqual(['Power input', 'Microcontroller', 'Supply monitor', 'LED chain']);
    const members: Record<string, string[]> = { 'Power input': ['J1', 'C1'], Microcontroller: ['U1', 'R1', 'C2'], 'Supply monitor': ['R6', 'R7', 'C6'], 'LED chain': ['D1', 'D2', 'D3', 'D4'] };
    for (const [title, refs] of Object.entries(members)) for (const ref of refs) expect(inside(sym(s, ref).bbox, frameOf(s, title)), `${ref} in "${title}"`).toBe(true);
    for (const a of s.blocks!) {
      expect(inside(a.rect, drawArea(s.pages[0]!.rect)), `"${a.title}" on the page`).toBe(true);
      for (const b of s.blocks!) if (a !== b) expect(hits(a.rect, b.rect), `"${a.title}" clear of "${b.title}"`).toBe(false);
    }
  });

  it('wires the connections inside a block and labels only the nets that leave it', () => {
    const k = kernelWith(circuit);
    const s = sheetOf(k);
    for (const net of ['LED1_2', 'LED2_3', 'LED3_4']) {
      expect(netLabels(s, net), net).toEqual([]);
      expect(wiresOf(k, s, net).length, net).toBeGreaterThan(0);
    }
    // the reset pull-up stands at its pin, wired
    expect(netLabels(s, 'RESET')).toEqual([]);
    // the data line leaves the microcontroller for the chain: one label in each block, no wire between them
    const din = netLabels(s, 'LED_DIN');
    expect(din).toHaveLength(2);
    expect(din.filter((l) => within(frameOf(s, 'Microcontroller'), l.x, l.y))).toHaveLength(1);
    expect(din.filter((l) => within(frameOf(s, 'LED chain'), l.x, l.y))).toHaveLength(1);
    for (const w of wiresOf(k, s, 'LED_DIN')) {
      const xs = w.pts.filter((_, i) => i % 2 === 0);
      const ys = w.pts.filter((_, i) => i % 2 === 1);
      const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      expect(s.blocks!.some((b) => inside(box, b.rect))).toBe(true);
    }
  });

  it('joins the supply symbols of a row of parts into one bar', () => {
    const k = kernelWith(circuit);
    const s = sheetOf(k);
    const f = frameOf(s, 'LED chain');
    const inChain = (kind: string, text: string) => s.labels.filter((l) => l.kind === kind && l.text === text && within(f, l.x, l.y));
    expect(inChain('rail', '+5V')).toHaveLength(1);
    expect(inChain('ground', 'GND')).toHaveLength(1);
    // every LED's supply pins on the bars' wires
    const on = (x: number, y: number, net: string) => wiresOf(k, s, net).some((w) => w.pts.some((v, i) => i % 2 === 0 && v === x && w.pts[i + 1] === y));
    for (const ref of ['D1', 'D2', 'D3', 'D4']) {
      const vdd = sym(s, ref).pins.find((p) => p.name === 'VDD')!;
      const vss = sym(s, ref).pins.find((p) => p.name === 'VSS')!;
      expect(on(vdd.x, vdd.y, '+5V'), `${ref}.VDD`).toBe(true);
      expect(on(vss.x, vss.y, 'GND'), `${ref}.VSS`).toBe(true);
    }
  });

  it('labels a connection the wire would have to take round a part, rather than doubling back', () => {
    // a bootstrap cap from BOOT (left) to SW (right): a wire would run round the IC and back
    const buck: PartCard = {
      id: 'acme:BUCK',
      mpn: 'acme:BUCK',
      description: 'buck converter',
      category: 'ic',
      refPrefix: 'U',
      pins: [
        { number: '1', name: 'BOOT', type: 'passive', side: 'left' },
        { number: '2', name: 'EN', type: 'in', side: 'left' },
        { number: '3', name: 'SW', type: 'out', side: 'right' },
        { number: '4', name: 'FB', type: 'in', side: 'right' },
        { number: '5', name: 'VIN', type: 'pwr_in', side: 'top' },
        { number: '6', name: 'GND', type: 'pwr_in', side: 'bottom' },
      ],
      params: {},
      provenance: { source: 'datasheet' },
    };
    const k = new Kernel();
    const d = k.committedDesign();
    d.parts[buck.id] = buck;
    k.load(d);
    const r = k.transact({
      summary: 'buck',
      ops: [
        { op: 'add_part', part: 'acme:BUCK', refdes: 'U1' },
        { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '100nF' } },
        { op: 'add_part', part: 'generic:L', refdes: 'L1', params: { inductance: '10uH' } },
        { op: 'connect', pins: ['U1.BOOT', 'C1.1'], net: 'BOOT' },
        { op: 'connect', pins: ['C1.2', 'U1.SW', 'L1.1'], net: 'SW' },
        { op: 'connect', pins: ['L1.2', 'U1.FB'], net: '+5V' },
        { op: 'set_net', net: '+5V', voltage: 5 },
        { op: 'connect', pins: ['U1.VIN'], net: 'VIN' },
        { op: 'set_net', net: 'VIN', voltage: 12, external: true },
        { op: 'connect', pins: ['U1.GND'], net: 'GND' },
        { op: 'no_connect', pins: ['U1.EN'] },
        { op: 'describe', blocks: [{ title: 'Buck', refs: ['U1', 'C1', 'L1'] }] },
      ],
    });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    expect(k.state().diagnostics.filter((x) => x.code === 'SCH.DETOUR')).toEqual([]);
    const s = sheetOf(k);
    const c1 = sym(s, 'C1');
    const u1 = sym(s, 'U1').bbox;
    // C1 at BOOT, on the IC's left; SW reaches it by its name
    expect(c1.bbox.x + c1.bbox.w).toBeLessThanOrEqual(u1.x);
    expect(netLabels(s, 'SW').length).toBeGreaterThanOrEqual(2);
  });

  it('draws a divider with its filter cap as one column, the cap tapped off the joint', () => {
    const k = kernelWith(circuit);
    const s = sheetOf(k);
    const [r6, r7, c6] = ['R6', 'R7', 'C6'].map((r) => centre(sym(s, r).bbox));
    expect(r6!.x).toBe(r7!.x);
    expect(r6!.y).toBeLessThan(r7!.y); // the rail end on top
    expect(c6!.x).toBeLessThan(r6!.x);
    expect(netLabels(s, 'VMON').filter((l) => within(frameOf(s, 'Supply monitor'), l.x, l.y))).toHaveLength(1);
    const top = sym(s, 'C6').pins.find((p) => p.side === 'top')!;
    expect(wiresOf(k, s, 'VMON').some((w) => w.pts.includes(top.x) && w.pts.at(-1) === top.y), 'C6 wired to the joint').toBe(true);
  });

  it('puts a part in no block with the block it is drawn with, and get_schematic says which are guessed', () => {
    const k = kernelWith([...circuit, { op: 'add_part', part: 'generic:R', refdes: 'R9', params: { resistance: '1k' } }, { op: 'connect', pins: ['R9.2'], net: 'GND' }, { op: 'no_connect', pins: ['R9.1'] }]);
    type Q = { blocks: { block: string; page: number; x: number; y: number; parts: string[]; guessed?: string[] }[]; not_in_a_block?: string[] };
    const q = k.query({ op: 'get_schematic' }) as Q;
    const mcu = q.blocks.find((b) => b.block === 'Microcontroller')!;
    expect(mcu.parts).toEqual(['C2', 'R1', 'U1']);
    expect(mcu.guessed).toEqual(['C2']);
    expect(q.blocks.find((b) => b.block === 'LED chain')!.guessed).toBeUndefined();
    // R9 connects to nothing but ground: in no block, drawn outside the frames
    expect(q.not_in_a_block).toEqual(['R9']);
    const s = sheetOf(k);
    expect(s.blocks!.some((b) => hits(b.rect, sym(s, 'R9').bbox))).toBe(false);
    // the frame where get_schematic says it is
    const at = framePlace(s, 'Microcontroller');
    expect(mcu).toMatchObject({ page: at.page, x: Math.round(at.x), y: Math.round(at.y) });
  });

  it('keeps a block\'s text when the blocks are given again without texts', () => {
    const k = kernelWith(circuit, BLOCKS.map((b) => ({ ...b, text: `${b.title}: how it works.` })));
    expect(k.transact({ summary: 'regroup', ops: [{ op: 'describe', blocks: [...BLOCKS.slice(0, 2), { title: 'Supply monitor and LEDs', refs: ['R6', 'R7', 'C6', 'D1', 'D2', 'D3', 'D4'] }] }] }).status).toBe('ok');
    const blocks = k.draftDesign().description!.blocks;
    expect(blocks.map((b) => b.text)).toEqual(['Power input: how it works.', 'Microcontroller: how it works.', '']);
  });

  it('draws a sheet without blocks the classic way, unchanged, and get_schematic says how to group', () => {
    const k = kernelWith(circuit, null);
    expect(sheetOf(k).blocks).toBeUndefined();
    expect((k.query({ op: 'get_schematic' }) as { blocks_note: string }).blocks_note).toMatch(/No functional blocks yet/);
    // a sheet with no part in a block stays as it was when another sheet is grouped
    const buck = buckTransaction().ops.map((op) => (op.op === 'add_part' ? { ...op, refdes: op.refdes!.replace(/\d+$/, (n) => String(Number(n) + 50)) } : op));
    const rename = (p: string) => p.replace(/^([A-Z]+)(\d+)\./, (_, a, n) => `${a}${Number(n) + 50}.`);
    const ops = buck.map((op) => (op.op === 'connect' || op.op === 'no_connect' ? { ...op, pins: op.pins.map(rename) } : op));
    const refs = buck.flatMap((op) => (op.op === 'add_part' ? [op.refdes!] : []));
    expect(k.transact({ summary: 'buck', ops: [{ op: 'add_sheet', name: 'Buck' }, ...ops, { op: 'move_to_sheet', refs, sheet: 'Buck' }] } as never).status).toBe('ok');
    const drawn = (v: SheetView) => JSON.stringify({ symbols: v.symbols.map((x) => [x.refdes, x.bbox]), wires: v.wires, labels: v.labels });
    const before = drawn(k.state().view.sheets[1]!);
    expect(k.transact({ summary: 'group', ops: [{ op: 'describe', blocks: BLOCKS }] }).status).toBe('ok');
    const view = k.state().view;
    expect(view.sheets[0]!.blocks?.length).toBe(4);
    expect(view.sheets[1]!.blocks).toBeUndefined();
    expect(drawn(view.sheets[1]!)).toBe(before);
  });
});

describe('place_block', () => {
  it('puts a block\'s frame where the agent says on a sheet the layout draws; the others flow round it', () => {
    const k = kernelWith(circuit);
    const r = k.transact({ summary: 'place', ops: [{ op: 'place_block', block: 'led chain', page: 1, x: 8000, y: 5000 }] });
    expect(r.status).toBe('ok');
    // (the frame's centre is on the grid, or half a step off it for a frame an odd number of steps wide)
    const said = r.results[0]!.effect.match(/^block "LED chain" \(\d+ × \d+ mils\) on page 1 at \((\d+), (\d+)\) mils$/);
    expect(said).not.toBeNull();
    const entries = Object.values(k.draftDesign().ledger).filter((c) => c.kind === 'sch_block');
    expect(entries).toMatchObject([{ key: 'LED chain', page: 1, x: 8000, y: 5000 }]);
    const s = sheetOf(k);
    const at = framePlace(s, 'LED chain');
    expect([Number(said![1]), Number(said![2])]).toEqual([at.x, at.y]);
    expect(Math.abs(at.x - 8000)).toBeLessThanOrEqual(50);
    expect(Math.abs(at.y - 5000)).toBeLessThanOrEqual(50);
    for (const b of s.blocks!) if (b.title !== 'LED chain') expect(hits(b.rect, frameOf(s, 'LED chain')), b.title).toBe(false);
    expect((k.query({ op: 'get_schematic' }) as { blocks: { block: string; placed?: boolean }[] }).blocks.find((b) => b.block === 'LED chain')!.placed).toBe(true);
  });

  it('moves a block aside that would lie on one placed before it, within the page, and lets it flow again with auto', () => {
    const k = kernelWith(circuit);
    k.transact({ summary: 'place', ops: [{ op: 'place_block', block: 'LED chain', page: 1, x: 4500, y: 2000 }] });
    const r = k.transact({ summary: 'place', ops: [{ op: 'place_block', block: 'Microcontroller', page: 1, x: 4500, y: 2000 }] });
    expect(r.results[0]!.effect).toMatch(/^block "Microcontroller" \(.*\) on page 1 at .*; it moved aside from \(4500, 2000\) to clear a block placed before it$/);
    const s = sheetOf(k);
    const [a, b] = [frameOf(s, 'LED chain'), frameOf(s, 'Microcontroller')];
    // clear of it with room between, within the page
    expect(Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h))).toBeGreaterThanOrEqual(300);
    expect(inside(b, drawArea(s.pages[0]!.rect))).toBe(true);
    // the one placed first stays where it was put (to half a grid step: its frame is an odd number of steps wide)
    const first = framePlace(s, 'LED chain');
    expect(first.page).toBe(1);
    expect(Math.abs(first.x - 4500)).toBeLessThanOrEqual(50);
    expect(Math.abs(first.y - 2000)).toBeLessThanOrEqual(50);
    const back = k.transact({ summary: 'flow', ops: [{ op: 'place_block', block: 'Microcontroller', auto: true }] });
    expect(back.results[0]!.effect).toBe('block "Microcontroller" flows with the others again');
    expect(Object.values(k.draftDesign().ledger).filter((c) => c.kind === 'sch_block').map((c) => c.key)).toEqual(['LED chain']);
  });

  it('lets a placed block flow with the others when its page has no clear spot for it', () => {
    const k = kernelWith(circuit);
    k.transact({ summary: 'place', ops: [{ op: 'place_block', block: 'LED chain', page: 1, x: 6000, y: 4000 }] });
    const r = k.transact({ summary: 'place', ops: [{ op: 'place_block', block: 'Microcontroller', page: 1, x: 6000, y: 4000 }] });
    expect(r.results[0]!.effect).toMatch(/^block "Microcontroller" \(.*\) on page 2 at .*; page 1 has no room for it at \(6000, 4000\) clear of the blocks placed before it, so it flows with the others$/);
    const s = sheetOf(k);
    expect(framePlace(s, 'Microcontroller').page).toBe(2);
    for (const b of s.blocks!) expect(s.pages.some((p) => inside(b.rect, drawArea(p.rect))), b.title).toBe(true);
  });

  it('refuses a block the design does not have, naming the ones it has', () => {
    const k = kernelWith(circuit);
    const r = k.transact({ summary: 'place', ops: [{ op: 'place_block', block: 'LED chains', page: 1, x: 6000, y: 4000 }] });
    expect(r.rejection?.code).toBe('REF_UNKNOWN');
    expect(r.rejection?.candidates).toContain('LED chain');
    const bare = kernelWith(circuit, null).transact({ summary: 'place', ops: [{ op: 'place_block', block: 'LED chain', x: 6000, y: 4000 }] });
    expect(bare.rejection?.message).toMatch(/no functional blocks yet/);
  });

  it('forgets a placed block that is no longer in the description', () => {
    const k = kernelWith(circuit);
    k.transact({ summary: 'place', ops: [{ op: 'place_block', block: 'LED chain', page: 1, x: 6000, y: 4000 }] });
    k.transact({ summary: 'regroup', ops: [{ op: 'describe', blocks: [...BLOCKS.slice(0, 3), { title: 'LEDs', refs: ['D1', 'D2', 'D3', 'D4'] }] }] });
    expect(Object.values(k.draftDesign().ledger).filter((c) => c.kind === 'sch_block')).toEqual([]);
  });

  it('draws a block afresh, together and wired, where the agent puts it on a sheet it arranged', () => {
    const k = kernelWith(circuit);
    // the agent takes the sheet over: the LEDs strewn about by hand
    const strewn = ['D1', 'D2', 'D3', 'D4'].map((ref, i): EditOp => ({ op: 'place_symbol', ref, page: 1, x: 2000 + i * 2500, y: 2000 + (i % 2) * 3000 }));
    expect(k.transact({ summary: 'strew', ops: strewn }).status).toBe('ok');
    expect(k.draftDesign().drawing).toBeDefined();
    expect(netLabels(sheetOf(k), 'LED1_2').length).toBeGreaterThan(0);
    // where its frame would run into the microcontroller's, the agent is told
    const near = k.transact({ summary: 'place', ops: [{ op: 'place_block', block: 'LED chain', page: 1, x: 6000, y: 5500 }] });
    expect(near.results[0]!.effect).toMatch(/; its frame runs into the frame of "Microcontroller": move it clear$/);
    const r = k.transact({ summary: 'place', ops: [{ op: 'place_block', block: 'LED chain', page: 1, x: 6000, y: 5900 }] });
    expect(r.status).toBe('ok');
    expect(r.results[0]!.effect).toMatch(/^block "LED chain" drawn afresh on page 1 at \(\d+, \d+\) mils, its parts together and wired$/);
    expect(Object.values(k.draftDesign().ledger).filter((c) => c.kind === 'sch_block')).toEqual([]);
    const s = sheetOf(k);
    for (const net of ['LED1_2', 'LED2_3', 'LED3_4']) {
      expect(netLabels(s, net), net).toEqual([]);
      expect(wiresOf(k, s, net).length, net).toBeGreaterThan(0);
    }
    const at = framePlace(s, 'LED chain');
    expect(Math.abs(at.x - 6000)).toBeLessThanOrEqual(300);
    expect(Math.abs(at.y - 5900)).toBeLessThanOrEqual(300);
    // the frames on the arranged sheet take in what is drawn at their parts: none cuts through a label
    expect(s.blocks!.map((b) => b.title).sort()).toEqual(['LED chain', 'Microcontroller', 'Power input', 'Supply monitor']);
    for (const b of s.blocks!) for (const l of s.labels) expect(!hits(b.rect, labelRect(l)) || inside(labelRect(l), b.rect), `"${b.title}" and ${l.text} at (${l.x}, ${l.y})`).toBe(true);
    // put where it runs off the page, the block is drawn there, and the agent is told
    const off = k.transact({ summary: 'place', ops: [{ op: 'place_block', block: 'LED chain', page: 1, x: 10000, y: 5500 }] });
    expect(off.results[0]!.effect).toMatch(/; it runs past the drawing area of the page: move it in, or put it on a page of its own$/);
  });

  it('draws a part added to an arranged sheet next to the parts of its block', () => {
    const k = kernelWith(circuit);
    // the sheet becomes the agent's: the microcontroller moved to the far corner of the page
    expect(k.transact({ summary: 'move', ops: [{ op: 'place_symbol', ref: 'U1', page: 1, x: 9500, y: 5500 }] }).status).toBe('ok');
    // a pull-up on PB1: in no block, it goes with the IC whose pin it pulls
    const r = k.transact({
      summary: 'pull-up',
      ops: [
        { op: 'add_part', part: 'generic:R', refdes: 'R5', params: { resistance: '10k' } },
        { op: 'connect', pins: ['R5.1', 'U1.VCC'] },
        { op: 'connect', pins: ['R5.2', 'U1.PB1'], net: 'BTN' },
      ],
    });
    expect(r.status).toBe('ok');
    const s = sheetOf(k);
    const u1 = sym(s, 'U1').bbox;
    const r5 = sym(s, 'R5').bbox;
    const gap = Math.max(0, u1.x - (r5.x + r5.w), r5.x - (u1.x + u1.w)) + Math.max(0, u1.y - (r5.y + r5.h), r5.y - (u1.y + u1.h));
    expect(gap).toBeLessThan(1500);
  });
});

describe('a block taller than a page', () => {
  it('continues on the next page, cut between its rows, each cut net labelled on both sides', () => {
    const k = kernelWith([...circuit.filter((op) => !(op.op === 'add_part' && /^D/.test(op.refdes!))).filter((op) => op.op !== 'connect' || !op.pins.some((p) => p.startsWith('D'))).filter((op) => op.op !== 'no_connect'), ...chainOps(48, 'U1.PB0')], [
      ...BLOCKS.slice(0, 3),
      { title: 'LED chain', refs: Array.from({ length: 48 }, (_, i) => `D${i + 1}`) },
    ]);
    const s = sheetOf(k);
    const pieces = s.blocks!.filter((b) => b.title.startsWith('LED chain'));
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.map((b) => b.title)).toEqual(['LED chain', ...pieces.slice(1).map(() => 'LED chain (continued)')]);
    const pageOf = (r: Rect) => s.pages.findIndex((p) => inside(r, drawArea(p.rect)));
    for (const b of s.blocks!) expect(pageOf(b.rect), `"${b.title}" within one page`).toBeGreaterThanOrEqual(0);
    expect(new Set(pieces.map((b) => pageOf(b.rect))).size).toBe(pieces.length);
    const pieceOf = (ref: string) => pieces.findIndex((b) => inside(sym(s, ref).bbox, b.rect));
    let cut = 0;
    for (let i = 1; i < 48; i++) {
      const net = `LED${i}_${i + 1}`;
      const a = pieceOf(`D${i}`);
      const b = pieceOf(`D${i + 1}`);
      expect(a, `D${i} in a piece`).toBeGreaterThanOrEqual(0);
      if (a === b) expect(netLabels(s, net), net).toEqual([]);
      else {
        cut++;
        const ls = netLabels(s, net);
        expect(ls.map((l) => pieces.findIndex((p) => within(p.rect, l.x, l.y))).sort(), net).toEqual([a, b].sort());
      }
    }
    expect(cut).toBe(pieces.length - 1);
  });
});

describe('arrangement of an IC or connector in a block', () => {
  it('mirrors it as asked, and only ICs and connectors', () => {
    const k = kernelWith(circuit);
    expect(sym(sheetOf(k), 'U1').pins.find((p) => p.name === 'PB0')!.side).toBe('right');
    expect(k.transact({ summary: 'mirror', ops: [{ op: 'constrain', kind: 'arrangement', a: 'U1', value: 'mirrored' }] }).status).toBe('ok');
    expect(sym(sheetOf(k), 'U1').pins.find((p) => p.name === 'PB0')!.side).toBe('left');
    expect(k.transact({ summary: 'unmirror', ops: [{ op: 'constrain', kind: 'arrangement', a: 'U1', value: 'unmirrored' }] }).status).toBe('ok');
    expect(Object.values(k.draftDesign().ledger).filter((c) => c.kind === 'arrangement').map((c) => c.value)).toEqual(['unmirrored']);
    expect(sym(sheetOf(k), 'U1').pins.find((p) => p.name === 'PB0')!.side).toBe('right');
    const r = k.transact({ summary: 'mirror', ops: [{ op: 'constrain', kind: 'arrangement', a: 'R1', value: 'mirrored' }] });
    expect(r.rejection?.code).toBe('CONSTRAINT_INVALID');
    expect(r.rejection?.message).toMatch(/"up" or "down"/);
  });

  it('keeps a regulator\'s drawing style beside its mirroring', () => {
    const k = kernelWith([...circuit, { op: 'add_part', part: 'ams:AMS1117-3.3', refdes: 'U2' }, { op: 'connect', pins: ['U2.VIN'], net: '+5V' }, { op: 'connect', pins: ['U2.GND'], net: 'GND' }, { op: 'connect', pins: ['U2.VOUT'], net: '+3V3' }]);
    k.transact({ summary: 'style', ops: [{ op: 'constrain', kind: 'arrangement', a: 'U2', value: 'compact' }, { op: 'constrain', kind: 'arrangement', a: 'U2', value: 'mirrored' }] });
    expect(Object.values(k.draftDesign().ledger).filter((c) => c.kind === 'arrangement').map((c) => c.value).sort()).toEqual(['compact', 'mirrored']);
  });
});
