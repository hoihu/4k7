import { describe, expect, it } from 'vitest';
import type { LandPad, PackageInfo } from '@4k7/schema';
import { BUILTIN_PARTS, footprintFor, landRingOffset, packageOf, packageOptions, standardPackage } from '../src/index.ts';
import { corrected, wrong } from './fixtures/esp32c3.ts';

describe('landRingOffset: a ring of pads that does not line up', () => {
  it('finds the wrong ESP32-C3-MINI-1 land', () => {
    const r = landRingOffset(wrong);
    expect(r).not.toBeNull();
    expect(r!.offset).toBeCloseTo(0.7, 2);
    expect(r!.text).toMatch(/pads 1–11.*0\.7 mm/);
  });

  it('passes the corrected one, though it lies 2.2 mm off the body centre', () => {
    expect(landRingOffset(corrected)).toBeNull();
  });

  it('passes a land with pads on two sides only, or a grid', () => {
    const soic = footprintFor(standardPackage('SOIC-8', 8)!).ok;
    expect(soic).toBe(true);
    const grid: LandPad[] = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) grid.push({ number: `${r}${c}`, x: c, y: r + (c === 0 ? 0.3 : 0), w: 0.5 });
    expect(landRingOffset(grid)).toBeNull();
  });

  it('finds nothing in any footprint the library builds', () => {
    const checked: string[] = [];
    const flagged: string[] = [];
    const tryPkg = (label: string, pkg: PackageInfo | null, pins: string[]) => {
      if (!pkg) return;
      const fp = footprintFor(pkg, pins);
      if (!fp.ok) throw new Error(`${label}: ${fp.reason}`);
      checked.push(label);
      const r = landRingOffset(fp.footprint.pads);
      if (r) flagged.push(`${label}: ${r.text}`);
    };
    for (const card of BUILTIN_PARTS) {
      const pins = card.pins.map((p) => p.number);
      tryPkg(card.id, packageOf(card), pins);
      for (const name of packageOptions(card)) tryPkg(`${card.id} ${name}`, packageOf(card, { package: name }), pins);
    }
    for (const n of [2, 3, 4, 5, 6, 8, 10, 16, 20, 40]) {
      for (const name of [`HDR-1x${n}`, `HDR-2x${n}`, `JST-XH-${n}`, `QFN-${n}`, `TSSOP-${n}`, `SOIC-${n}`]) tryPkg(name, standardPackage(name, n), []);
    }
    for (const pins of [16, 32, 48, 64, 100]) {
      for (const pitch of [0.4, 0.5, 0.65, 0.8]) {
        const side = (pins / 4) * pitch + 1;
        tryPkg(`QFN-${pins} ${pitch}`, { name: 'QFN', family: 'QFN', pins, pitch_mm: pitch, body_mm: [side, side], exposed_pad_mm: [2, 2] }, []);
        tryPkg(`QFN-${pins} ${pitch} oblong`, { name: 'QFN', family: 'QFN', pins, pitch_mm: pitch, body_mm: [side, side + 1] }, []);
        tryPkg(`QFP-${pins} ${pitch}`, { name: 'QFP', family: 'QFP', pins, pitch_mm: pitch, body_mm: [side, side] }, []);
        tryPkg(`TSSOP-${pins} ${pitch}`, { name: 'TSSOP', family: 'TSSOP', pins, pitch_mm: pitch, body_mm: [4.4, (pins / 2) * pitch + 1] }, []);
      }
    }
    for (const [rows, cols] of [[4, 4], [6, 6], [8, 10]] as const) tryPkg(`BGA ${rows}x${cols}`, { name: 'BGA', family: 'BGA', pins: rows * cols, pitch_mm: 0.8, grid: { rows, cols } }, []);
    tryPkg('MODULE-40', { name: 'M', family: 'MODULE', pins: 40, pitch_mm: 2.54, body_mm: [21, 51], span_mm: [17.78, 48.26] }, []);
    expect(flagged).toEqual([]);
    expect(checked.length).toBeGreaterThan(120);
  });

  it('finds a generated quad land with one column moved', () => {
    const fp = footprintFor({ name: 'QFN', family: 'QFN', pins: 32, pitch_mm: 0.5, body_mm: [5, 5] });
    if (!fp.ok) throw new Error(fp.reason);
    expect(landRingOffset(fp.footprint.pads)).toBeNull();
    const moved = fp.footprint.pads.map((p) => (p.number <= '8' && p.number.length === 1 ? { ...p, y: p.y + 0.2 } : p));
    expect(landRingOffset(moved)?.offset).toBeCloseTo(0.2, 2);
  });
});
