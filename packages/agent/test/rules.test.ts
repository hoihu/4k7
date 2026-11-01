import { describe, expect, it } from 'vitest';
import { Agent, ScriptedProvider, formatDesignContext, optimizePrompt, type AgentEvent, type KernelPort } from '../src/index.ts';
import type { Diagnostic, ScopeInfo } from '@4k7/schema';

const base = {
  summary: { name: 'x', sheets: ['Main'], pages: 1, components: [], nets: [], counts: { errors: 0, warnings: 0, infos: 0, waived: 0, drawing: 0 }, ledger: 0, waivers: 0 },
  diagnostics: [],
  ledger: [],
  selection: ['R1'],
};

describe('schematic notes in the design context', () => {
  it('puts the user\'s notes after the design state', () => {
    const notes = 'Labels are always horizontal.\nDraw the feedback divider as wires.\n';
    const t = formatDesignContext({ ...base, rules: notes });
    const block = /<schematic_notes>\n([\s\S]*)\n<\/schematic_notes>/.exec(t);
    expect(block).not.toBeNull();
    expect(block![1]).toBe(notes.trim());
    expect(t.indexOf('</design_state>')).toBeLessThan(t.indexOf('<schematic_notes>'));
    expect(t.indexOf('</schematic_notes>')).toBeLessThan(t.indexOf('<selection>'));
  });

  it('lists the issues before the findings on the drawing, and says how many there are of each', () => {
    const drawn = Array.from({ length: 20 }, (_, i): Diagnostic => ({ code: 'SCH.JOG', severity: 'warning', entities: [`R${i}`], message: 'the wire jogs' }));
    const issue: Diagnostic = { code: 'ERC.IO_UNUSED', severity: 'info', entities: ['U3'], message: '23 I/O pins unused' };
    const t = formatDesignContext({ ...base, summary: { ...base.summary, counts: { errors: 0, warnings: 0, infos: 1, waived: 0, drawing: 20 } }, diagnostics: [...drawn, issue] });
    expect(t).toContain('diagnostics: 0 errors, 0 warnings, 0 waived, and 20 drawing findings');
    expect(t).toContain("not in the user's Issues");
    expect(t).toContain('INFO ERC.IO_UNUSED U3');
    expect(t.indexOf('ERC.IO_UNUSED')).toBeLessThan(t.indexOf('SCH.JOG'));
    expect(t).toContain('… 6 more');
  });

  it('omits the block when there are no notes', () => {
    expect(formatDesignContext(base)).not.toContain('<schematic_notes>');
    expect(formatDesignContext({ ...base, rules: '' })).not.toContain('<schematic_notes>');
    expect(formatDesignContext({ ...base, rules: '  \n' })).not.toContain('<schematic_notes>');
  });

  it('puts the user\'s layout notes after the schematic notes', () => {
    const t = formatDesignContext({ ...base, rules: 'Labels horizontal.', layoutRules: '+3V3 plane under the MCU.\n' });
    expect(/<layout_notes>\n([\s\S]*)\n<\/layout_notes>/.exec(t)?.[1]).toBe('+3V3 plane under the MCU.');
    expect(t.indexOf('</schematic_notes>')).toBeLessThan(t.indexOf('<layout_notes>'));
    expect(formatDesignContext({ ...base, layoutRules: ' ' })).not.toContain('<layout_notes>');
  });

  it('puts the user\'s enclosure notes after the layout notes', () => {
    const t = formatDesignContext({ ...base, layoutRules: 'GND on B.Cu.', enclosureRules: 'PETG, 0.25 mm per side fits.\n' });
    expect(/<enclosure_notes>\n([\s\S]*)\n<\/enclosure_notes>/.exec(t)?.[1]).toBe('PETG, 0.25 mm per side fits.');
    expect(t.indexOf('</layout_notes>')).toBeLessThan(t.indexOf('<enclosure_notes>'));
    expect(formatDesignContext({ ...base, enclosureRules: ' ' })).not.toContain('<enclosure_notes>');
  });

  it('tells Optimize to fix the SCH diagnostics first', () => {
    const info: ScopeInfo = {
      scope: { view: 'schematic', sheet: 's_1', rect: { x: 0, y: 0, w: 1000, h: 1000 } },
      sheetName: 'Main',
      free: ['R1'],
      anchored: [],
      context: 1,
      boundaryNets: [],
      measures: { crossings: 0, bends: 0, jogs: 0, detours: 0, overlaps: 0, wireIn: 0, labels: 0 },
    };
    expect(optimizePrompt(info)).toContain('SCH.* diagnostics inside the area are the first things to fix');
  });
});

