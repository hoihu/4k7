import { describe, expect, it } from 'vitest';
import { BUILTIN_PARTS, body3dFor, footprintFor, isModule, packageOf, standardPackage } from '../src/index.ts';

describe('standard packages', () => {
  it('gives every library part a footprint with a pad for each pin, and a 3D body', () => {
    for (const card of BUILTIN_PARTS) {
      const pkg = packageOf(card);
      expect(pkg, card.id).toBeTruthy();
      const fp = footprintFor(pkg!, card.pins.map((p) => p.number));
      if (!fp.ok) throw new Error(`${card.id}: ${fp.reason}`);
      const pads = new Set(fp.footprint.pads.map((p) => p.number));
      for (const pin of card.pins) expect(pads.has(pin.number), `${card.id} pin ${pin.number}`).toBe(true);
      expect(body3dFor(pkg!, card.pins.map((p) => p.number)).ok, card.id).toBe(true);
    }
  });

  it('uses the package parameter of the placed part', () => {
    const r = BUILTIN_PARTS.find((c) => c.id === 'generic:R')!;
    expect(packageOf(r, { package: '1206' })?.body_mm).toEqual([3.2, 1.6]);
    expect(packageOf(r)?.name).toBe('0603');
    expect(standardPackage('0402')?.family).toBe('CHIP');
    expect(standardPackage('whatever')).toBeNull();
  });

  it('lays out 0603 pads like the usual land pattern', () => {
    const fp = footprintFor(standardPackage('0603')!);
    if (!fp.ok) throw new Error(fp.reason);
    const [p1, p2] = fp.footprint.pads;
    expect(p1!.x).toBeCloseTo(-p2!.x, 6);
    expect(p2!.x).toBeGreaterThan(0.6);
    expect(p2!.x).toBeLessThan(0.9); // KiCad: ±0.775
    expect(p1!.h).toBeCloseTo(0.95, 2);
  });

  it('puts the SOT-223 tab on the output pin', () => {
    const fp = footprintFor(standardPackage('SOT-223')!, ['1', '2', '3']);
    if (!fp.ok) throw new Error(fp.reason);
    expect(fp.footprint.pads.map((p) => p.number)).toEqual(['1', '2', '3', '2']);
    expect(fp.footprint.pads[3]!.w).toBeGreaterThan(3);
  });
});

describe('modules (a carrier board with two rows of pins)', () => {
  // the Raspberry Pi Pico as a datasheet import recorded it: "DIP", 21 × 51 mm, no row spacing
  const pico = { name: '40-pin DIP', family: 'DIP' as const, pins: 40, pitch_mm: 2.54, body_mm: [21, 51] as [number, number], height_mm: 1 };

  it('a "DIP" wider than its pin rows is a module: pads under the long edges, numbered like a DIP', () => {
    expect(isModule(pico)).toBe(true);
    const r = footprintFor(pico, Array.from({ length: 40 }, (_, i) => String(i + 1)));
    if (!r.ok) throw new Error(r.reason);
    const pad = (n: string) => r.footprint.pads.find((p) => p.number === n)!;
    expect(r.footprint.pads).toHaveLength(40);
    // rows 17.78 mm apart (0.7"), pin 1 top left, 20 down the left, 21 bottom right, 40 top right
    expect([pad('1').x, pad('1').y]).toEqual([-8.89, -24.13]);
    expect([pad('20').x, pad('20').y]).toEqual([-8.89, 24.13]);
    expect([pad('21').x, pad('21').y]).toEqual([8.89, 24.13]);
    expect([pad('40').x, pad('40').y]).toEqual([8.89, -24.13]);
    expect(r.footprint.pads.every((p) => p.drill)).toBe(true);
    expect(r.footprint.courtyard.w).toBeGreaterThanOrEqual(21);
    expect(r.footprint.courtyard.h).toBeGreaterThanOrEqual(51);
  });

  it('its 3D body is a green carrier board with castellated pads, not a plastic DIP', () => {
    const r = body3dFor(pico);
    if (!r.ok) throw new Error(r.reason);
    expect(r.body.board && [r.body.board.w, r.body.board.h, r.body.board.t]).toEqual([21, 51, 1]);
    // a drilled hole at every pin
    expect(r.body.board!.holes).toHaveLength(40);
    expect(r.body.board!.holes[0]).toEqual({ x: -8.89, y: -24.13, d: 1 });
    // pads reach the board edge (castellations)
    expect(r.body.boxes.some((b) => b.mat === 'lead' && b.max[0] >= 10.5)).toBe(true);
  });

  it('MODULE with the row spacing given; a real DIP stays a DIP', () => {
    const esp = { name: 'ESP32-DevKit', family: 'MODULE' as const, pins: 30, pitch_mm: 2.54, body_mm: [28, 52] as [number, number], span_mm: [25.4, 0] as [number, number] };
    const r = footprintFor(esp);
    if (!r.ok) throw new Error(r.reason);
    expect(r.footprint.pads.find((p) => p.number === '1')!.x).toBe(-12.7);
    const dip8 = { name: 'DIP-8', family: 'DIP' as const, pins: 8, pitch_mm: 2.54, body_mm: [6.35, 9.8] as [number, number] };
    expect(isModule(dip8)).toBe(false);
    const d = body3dFor(dip8);
    expect(d.ok && d.body.board).toBeFalsy();
  });
});

