import { describe, expect, it } from 'vitest';
import type { LabelView } from '@tracewise/schema';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

const labels = (k: Kernel): LabelView[] => k.state().view.sheets.flatMap((s) => s.labels);
const supplies = (k: Kernel) => labels(k).filter((l) => l.kind === 'rail' || l.kind === 'ground');

describe('supply symbols', () => {
  it('are always vertical, in the reference drawing and on connector pins', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    const s = supplies(k);
    expect(s.length).toBeGreaterThan(3);
    for (const l of s) expect(['up', 'down'], `${l.text} points ${l.dir}`).toContain(l.dir);
    // the regulator's rail ends are upright supply symbols
    expect(s.find((l) => l.text === '+3V3')?.dir).toBe('up');
    expect(s.find((l) => l.text === '+12V' && !l.stub)?.dir).toBe('up');
    // on J1's horizontal pins: a stub, then the vertical symbol
    const j1 = s.filter((l) => l.stub);
    expect(j1.map((l) => `${l.text}:${l.dir}:${l.stub}`).sort()).toEqual(['+12V:up:right', 'GND:down:right']);
  });

  it('point down for negative rails', () => {
    const k = new Kernel();
    k.transact({ summary: 'split supply', ops: [
      { op: 'add_part', part: 'ti:LM358DR', refdes: 'U1' },
      { op: 'add_part', part: 'generic:CONN_1x3', refdes: 'J1' },
      { op: 'connect', pins: ['J1.1', 'U1.V+'], net: '+12V' },
      { op: 'connect', pins: ['J1.2'], net: 'GND' },
      { op: 'connect', pins: ['J1.3', 'U1.GND'], net: 'VEE' },
      { op: 'set_net', net: 'VEE', voltage: -12, external: true },
    ] });
    const vee = supplies(k).filter((l) => l.text === 'VEE');
    expect(vee.length).toBeGreaterThan(0);
    for (const l of vee) expect(l.dir).toBe('down');
  });

  it('stagger on neighbouring pins so they do not run into each other', () => {
    const k = new Kernel();
    k.transact({ summary: 'power header', ops: [
      { op: 'add_part', part: 'generic:CONN_1x4', refdes: 'J1' },
      { op: 'connect', pins: ['J1.1'], net: '+5V' },
      { op: 'connect', pins: ['J1.2'], net: '+3V3' },
      { op: 'connect', pins: ['J1.3'], net: 'GND' },
      { op: 'connect', pins: ['J1.4'], net: 'AGND' },
    ] });
    const byName = Object.fromEntries(supplies(k).map((l) => [l.text, l]));
    // the upper rail keeps the short stub, the one below steps out further
    expect(byName['+5V']!.stubLen).toBe(100);
    expect(byName['+3V3']!.stubLen).toBe(300);
    // grounds step out from the bottom
    expect(byName['AGND']!.stubLen).toBe(100);
    expect(byName['GND']!.stubLen).toBe(300);
  });
});
