import { describe, expect, it } from 'vitest';
import { DESIGN_GUIDE, type SpecAnswer } from '@4k7/schema';
import { formatDesignContext } from '../src/index.ts';
import { twoBoards } from '../../kernel/test/fixtures.ts';

// The spec in the agent's context and guide (docs/design/spec.md §7, §8).

const base = {
  summary: { name: 'x', sheets: ['Main'], pages: 1, components: [], nets: [], counts: { errors: 0, warnings: 0, infos: 0, waived: 0, drawing: 0 }, ledger: 0, waivers: 0 },
  diagnostics: [],
  ledger: [],
  selection: [],
};

const spec: SpecAnswer = {
  counts: { verified: 1, violated: 1, unverified: 1, waived: 0, assumed: 2 },
  items: [
    { id: 'q_1', text: 'A USB-C input', source: { type: 'user', quote: 'USB-C in' }, assumed: false, status: 'violated', verify: [{ kind: 'part', category: 'connector', pins: ['CC1', 'CC2'], result: 'fails', why: 'no fitted connector has pins CC1 and CC2' }] },
    { id: 'q_2', text: 'Less than 30 mV ripple', source: { type: 'user' }, assumed: false, status: 'unverified', verify: [] },
    { id: 'q_3', text: 'Two layers', source: { type: 'agent' }, assumed: true, status: 'verified', verify: [{ kind: 'measure', of: 'board.layers', max: 2, result: 'holds', why: 'board.layers is 2' }] },
    { id: 'q_4', text: '3.3 V at 500 mA', source: { type: 'agent' }, assumed: true, status: 'unverified', verify: [{ kind: 'measure', of: 'net.max_current', net: '+3V3', min: 0.5, result: 'unknown', why: 'the maximum current of +3V3 is not set' }] },
  ],
};

describe('the spec in the design context', () => {
  it('gives the counts and one line per item that is not verified', () => {
    const t = formatDesignContext({ ...base, summary: { ...base.summary, spec: spec.counts }, spec });
    const lines = t.split('\n');
    const at = lines.indexOf('spec: 4 items, 1 verified, 1 violated, 1 unverified, 2 assumed');
    expect(at).toBeGreaterThan(lines.findIndex((l) => l.startsWith('diagnostics:')));
    expect(lines.slice(at + 1, at + 4)).toEqual([
      '  q_1 violated "A USB-C input": no fitted connector has pins CC1 and CC2',
      '  q_2 unverified "Less than 30 mV ripple": nothing verifies it',
      '  q_4 unverified, assumed "3.3 V at 500 mA": the maximum current of +3V3 is not set',
    ]);
    expect(t).not.toContain('q_3');
    expect(lines[at + 4]).not.toMatch(/^  q_/);
  });

  it('names waived items too', () => {
    const waived: SpecAnswer = { counts: { verified: 0, violated: 0, unverified: 0, waived: 1, assumed: 0 }, items: [{ ...spec.items[0]!, status: 'waived' }] };
    const t = formatDesignContext({ ...base, spec: waived });
    expect(t).toContain('spec: 1 item, 0 verified, 0 violated, 0 unverified, 1 waived, 0 assumed');
    expect(t).toContain('  q_1 waived "A USB-C input": no fitted connector has pins CC1 and CC2');
  });

  it('leaves a design without a spec as it was', () => {
    const before = [
      '<design_state>',
      'name: x; sheets: Main; pages: 1',
      'components: none (empty design)',
      "diagnostics: 0 errors, 0 warnings, 0 waived, and 0 drawing findings (how the sheet reads, not what is wrong with the circuit; not in the user's Issues)",
      '</design_state>',
    ].join('\n');
    expect(formatDesignContext(base)).toBe(before);
    expect(formatDesignContext({ ...base, spec: null })).toBe(before);
  });

  it('names an item checked on the second board of two, with its status', () => {
    const k = twoBoards();
    const r = k.transact({ summary: 'spec', ops: [
      { op: 'specify', text: 'No LED on the LED board', quote: 'no LED there', verify: [{ kind: 'part', category: 'led', board: 'LED board', max: 0, min: 0 }] },
      { op: 'specify', text: 'D2 clears its neighbours', quote: 'clearances', verify: [{ kind: 'check', code: 'DRC.CLEARANCE', entities: ['D2'] }] },
      { op: 'specify', text: 'R4 is fitted', quote: 'R4', verify: [{ kind: 'part', category: 'resistor', board: 'LED board' }] },
    ] });
    expect(r.status).toBe('ok');
    k.accept();
    const s = k.state();
    const t = formatDesignContext({ summary: s.summary, diagnostics: s.diagnostics, ledger: s.ledger, spec: s.spec, selection: [] });
    expect(t).toContain(`spec: 3 items, ${s.spec!.counts.verified} verified, 1 violated, 1 unverified, 0 assumed`);
    expect(t).not.toContain('SPEC.');
    const line = (text: string) => t.split('\n').find((l) => l.includes(`"${text}"`));
    expect(line('No LED on the LED board')).toMatch(/^ {2}q_\w+ violated "No LED on the LED board": .*LED board/);
    expect(line('D2 clears its neighbours')).toMatch(/^ {2}q_\w+ unverified "D2 clears its neighbours": /);
    expect(s.spec!.items.find((x) => x.text === 'R4 is fitted')!.status).toBe('verified');
    expect(line('R4 is fitted')).toBeUndefined();
  });
});

describe('the spec in the guide', () => {
  it('tells the agent to write and check the spec, and to name a violated item in spec_open', () => {
    expect(DESIGN_GUIDE).toContain('The spec:');
    expect(DESIGN_GUIDE).toContain('design_edit specify');
    expect(DESIGN_GUIDE).toContain('Before propose, design_query get_spec. A violated item is either fixed, or named in spec_open with the reason (a later step of the plan; cannot be met because …).');
  });
});