describe('drawing rules in the loop', () => {
  /** A kernel that reports the given diagnostics whatever the model does. */
  const stub = (diagnostics: Diagnostic[]): KernelPort => ({
    transact: async () => ({ status: 'ok', applied: 0, introduced: [], resolved: [] }) as never,
    query: async () => ({}),
    snapshot: async () => ({ ...base, diagnostics, counts: { errors: diagnostics.filter((d) => d.severity === 'error').length, warnings: 0, infos: 0, waived: 0, drawing: 0 } }),
  });
  const done = { name: 'done', match: /./, steps: Array.from({ length: 6 }, () => [{ type: 'text' as const, text: 'Done.' }]) };
  const run = async (kernel: KernelPort) => {
    const ev: AgentEvent[] = [];
    await new Agent({ provider: new ScriptedProvider([done]), kernel, fixBudget: 3 }).run('tidy up', { selection: [] }, (e) => ev.push(e));
    return ev;
  };

  it('spends no fix round on a drawing rule the layout itself breaks', async () => {
    const ev = await run(stub([{ code: 'SCH.RAIL_UP', severity: 'error', entities: ['net:VIN', 'U1.PVIN'], message: 'VIN on U1.PVIN points down' }]));
    expect(ev.filter((e) => e.type === 'verify')).toHaveLength(0);
    expect(ev.at(-1)).toEqual({ type: 'done', reason: 'complete' });
  });

  it('still verifies a drawing rule the agent has a lever on, when the user made it an error', async () => {
    const ev = await run(stub([{ code: 'SCH.JOG', severity: 'error', entities: ['net:FB', 'R1.2', 'R2.1'], message: 'R1 and R2 face each other on FB but are not in line: the wire jogs' }]));
    expect(ev.filter((e) => e.type === 'verify')).toHaveLength(3);
    expect((ev.at(-1) as { message: string }).message).toMatch(/1 error\(s\) remain/);
  });

  it('reviews the drawing warnings a turn brought once, then finishes', async () => {
    let calls = 0;
    const hanging: Diagnostic = { code: 'SCH.RAIL_SIDE', severity: 'warning', entities: ['R10', 'net:QSPI_SS'], message: "R10 has +3V3 at its bottom: a pull-up stands above QSPI_SS's wire", fixHints: [{ op: 'constrain', kind: 'arrangement', a: 'R10', value: 'up', strength: 'soft' }] };
    // none at the start of the turn, the warning after the agent's work
    const kernel: KernelPort = { ...stub([]), snapshot: async () => ({ ...base, diagnostics: calls++ ? [hanging] : [], counts: { errors: 0, warnings: calls > 1 ? 1 : 0, infos: 0, waived: 0, drawing: 0 } }) };
    const ev = await run(kernel);
    const reviews = ev.filter((e) => e.type === 'verify');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ review: true, errors: 1 });
    expect((reviews[0] as { message: string }).message).toContain('"value":"up"');
    expect(ev.at(-1)).toEqual({ type: 'done', reason: 'complete' });
  });

  it('does not review drawing warnings that were there before the turn', async () => {
    const ev = await run(stub([{ code: 'SCH.JOG', severity: 'warning', entities: ['net:FB', 'R1.2', 'R2.1'], message: 'the wire jogs' }]));
    expect(ev.filter((e) => e.type === 'verify')).toHaveLength(0);
  });
});
