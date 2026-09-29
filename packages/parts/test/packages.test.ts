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
