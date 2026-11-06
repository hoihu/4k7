import { describe, expect, it } from 'vitest';
import { Kernel } from '@4k7/kernel';
import type { BoardView, EditOp, ZoneCut } from '@4k7/schema';
import { boardNetDesign, checkCopper, checkFabSet, copperCheckText, gerbers, panelBoard, readExcellon, readFabFiles, readGerber, type NetDesign, type NetPad } from '../src/index.ts';
import { capsuleCuts } from '../../kernel/src/routepours.ts';
import { buckTransaction } from '../../kernel/test/fixtures.ts';

/* the check on files written by hand: it holds for any writer */

const gerber = (...body: string[]) => ['%FSLAX46Y46*%', '%MOMM*%', '%ADD10C,1.000000*%', '%ADD11C,0.300000*%', '%ADD12R,2.000000X2.000000*%', ...body, 'M02*'].join('\n');
const xy = (x: number, y: number) => `X${Math.round(x * 1e6)}Y${Math.round(y * 1e6)}`;
const pad = (name: string, net: string | null, x: number, y: number, layers = ['F.Cu'], extra: Partial<NetPad> = {}): NetPad => ({ name, net, x, y, w: 1, h: 1, shape: 'round', layers, ...extra });
const layer = (id: string, ...body: string[]) => ({ id, objects: readGerber(gerber(...body)).objects });

