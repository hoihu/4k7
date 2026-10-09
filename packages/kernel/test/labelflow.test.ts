import { describe, expect, it } from 'vitest';
import type { LabelView } from '@tracewise/schema';
import { Kernel } from '../src/index.ts';

const labels = (k: Kernel): LabelView[] => k.state().view.sheets.flatMap((s) => s.labels);

describe('net label direction', () => {
  it('follows the pin type: outputs point away from the part, inputs at it', () => {
    const k = new Kernel();
    k.transact({ summary: 'op-amp', ops: [
      { op: 'add_part', part: 'ti:LM358DR', refdes: 'U1' },
      { op: 'connect', pins: ['U1.OUTA'], net: 'SIG_OUT' },
      { op: 'connect', pins: ['U1.INA+'], net: 'SIG_IN' },
    ] });
    const byText = Object.fromEntries(labels(k).map((l) => [l.text, l]));
    expect(byText['SIG_OUT']?.flow).toBe('out');
    expect(byText['SIG_IN']?.flow).toBeUndefined();
  });
});
