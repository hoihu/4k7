import { describe, expect, it } from 'vitest';
import type { BringUpPlan } from '@4k7/schema';
import { bringUpHtml } from '../src/lib/bringupdoc.ts';

const plan: BringUpPlan = {
  rails: [
    { net: '+5V', voltage: 5, source: 'J1 (connector)', input: true, testPoints: [{ ref: 'TP1', label: 'TP_+5V' }], supply: { draw_a: 0.1, basis: 'loads', limit_a: 0.15 } },
    { net: '+3V3', voltage: 3.3, source: 'U1 (linear regulator from +5V)', input: false, testPoints: [], probeAt: 'U1.VOUT' },
  ],
  steps: ['Power +5V: set the bench supply to 5 V.', 'Check +3V3: expect 3.3 V at U1.VOUT (no test point).'],
};

describe('design document: bring-up section', () => {
  it('has the rails in order with their voltage, test point or probe note, and the current limit', () => {
    const html = bringUpHtml(plan)!;
    expect(html.indexOf('+5V')).toBeLessThan(html.indexOf('+3V3'));
    expect(html).toContain('5 V');
    expect(html).toContain('3.3 V');
    expect(html).toContain('<b>TP1</b>');
    expect(html).toContain('no test point — probe at <span class="mono">U1.VOUT</span>');
    expect(html).toContain('150 mA');
    expect(html).toContain('<h3>At the bench</h3><ol><li>Power +5V');
  });

  it('says unknown for a current limit not known, never a number', () => {
    const html = bringUpHtml({ ...plan, rails: [{ ...plan.rails[0]!, supply: { draw_a: 'unknown', basis: 'unknown', limit_a: 'unknown' } }] })!;
    expect(html).toContain('unknown — start low');
    expect(html).not.toContain('150 mA');
  });

  it('is left out of a design without supply rails', () => {
    expect(bringUpHtml({ rails: [], steps: [], note: 'No supply rails' })).toBeNull();
    expect(bringUpHtml(null)).toBeNull();
  });

  it('is unchanged on one board: no Board column', () => {
    const html = bringUpHtml(plan)!;
    expect(html).not.toContain('<th>Board</th>');
    expect(html).not.toContain('One sheet for all the boards');
  });

  it('is one sheet for a design of several boards, naming each rail\'s boards, the mate it crosses and the probe point\'s board', () => {
    const two: BringUpPlan = {
      rails: [
        { ...plan.rails[0]!, boards: ['Main', 'LED board'], crosses: [{ board: 'LED board', through: 'J2↔J3', pins: 1, probeAt: 'J3.1' }] },
        { ...plan.rails[1]!, boards: ['LED board'], testPoints: [{ ref: 'TP2', label: 'TP_+3V3', board: 'LED board' }] },
      ],
      steps: plan.steps,
    };
    const html = bringUpHtml(two)!;
    expect(html.match(/<h3>At the bench<\/h3>/g)).toHaveLength(1);
    expect(html.match(/<table>/g)).toHaveLength(1);
    expect(html).toContain('<th>Rail</th><th>Board</th>');
    expect(html).toContain('<td>Main, LED board<br><span class="muted">reaches LED board through J2↔J3, 1 pin</span></td>');
    expect(html).toContain('<b>TP2</b> <span class="mono">TP_+3V3</span> <span class="muted">on LED board</span>');
    expect(html).toContain('One sheet for all the boards');
  });
});
