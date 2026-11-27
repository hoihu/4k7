import { describe, expect, it } from 'vitest';
import type { CableEntry } from '@4k7/kernel';
import { cableHtml } from '../src/lib/cabledoc.ts';

const pin = (number: string, name = number) => ({ number, name });
const cable: CableEntry = {
  id: 'm1',
  kind: 'cable',
  cable: 'reversed',
  length_mm: 150,
  a: { refdes: 'J2', part: 'generic:CONN_1x2', board: 'Main' },
  b: { refdes: 'J3', part: 'generic:CONN_1x2', board: 'LED board' },
  rows: [
    { a: pin('1', 'VCC'), b: pin('2'), net: '+3V3', mismatch: { net: 'GND' } },
    { a: pin('2'), b: pin('1'), net: 'GND', mismatch: { net: '+3V3' } },
  ],
};

describe('design document: cable section', () => {
  it('heads each cable with both ends and their boards, the kind and the length', () => {
    const html = cableHtml([cable])!;
    expect(html).toContain('J2 (Main) ↔ J3 (LED board)');
    expect(html).toContain('cable, reversed');
    expect(html).toContain('150 mm');
    expect(html).toContain('<th>Pin A</th><th>Net</th><th>Pin B</th>');
  });

  it('has a row per pin with its net, and marks the pins that meet another net', () => {
    const html = cableHtml([cable])!;
    expect(html).toContain('<td class="mono">J2.1 VCC</td><td class="mono">+3V3</td><td><span class="mono">J3.2</span>');
    expect(html).toContain('mismatch: J3.2 is on GND');
    const fine = cableHtml([{ ...cable, rows: [{ a: pin('1'), b: pin('1'), net: '+3V3' }] }])!;
    expect(fine).not.toContain('mismatch:');
  });

  it('says when the length is not set', () => {
    const { length_mm: _, ...noLength } = cable;
    expect(cableHtml([noLength])).toContain('length not set');
  });

  it('says a far pin on no net', () => {
    expect(cableHtml([{ ...cable, rows: [{ a: pin('1'), b: pin('1'), net: '+3V3', mismatch: { net: null } }] }])).toContain('mismatch: J3.1 is on no net');
  });

  it('is left out without cables', () => {
    expect(cableHtml([])).toBeNull();
    expect(cableHtml(null)).toBeNull();
  });

  it('escapes the text', () => {
    const html = cableHtml([{ ...cable, a: { ...cable.a, board: '<b>&' } }])!;
    expect(html).toContain('J2 (&lt;b&gt;&amp;)');
    expect(html).not.toContain('<b>&');
  });
});