describe('the netlist check of production files', () => {
  it('finds two nets joined by copper, says where and with which pads', () => {
    const top = layer('F.Cu', 'D10*', `${xy(1, 1)}D03*`, `${xy(6, 1)}D03*`, `${xy(1, 5)}D03*`, 'D11*', `${xy(1, 1)}D02*`, `${xy(6, 1)}D01*`);
    const c = checkCopper([top], [], { pads: [pad('R1.1', 'A', 1, 1), pad('R2.1', 'B', 6, 1), pad('R3.1', 'C', 1, 5)], vias: [] });
    expect(c.found).toBe(3);
    expect(c.findings.map((f) => f.kind)).toEqual(['short']);
    const s = c.findings[0]!;
    expect(s.nets.sort()).toEqual(['A', 'B']);
    expect(s.layer).toBe('F.Cu');
    expect(s.text).toMatch(/^A and B are joined in the files: R[12]\.1 \([AB]\) touches copper of [AB] on F\.Cu/);
    // the spot is on one of the two pads, and the area to show holds it
    expect([1, 6]).toContain(s.at.x);
    expect(s.area[0]).toBeLessThanOrEqual(s.at.x);
    expect(s.area[2]).toBeGreaterThanOrEqual(s.at.x);
    expect(copperCheckText(c)).toContain('1 short');
  });

  it('says where two pads that overlap touch', () => {
    const top = layer('F.Cu', 'D12*', `${xy(2, 2)}D03*`, `${xy(3.9, 2)}D03*`);
    const pads = [pad('U2.2', '+3V3', 2, 2, ['F.Cu'], { w: 2, h: 2, shape: 'rect' }), pad('C13.2', 'GND', 3.9, 2, ['F.Cu'], { w: 2, h: 2, shape: 'rect' })];
    const [s] = checkCopper([top], [], { pads, vias: [] }).findings;
    expect(s?.text).toMatch(/(U2\.2 \(\+3V3\) touches C13\.2 \(GND\)|C13\.2 \(GND\) touches U2\.2 \(\+3V3\)) on F\.Cu/);
    expect(s!.at.x).toBeGreaterThan(2.5);
    expect(s!.at.x).toBeLessThan(3.4);
  });

  it('finds a net in pieces, unless the board leaves that connection open too', () => {
    const top = layer('F.Cu', 'D10*', `${xy(1, 1)}D03*`, `${xy(6, 1)}D03*`, `${xy(9, 1)}D03*`, 'D11*', `${xy(6, 1)}D02*`, `${xy(9, 1)}D01*`);
    const design: NetDesign = { pads: [pad('J1.1', 'VIN', 1, 1), pad('C1.1', 'VIN', 6, 1), pad('U1.1', 'VIN', 9, 1)], vias: [] };
    const open = checkCopper([top], [], design).findings;
    expect(open.map((f) => f.kind)).toEqual(['open']);
    expect(open[0]!.text).toBe('VIN is in 2 pieces in the files, where the board has it joined: the biggest has 2 pads; cut off from it: J1.1');
    expect(open[0]!.pads).toEqual(['J1.1']);
    const known = checkCopper([top], [], { ...design, open: [['J1.1', 'C1.1']] });
    expect(known.findings).toEqual([]);
    expect(known.openInDesign).toBe(1);
  });

  it('joins the layers through the plated holes, and only there', () => {
    // a pad on each side, each with a track to the same spot: joined by a via there, apart without it
    const top = layer('F.Cu', 'D10*', `${xy(1, 1)}D03*`, `${xy(5, 1)}D03*`, 'D11*', `${xy(1, 1)}D02*`, `${xy(5, 1)}D01*`);
    const bottom = layer('B.Cu', 'D10*', `${xy(9, 1)}D03*`, `${xy(5, 1)}D03*`, 'D11*', `${xy(9, 1)}D02*`, `${xy(5, 1)}D01*`);
    const design: NetDesign = { pads: [pad('R1.1', 'N', 1, 1), pad('R2.1', 'N', 9, 1, ['B.Cu'])], vias: [{ net: 'N', x: 5, y: 1, pad: 1, drill: 0.4 }] };
    expect(checkCopper([top, bottom], [{ x: 5, y: 1, d: 0.4 }], design).findings).toEqual([]);
    expect(checkCopper([top, bottom], [], design).findings.map((f) => f.kind)).toEqual(['open']);
  });

  it('finds a plated hole the board does not have, joining two nets on two layers', () => {
    const top = layer('F.Cu', 'D10*', `${xy(1, 1)}D03*`, 'D11*', `${xy(1, 1)}D02*`, `${xy(5, 1)}D01*`);
    const bottom = layer('B.Cu', 'D10*', `${xy(9, 1)}D03*`, 'D11*', `${xy(9, 1)}D02*`, `${xy(5, 1)}D01*`);
    const c = checkCopper([top, bottom], [{ x: 5, y: 1, d: 0.3 }], { pads: [pad('R1.1', 'A', 1, 1), pad('R2.1', 'B', 9, 1, ['B.Cu'])], vias: [] });
    expect(c.findings).toHaveLength(1);
    expect(c.findings[0]!.text).toBe('A and B are joined in the files: a plated hole the board does not have (x 5.00, y 1.00, Ø0.30) joins their copper');
  });

  it('finds a slot whose end reaches a plane: the hole wall joins it, not only its centre', () => {
    // an oval pad of GND on both outer layers, its slot running 1.4 mm up; the plane cut round the
    // slot's centre only, as 0.6.0 cut a foreign oval pad
    const plane = (id: string) => layer(id, 'G36*', `${xy(0, 0)}D02*`, `${xy(20, 0)}D01*`, `${xy(20, 20)}D01*`, `${xy(0, 20)}D01*`, `${xy(0, 0)}D01*`, 'G37*', '%LPC*%', '%ADD20C,1.500000*%', 'D20*', `${xy(10, 10)}D03*`, '%LPD*%', 'D10*', `${xy(15, 15)}D03*`);
    const shield = pad('J2.S1', 'GND', 10, 10, ['F.Cu', 'In1.Cu', 'B.Cu'], { w: 1.1, h: 2.2, drill: 0.6, slot: { w: 0.6, h: 1.7 } });
    const top = layer('F.Cu', '%ADD13O,1.100000X2.200000*%', 'D13*', `${xy(10, 10)}D03*`, 'D10*', `${xy(3, 3)}D03*`, `${xy(15, 15)}D03*`, 'D11*', `${xy(3, 3)}D02*`, `${xy(10, 9)}D01*`);
    const bottom = layer('B.Cu', '%ADD13O,1.100000X2.200000*%', 'D13*', `${xy(10, 10)}D03*`);
    const holes = readExcellon(['M48', 'METRIC', 'T1C0.600', '%', 'G90', 'G05', 'T1', 'G00X10.000Y9.450', 'M15', 'G01X10.000Y10.550', 'M16', 'G05', 'T2C0.300', 'T2', 'X15.000Y15.000', 'M30'].join('\n')).holes;
    const design: NetDesign = { pads: [shield, pad('C1.2', 'GND', 3, 3)], vias: [{ net: '+5V', x: 15, y: 15, pad: 1, drill: 0.3 }] };
    // (+5V: a pad on top, its via down to the plane)
    const c = checkCopper([top, plane('In1.Cu'), bottom], holes, { ...design, pads: [...design.pads, pad('C2.1', '+5V', 15, 15)] });
    const shorts = c.findings.filter((f) => f.kind === 'short');
    expect(shorts.length).toBeGreaterThan(0);
    expect(shorts[0]!.text).toMatch(/^(GND and \+5V|\+5V and GND) are joined in the files: (the plated hole of )?J2\.S1 \(GND\) touches copper of \+5V on In1\.Cu/);
    expect(Math.hypot(shorts[0]!.at.x - 10, shorts[0]!.at.y - 10)).toBeLessThan(1);
  });

  it('finds copper joined to no pad, and a pad that something drawn after it cleared', () => {
    const top = layer('F.Cu', 'G36*', `${xy(10, 10)}D02*`, `${xy(14, 10)}D01*`, `${xy(14, 13)}D01*`, `${xy(10, 13)}D01*`, `${xy(10, 10)}D01*`, 'G37*', 'D10*', `${xy(1, 1)}D03*`, `${xy(5, 1)}D03*`, '%LPC*%', 'D12*', `${xy(5, 1)}D03*`, '%LPD*%');
    const c = checkCopper([top], [], { pads: [pad('R1.1', 'A', 1, 1), pad('R1.2', 'B', 5, 1)], vias: [], areas: [{ net: 'GND', layer: 'F.Cu', box: [9, 9, 15, 14] }] }, { fresh: true });
    expect(c.findings.map((f) => f.kind)).toEqual(['pad', 'floating']);
    expect(c.findings[0]!.text).toBe('R1.2 (B) has no copper on F.Cu in the files, where the board has the pad (something drawn after it cleared it)');
    expect(c.findings[1]!.text).toMatch(/^12(\.\d)? mm² of copper on F\.Cu is joined to no pad \(x 10\.00–14\.00, y 10\.00–13\.00\), where the board has GND copper$/);
  });

  it('leaves out pads the files do not have (a part moved since), and calls them findings in files just made', () => {
    const top = layer('F.Cu', 'D10*', `${xy(1, 1)}D03*`);
    const design: NetDesign = { pads: [pad('R1.1', 'A', 1, 1), pad('C9.1', 'A', 30, 30)], vias: [] };
    const old = checkCopper([top], [], design);
    expect([old.found, old.total, old.notFound, old.findings]).toEqual([1, 2, ['C9'], []]);
    const fresh = checkCopper([top], [], design, { fresh: true });
    expect(fresh.findings.map((f) => f.text)).toEqual(['C9.1 is not in the files: no pad is drawn where the board has it']);
  });
});

