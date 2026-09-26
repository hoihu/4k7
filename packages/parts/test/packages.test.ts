import { describe, expect, it } from 'vitest';
import { BUILTIN_PARTS, body3dFor, footprintFor, packageOf, standardPackage } from '../src/index.ts';

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
