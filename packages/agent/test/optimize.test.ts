import { describe, expect, it } from 'vitest';
import type { ScopeInfo, TransactionResult } from '@4k7/schema';
import { compactTx, describeTx, formatDesignContext, formatScope, optimizePrompt } from '../src/index.ts';

const info: ScopeInfo = {
  scope: { view: 'schematic', sheet: 's_1', rect: { x: 0, y: 0, w: 1000, h: 1000 }, goal: 'the divider is far from U1' },
  sheetName: 'Main',
  free: ['R1', 'R2', 'C2'],
  anchored: [{ ref: 'U1', why: 'cut by the edge of the area' }],
  context: 5,
  boundaryNets: ['FB', 'GND'],
  measures: { crossings: 2, wireIn: 14.5, labels: 1 },
};

describe('optimize', () => {
  it('tells the agent what it may move, what it may only refer to and where the numbers stand', () => {
    const t = formatScope(info);
    expect(t).toContain('movable (inside the area): R1 R2 C2');
    expect(t).toContain('U1 (cut by the edge of the area)');
    expect(t).toContain('nets that leave the area: FB GND');
    expect(t).toContain('crossings 2, wire 14.5 in, net labels 1');
    expect(t).toContain("the user's goal: the divider is far from U1");
  });

  it('puts the scope next to the selection in the design context', () => {
    const base = {
      summary: { name: 'x', sheets: ['Main'], pages: 1, components: [], nets: [], counts: { errors: 0, warnings: 0, infos: 0, waived: 0 }, ledger: 0, waivers: 0 },
      diagnostics: [],
      ledger: [],
      selection: [],
    };
    expect(formatDesignContext({ ...base, scope: info })).toContain('<scope view="schematic" sheet="Main">');
    expect(formatDesignContext({ ...base, scope: null })).not.toContain('<scope');
  });

  it('starts a run with rules the kernel also enforces, and the goal when there is one', () => {
    const p = optimizePrompt(info);
    expect(p).toContain('What bothers me: the divider is far from U1');
    expect(p).toContain('changing nothing is a good answer');
    expect(optimizePrompt({ ...info, scope: { ...info.scope, goal: undefined } })).not.toContain('What bothers me');
  });

  it('hands the model the measures and ripple of a dry run', () => {
    const r = {
      status: 'ok',
      dryRun: true,
      results: [],
      diff: { added: [], removed: [], changed: [] },
      counts: { errors: 0, warnings: 0, infos: 0, waived: 0 },
      introduced: [],
      resolved: [],
      scope: { ripple: ['J1'], measures: { crossings: 0, wireIn: 12, labels: 1 }, baseline: info.measures },
    } as TransactionResult;
    expect(compactTx(r)).toMatchObject({ scope: { ripple: ['J1'], baseline: { crossings: 2 } } });
    expect(describeTx(r)).toContain('ripple 1 · crossings 2→0');
  });
});
