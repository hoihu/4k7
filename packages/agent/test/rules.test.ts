import { describe, expect, it } from 'vitest';
import { SCHEMATIC_RULES, parseSchematicRules } from '@4k7/schema';
import { Agent, ScriptedProvider, formatDesignContext, optimizePrompt, type AgentEvent, type KernelPort } from '../src/index.ts';
import type { Diagnostic, ScopeInfo } from '@4k7/schema';

const base = {
  summary: { name: 'x', sheets: ['Main'], pages: 1, components: [], nets: [], counts: { errors: 0, warnings: 0, infos: 0, waived: 0 }, ledger: 0, waivers: 0 },
  diagnostics: [],
  ledger: [],
  selection: ['R1'],
};

describe('drawing rules in the design context', () => {
  it('puts the guidance after the design state and leaves the level lines out', () => {
    const { guidance } = parseSchematicRules(SCHEMATIC_RULES);
    const t = formatDesignContext({ ...base, rules: guidance });
    const block = /<drawing_rules>\n([\s\S]*)\n<\/drawing_rules>/.exec(t);
    expect(block).not.toBeNull();
    expect(block![1]).toBe(guidance.trim());
    expect(t.indexOf('</design_state>')).toBeLessThan(t.indexOf('<drawing_rules>'));
    expect(t.indexOf('</drawing_rules>')).toBeLessThan(t.indexOf('<selection>'));
    expect(block![1]).toContain('### SCH.JOG');
    expect(block![1]).not.toMatch(/^level:/m);
  });

  it('omits the block when there are no rules', () => {
    expect(formatDesignContext(base)).not.toContain('<drawing_rules>');
    expect(formatDesignContext({ ...base, rules: '' })).not.toContain('<drawing_rules>');
    expect(formatDesignContext({ ...base, rules: '  \n' })).not.toContain('<drawing_rules>');
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
    snapshot: async () => ({ ...base, diagnostics, counts: { errors: diagnostics.filter((d) => d.severity === 'error').length, warnings: 0, infos: 0, waived: 0 } }),
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
});