/* the files 4k7 writes, held against the board they were made from */

/** The buck converter (4 layers, +3V3 under U2 on In2.Cu and +12V round it), routed; with `ops` after the parts. */
function buck(ops: EditOp[] = []): BoardView {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  const r = k.transact({
    summary: 'planes',
    ops: [
      { op: 'add_part', part: 'ti:LM358DR', refdes: 'U2' },
      { op: 'add_part', part: 'generic:C', refdes: 'C10', params: { capacitance: '100nF', voltage: '16V' } },
      { op: 'connect', pins: ['U2.V+', 'C10.1'], net: '+3V3' },
      { op: 'connect', pins: ['U2.GND', 'C10.2'], net: 'GND' },
      { op: 'connect', pins: ['U2.INA+', 'U2.OUTA', 'U2.INA-'], net: 'BUF' },
      { op: 'set_board', layers: 4 },
      { op: 'set_plane', layer: 'In2.Cu', net: '+12V' },
      { op: 'set_plane', layer: 'In2.Cu', net: '+3V3', under: ['U2'] },
      ...ops,
      { op: 'route' },
    ],
  });
  expect(r.status, JSON.stringify(r).slice(0, 400)).toBe('ok');
  return k.board();
}

/** A USB-C receptacle (power only) whose four shield pins are oval pads round plated slots, on the shield net, in a board of 4 layers with a +5V plane on In2.Cu. */
function usb(rot: 0 | 90 = 0): Kernel {
  const k = new Kernel();
  const d = k.committedDesign();
  d.parts['acme:USBC'] = {
    id: 'acme:USBC',
    description: 'USB-C receptacle (power only)',
    category: 'connector',
    refPrefix: 'J',
    pins: [
      { number: 'A1', name: 'GND', type: 'pwr_in' },
      { number: 'A4', name: 'VBUS', type: 'pwr_in' },
      { number: 'S1', name: 'SHIELD', type: 'passive' },
      { number: 'S2', name: 'SHIELD', type: 'passive' },
    ],
    params: {},
    provenance: { source: 'datasheet' },
  };
  k.load(d);
  const r = k.transact({
    summary: 'usb',
    ops: [
      { op: 'add_part', part: 'acme:USBC', refdes: 'J1' },
      { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '10uF', voltage: '16V', package: '0805' } },
      { op: 'add_part', part: 'generic:C', refdes: 'C2', params: { capacitance: '100nF', voltage: '16V' } },
      { op: 'connect', pins: ['J1.A4', 'C1.1', 'C2.1'], net: '+5V' },
      { op: 'connect', pins: ['J1.A1', 'J1.S1', 'J1.S2', 'C1.2', 'C2.2'], net: 'GND' },
      { op: 'set_footprint', ref: 'J1', name: 'USB-C', pads: [
        { number: 'A1', x: -1, y: -2, w: 0.6, h: 1.15 },
        { number: 'A4', x: 1, y: -2, w: 0.6, h: 1.15 },
        { number: 'S1', x: -4.3, y: 1, w: 1.1, h: 2.2, slot: [0.6, 1.7] },
        { number: 'S2', x: 4.3, y: 1, w: 1.1, h: 2.2, slot: [0.6, 1.7] },
      ] },
      { op: 'set_board', layers: 4, width_mm: 30, height_mm: 20 },
      { op: 'place', ref: 'J1', x_mm: 15, y_mm: 8, rot, lock: true },
      { op: 'set_plane', layer: 'In2.Cu', net: '+5V' },
      { op: 'route' },
    ],
  });
  expect(r.status, JSON.stringify(r.rejection ?? r).slice(0, 400)).toBe('ok');
  k.accept();
  return k;
}