describe('explicit land patterns (from a datasheet drawing)', () => {
  // a 12 mm buzzer, two leads 7.6 mm apart (Buzzer_12x9.5RM7.6)
  const buzzer = {
    name: 'Buzzer_12x9.5RM7.6',
    family: 'other' as const,
    pins: 2,
    body_mm: [12, 12] as [number, number],
    body_shape: 'round' as const,
    height_mm: 9.5,
    pads: [
      { number: '1', x: -3.8, y: 0, w: 1.6, drill: 0.9, shape: 'rect' as const },
      { number: '2', x: 3.8, y: 0, w: 1.6, drill: 0.9 },
    ],
  };

  it('uses the pads as given, with a round body and a courtyard around it', () => {
    const r = footprintFor(buzzer, ['1', '2']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.footprint.pads.map((p) => [p.number, p.x, p.y, p.w, p.h, p.shape, p.drill])).toEqual([
      ['1', -3.8, 0, 1.6, 1.6, 'rect', 0.9],
      ['2', 3.8, 0, 1.6, 1.6, 'round', 0.9],
    ]);
    expect(r.footprint.body).toEqual({ w: 12, h: 12, round: true });
    expect(r.footprint.courtyard).toEqual({ w: 13, h: 13 });
  });

  it('refuses missing pads, overlapping pads and drills without a copper ring', () => {
    expect(footprintFor({ ...buzzer, pads: [buzzer.pads[0]!] }, ['1', '2'])).toMatchObject({ ok: false, reason: expect.stringContaining('pins without a pad: 2') });
    expect(footprintFor({ ...buzzer, pads: [buzzer.pads[0]!, { ...buzzer.pads[1]!, x: -3 }] }, ['1', '2'])).toMatchObject({ ok: false, reason: expect.stringContaining('overlap') });
    expect(footprintFor({ ...buzzer, pads: [buzzer.pads[0]!, { ...buzzer.pads[1]!, drill: 1.5 }] }, ['1', '2'])).toMatchObject({ ok: false, reason: expect.stringContaining('copper ring') });
  });

  // a USB-C receptacle in short: GND on A1 and B12 share one pad, the shell legs go into slots
  const usbc = {
    name: 'USB-C',
    family: 'other' as const,
    pins: 4,
    pads: [
      { number: 'A1', also: ['B12'], x: -1, y: 0, w: 0.6, h: 1.15 },
      { number: 'A4', x: 0, y: 0, w: 0.6, h: 1.15 },
      { number: 'S1', x: -4.3, y: 1, w: 1.1, h: 2.2, slot: [0.6, 1.7] as [number, number] },
      { number: 'S1', x: 4.3, y: 1, w: 1.1, h: 2.2, slot: [0.6, 1.7] as [number, number] },
    ],
  };

  it('lands several pins on one pad, and drills slots', () => {
    const r = footprintFor(usbc, ['A1', 'B12', 'A4', 'S1']);
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    expect(r.footprint.pads[0]).toMatchObject({ number: 'A1', also: ['B12'], w: 0.6, h: 1.15, shape: 'rect' });
    expect(r.footprint.pads[0]!.drill).toBeUndefined();
    // a slot: round-ended copper round it, its width the drill
    expect(r.footprint.pads[2]).toMatchObject({ shape: 'round', drill: 0.6, slot: { w: 0.6, h: 1.7 } });
  });

  it('refuses a shared pin the part does not have, and a slot without a copper ring', () => {
    const pins = ['A1', 'B12', 'A4', 'S1'];
    const stray = { ...usbc, pads: [{ ...usbc.pads[0]!, also: ['B12', 'B13'] }, ...usbc.pads.slice(1)] };
    expect(footprintFor(stray, pins)).toMatchObject({ ok: false, reason: expect.stringContaining('pins the part does not have: B13') });
    const noB12 = { ...usbc, pads: [{ ...usbc.pads[0]!, also: [] }, ...usbc.pads.slice(1)] };
    expect(footprintFor(noB12, pins)).toMatchObject({ ok: false, reason: expect.stringContaining('pins without a pad: B12') });
    const tight = { ...usbc, pads: [...usbc.pads.slice(0, 3), { ...usbc.pads[3]!, h: 1.8 }] };
    expect(footprintFor(tight, pins)).toMatchObject({ ok: false, reason: expect.stringContaining('0.6 × 1.7 mm slot leaves no copper ring') });
  });

  it('builds a cylindrical 3D body with leads through the board', () => {
    const r = body3dFor(buzzer, ['1', '2']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.height).toBe(9.5);
    expect(r.body.cylinders?.filter((c) => c.mat === 'body')).toEqual([{ x: 0, y: 0, z0: 0.3, z1: 9.5, r: 6, mat: 'body' }]);
    expect(r.body.cylinders?.filter((c) => c.mat === 'lead').map((c) => [c.x, c.z0])).toEqual([[-3.8, -3], [3.8, -3]]);
  });
});