const ownCheck = (b: BoardView) => checkFabSet(readFabFiles(gerbers(b, 'x')), boardNetDesign(b), { fresh: true })!;

describe('the netlist check of the files 4k7 writes', () => {
  it('finds every net joined and no two touching on a board with a split plane', () => {
    const b = buck();
    const c = ownCheck(b);
    expect(c.findings, copperCheckText(c)).toEqual([]);
    expect(c.found).toBe(c.total);
    expect(c.openInDesign).toBe(b.unrouted.length);
    expect(c.layers).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
  }, 120_000);

  it('cuts a plane round a slotted pad of another net as the oval it is (0.6.0 cut a circle, shorting the shield to +5V)', () => {
    for (const rot of [0, 90] as const) {
      const k = usb(rot);
      const b = k.board();
      const plane = b.zones.find((z) => z.layer === 'In2.Cu' && b.netNames[z.netId] === '+5V')!;
      const shield = b.parts.find((p) => p.refdes === 'J1')!.pads.filter((p) => p.slot);
      expect(shield).toHaveLength(2);
      // the cut round each: a stroke along the pad's long side, not a circle
      for (const p of shield) {
        const cut = plane.shape!.cuts.find((c) => c.k === 'stroke' && c.pts.length === 4 && Math.abs((c.pts[0]! + c.pts[2]!) / 2 - p.x) < 1e-3 && Math.abs((c.pts[1]! + c.pts[3]!) / 2 - p.y) < 1e-3);
        expect(cut, `the cut round J1.${p.number} at rot ${rot}`).toBeDefined();
        expect(plane.shape!.cuts.some((c) => c.k === 'circle' && Math.abs(c.x - p.x) < 1e-6 && Math.abs(c.y - p.y) < 1e-6)).toBe(false);
      }
      const c = ownCheck(b);
      expect(c.findings, copperCheckText(c)).toEqual([]);

      // the plane as 0.6.0 cut it (kept so in a design routed then): the check finds the short,
      // and the board as the kernel builds it from the kept copper has the oval cut again
      const old = (cuts: ZoneCut[]): ZoneCut[] =>
        cuts.map((cut) => {
          const p = shield.find((q) => cut.k === 'stroke' && cut.pts.length === 4 && Math.abs((cut.pts[0]! + cut.pts[2]!) / 2 - q.x) < 1e-3 && Math.abs((cut.pts[1]! + cut.pts[3]!) / 2 - q.y) < 1e-3);
          return p && cut.k === 'stroke' ? { k: 'circle', x: p.x, y: p.y, d: Math.round((Math.min(p.w, p.h) + cut.w - Math.min(p.w, p.h)) * 1000) / 1000 } : cut;
        });
      const zones = b.zones.map((z) => (z === plane ? { ...z, shape: { ...z.shape!, cuts: old(z.shape!.cuts) } } : z));
      const broken = ownCheck({ ...b, zones });
      const shorts = broken.findings.filter((f) => f.kind === 'short');
      expect(shorts.length, copperCheckText(broken)).toBeGreaterThan(0);
      expect(shorts[0]!.nets.sort()).toEqual(['+5V', 'GND']);
      expect(shorts[0]!.text).toMatch(/J1\.S[12]/);
      const mended = capsuleCuts(zones, b.parts.flatMap((p) => p.pads));
      expect(ownCheck({ ...b, zones: mended }).findings).toEqual([]);
    }
  }, 240_000);

  it('mends the cut in a design routed before the fix when it opens, without routing again', () => {
    const k = usb();
    // (the copper kept with the design, as the app keeps what its board worker routed)
    expect(k.keepCopper(k.board().newCopper!)).toBe(true);
    const d = structuredClone(k.committedDesign());
    const stored = d.board!.copper!;
    const plane = stored.zones.find((z) => z.layer === 'In2.Cu')!;
    const pads = k.board().parts.flatMap((p) => p.pads.filter((q) => q.slot));
    plane.shape!.cuts = plane.shape!.cuts.map((c) => {
      const p = pads.find((q) => c.k === 'stroke' && c.pts.length === 4 && Math.abs((c.pts[0]! + c.pts[2]!) / 2 - q.x) < 1e-3);
      return p && c.k === 'stroke' ? { k: 'circle', x: p.x, y: p.y, d: Math.round((Math.min(p.w, p.h) + c.w - Math.min(p.w, p.h)) * 1000) / 1000 } : c;
    });
    const again = new Kernel();
    again.load(d);
    const b = again.board();
    expect(b.newCopper).toBeUndefined(); // the kept copper, not routed again
    expect(b.zones.find((z) => z.layer === 'In2.Cu')!.shape!.cuts.filter((c) => c.k === 'circle' && pads.some((p) => Math.abs(c.x - p.x) < 1e-6))).toEqual([]);
    expect(ownCheck(b).findings).toEqual([]);
  }, 120_000);

  it('holds a panel against its copies, each copy\'s nets apart, the fiducials joined to nothing on purpose', () => {
    const b = buck([{ op: 'set_board', width_mm: 40, height_mm: 30 }, { op: 'set_panel' }]);
    const p = panelBoard(b, b.panel!);
    const c = checkFabSet(readFabFiles(gerbers(p, 'x', b.panel)), boardNetDesign(b, b.panel), { fresh: true })!;
    expect(b.panel!.copies.length).toBeGreaterThan(1);
    expect(c.findings, copperCheckText(c)).toEqual([]);
    expect(c.total).toBe(b.panel!.copies.length * b.parts.flatMap((q) => q.pads.filter((d) => !d.npth)).length);
  }, 120_000);
});