describe('part titles', () => {
  it('names the part, not a description of it', async () => {
    const { partTitle, mpnBase, BUILTIN_PARTS } = await import('../src/index.ts');
    const base = { id: 'x:y', category: 'ic' as const, refPrefix: 'U', pins: [], params: {}, provenance: { source: 'datasheet' as const } };
    expect(partTitle({ ...base, mpn: 'SC0915', description: 'Raspberry Pi Pico - RP2040-based microcontroller module, 40-pin' })).toBe('Raspberry Pi Pico');
    expect(partTitle({ ...base, mpn: 'STM32F777NIH6', description: 'STM32F777 Arm Cortex-M7 MCU, 216 MHz' })).toBe('STM32F777');
    expect(partTitle({ ...base, mpn: 'ADIN2111BCPZ', description: '2-port 10BASE-T1L Ethernet switch with integrated PHYs' })).toBe('ADIN2111');
    expect(partTitle({ ...base, mpn: 'X', title: 'Pico', description: 'whatever' })).toBe('Pico');
    expect(['TPS54331DR', 'AMS1117-3.3', 'MCP1700T-3302E/TT', 'NE555DR', 'ATTINY85-20SU', 'ABI-009-RC', 'SC0915'].map(mpnBase)).toEqual(['TPS54331', 'AMS1117', 'MCP1700', 'NE555', 'ATTINY85', 'ABI-009', 'SC0915']);
    expect(partTitle(BUILTIN_PARTS.find((p) => p.id === 'generic:NMOS')!)).toBe('MOSFET');
    expect(partTitle(BUILTIN_PARTS.find((p) => p.id === 'ti:TPS54331DR')!)).toBe('TPS54331');
  });
});