describe('pads of two nets that touch', () => {
  it('are a short in the design checks, not only courtyards overlapping', () => {
    const k = new Kernel();
    const r = k.transact({
      summary: 'overlap',
      ops: [
        { op: 'add_part', part: 'generic:R', refdes: 'R1', params: { resistance: '10k', package: '0603' } },
        { op: 'add_part', part: 'generic:R', refdes: 'R2', params: { resistance: '10k', package: '0603' } },
        { op: 'connect', pins: ['R1.1', 'R2.1'], net: 'A' },
        { op: 'connect', pins: ['R1.2'], net: 'B' },
        { op: 'connect', pins: ['R2.2'], net: 'C' },
        { op: 'set_board', width_mm: 20, height_mm: 20 },
        { op: 'place', ref: 'R1', x_mm: 8, y_mm: 10, rot: 0, lock: true },
        // R2's pin 2 lands a little over R1's pin 2
        { op: 'place', ref: 'R2', x_mm: 9.5, y_mm: 10.4, rot: 0, lock: true },
      ],
    });
    expect(r.status).toBe('ok');
    const shorts = k.board().diagnostics.filter((x) => x.code === 'DRC.SHORT');
    expect(shorts.map((x) => x.message)).toEqual([expect.stringMatching(/^(R1\.2 \(B\) touches R2\.1 \(A\)|R2\.1 \(A\) touches R1\.2 \(B\)) on F\.Cu: a short\. Move R[12] or R[12] until their copper is clear\.$/)]);
    expect(shorts.every((x) => x.severity === 'error')).toBe(true);
  });
});