describe('passive packages: through-hole, defaults and sizing', () => {
  it('knows axial, radial and the KiCad names, with footprints and 3D bodies', async () => {
    const { standardPackage, footprintFor, body3dFor } = await import('../src/index.ts');
    const ax = standardPackage('AXIAL-0.4')!;
    expect(ax).toMatchObject({ family: 'AXIAL', pitch_mm: 10.16, body_mm: [6.3, 2.5] });
    const fp = footprintFor(ax, ['1', '2']);
    expect(fp.ok && fp.footprint.pads.map((p) => [p.x, !!p.drill])).toEqual([[-5.08, true], [5.08, true]]);
    expect(standardPackage('R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm')).toMatchObject({ family: 'AXIAL', pitch_mm: 10.16 });
    expect(standardPackage('RADIAL-D8')).toMatchObject({ family: 'RADIAL', pitch_mm: 3.5, body_mm: [8, 8] });
    expect(standardPackage('CP_Radial_D10.0mm_P5.00mm')).toMatchObject({ family: 'RADIAL', pitch_mm: 5 });
    expect(standardPackage('DO-41')).toMatchObject({ family: 'AXIAL', pitch_mm: 10.16 });
    expect(standardPackage('LED-5mm')).toMatchObject({ family: 'RADIAL', pitch_mm: 2.54 });
    expect(standardPackage('6x6mm')?.name).toBe('IND-6x6');
    for (const n of ['AXIAL-0.4', 'RADIAL-D8', 'DO-41', 'LED-3mm']) expect(body3dFor(standardPackage(n)!, ['1', '2']).ok, n).toBe(true);
    const round = footprintFor(standardPackage('RADIAL-D8')!, ['1', '2']);
    expect(round.ok && round.footprint.body.round).toBe(true);
  });

  it('chooses: the part\'s own package, else the design default, sized up where the value demands', async () => {
    const { packageChoice, BUILTIN_PARTS } = await import('../src/index.ts');
    const C = BUILTIN_PARTS.find((p) => p.id === 'generic:C')!;
    const R = BUILTIN_PARTS.find((p) => p.id === 'generic:R')!;
    expect(packageChoice(C, { capacitance: '100nF' })).toEqual({ name: '0603', why: 'library' });
    expect(packageChoice(C, { capacitance: '100nF' }, { capacitor: '0402' })).toEqual({ name: '0402', why: 'default' });
    expect(packageChoice(C, { capacitance: '22uF', voltage: '10V' }, { capacitor: '0402' })).toMatchObject({ name: '1206', why: 'auto' });
    expect(packageChoice(C, { capacitance: '1uF', voltage: '35V' })).toMatchObject({ name: '0805', why: 'auto' });
    // sizing only goes up, and never past what was chosen explicitly
    expect(packageChoice(C, { capacitance: '22uF' }, { capacitor: '1812' })).toEqual({ name: '1812', why: 'default' });
    expect(packageChoice(C, { capacitance: '22uF', package: '0603' })).toEqual({ name: '0603', why: 'set' });
    expect(packageChoice(C, { capacitance: '22uF' }, { autoSize: false })).toEqual({ name: '0603', why: 'library' });
    expect(packageChoice(R, { resistance: '1', power: '0.5W' })).toMatchObject({ name: '2010', why: 'auto' });
    // a through-hole default is not resized
    expect(packageChoice(R, { resistance: '1', power: '0.5W' }, { resistor: 'AXIAL-0.4' })).toEqual({ name: 'AXIAL-0.4', why: 'default' });
  });
});
