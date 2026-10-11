import { describe, expect, it } from 'vitest';
import { Kernel } from '@tracewise/kernel';
import { MCP_INSTRUCTIONS, DESIGN_GUIDE, agentTools } from '@tracewise/schema';
import { Agent, DEMO_FALLBACK, DEMO_SCRIPTS, SYSTEM_PROMPT, ScriptedProvider, runCalc, nearestE, type AgentEvent, type KernelPort, type Script } from '../src/index.ts';

function port(k: Kernel): KernelPort {
  return {
    transact: async (tx) => k.transact(tx),
    query: async (q) => k.query(q),
    snapshot: async () => {
      const s = k.state();
      return { summary: s.summary, diagnostics: s.diagnostics, counts: s.counts, ledger: s.ledger };
    },
  };
}

async function turn(agent: Agent, text: string, selection: string[] = []) {
  const events: AgentEvent[] = [];
  await agent.run(text, { selection }, (e) => events.push(e));
  return events;
}

describe('agent loop (offline demo)', () => {
  it('asks, builds, gets caught by verification, fixes, and ends clean', async () => {
    const k = new Kernel();
    const agent = new Agent({ provider: new ScriptedProvider(DEMO_SCRIPTS, { fallback: DEMO_FALLBACK }), kernel: port(k) });

    const first = await turn(agent, '12 V to 3.3 V buck, 2 A. Put C1 left of U1.');
    const q = first.find((e) => e.type === 'question');
    expect(q).toMatchObject({ type: 'question' });
    expect(first.at(-1)).toMatchObject({ type: 'done', reason: 'question' });

    const second = await turn(agent, '6×6 mm, 3.2 A (recommended)');
    const verify = second.find((e) => e.type === 'verify');
    expect(verify, 'verification loop should catch the missing BOOT cap').toBeTruthy();
    expect((verify as { message: string }).message).toContain('U1.BOOT');
    expect(second.at(-1)).toMatchObject({ type: 'done', reason: 'complete' });
    expect((second.at(-1) as { message?: string }).message).toBeUndefined();

    const s = k.state();
    expect(s.counts.errors).toBe(0);
    expect(s.proposal?.hunks.length).toBeGreaterThan(10);
    expect(s.ledger.map((l) => l.text)).toContain('left_of(C1, U1)');
    expect(s.ledger[0]?.status).toBe('ok');
  });

  it('keeps the tool_use / tool_result pairing valid for replay', async () => {
    const k = new Kernel();
    const agent = new Agent({ provider: new ScriptedProvider(DEMO_SCRIPTS), kernel: port(k) });
    await turn(agent, '12V to 3.3V buck');
    await turn(agent, '6x6');
    const msgs = agent.messages;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]!;
      if (m.role !== 'assistant') continue;
      const uses = m.content.filter((b) => b.type === 'tool_use').map((b) => (b as { id: string }).id);
      if (!uses.length) continue;
      const next = msgs[i + 1]!;
      expect(next.role).toBe('user');
      const results = next.content.filter((b) => b.type === 'tool_result').map((b) => (b as { tool_use_id: string }).tool_use_id);
      expect(results.sort()).toEqual(uses.sort());
    }
  });

  it('records a value hint as a hard ledger entry', async () => {
    const k = new Kernel();
    const agent = new Agent({ provider: new ScriptedProvider(DEMO_SCRIPTS), kernel: port(k) });
    await turn(agent, '12V to 3.3V buck');
    await turn(agent, '6x6');
    k.accept();
    await turn(agent, 'make C2 100uF');
    const s = k.state();
    expect(s.summary.components.find((c) => c.refdes === 'C2')?.value).toBe('100uF 10V');
    expect(s.ledger.find((l) => l.text === 'C2.capacitance = 100uF')?.strength).toBe('hard');
  });

  it('gives up after the fix budget and reports remaining errors', async () => {
    const stubborn: Script = {
      name: 'stubborn',
      match: /./,
      steps: [
        [{ type: 'tool_use', id: '', name: 'design_edit', input: { summary: 'ic', ops: [{ op: 'add_part', part: 'ti:NE555DR' }] } }],
        ...Array.from({ length: 10 }, () => [{ type: 'text' as const, text: 'Done.' }]),
      ],
    };
    const agent = new Agent({ provider: new ScriptedProvider([stubborn]), kernel: port(new Kernel()), fixBudget: 2 });
    const ev = await turn(agent, 'add a 555');
    expect(ev.filter((e) => e.type === 'verify')).toHaveLength(2);
    expect(ev.at(-1)).toMatchObject({ type: 'done', reason: 'complete' });
    expect((ev.at(-1) as { message: string }).message).toMatch(/error\(s\) remain/);
  });

  it('closes dangling tool calls on abort', async () => {
    const ctrl = new AbortController();
    const script: Script = { name: 'x', match: /./, steps: [[{ type: 'tool_use', id: '', name: 'design_query', input: { op: 'get_summary' } }]] };
    const agent = new Agent({ provider: new ScriptedProvider([script]), kernel: port(new Kernel()) });
    const events: AgentEvent[] = [];
    const p = agent.run('hi', { selection: [] }, (e) => {
      events.push(e);
    }, ctrl.signal);
    ctrl.abort();
    await p;
    const last = agent.messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'aborted' });
  });
});

describe('one agent, two engines', () => {
  it('gives the in-app agent and Claude Code the same design tools and guide', () => {
    const names = (e: 'app' | 'chat' | 'cli') => agentTools(e).map((t) => t.name);
    const design = ['design_query', 'design_edit', 'calc', 'import_part', 'jlc_search', 'pending_import', 'artwork', 'read_datasheet', 'get_schematic_image'];
    expect(names('app')).toEqual([...design, 'ask_user']);
    expect(names('chat')).toEqual(['get_context', ...design, 'propose']);
    expect(names('cli')).toEqual(['get_context', ...design, 'propose', 'wait_for_review']);
    expect(SYSTEM_PROMPT).toContain(DESIGN_GUIDE);
    expect(MCP_INSTRUCTIONS).toContain(DESIGN_GUIDE);
  });

  it('runs tools through the executor it is given, pictures included', async () => {
    const script: Script = {
      name: 'look',
      match: /./,
      steps: [[{ type: 'tool_use', id: '', name: 'get_schematic_image', input: {} }], [{ type: 'text', text: 'Looks fine.' }]],
    };
    const calls: string[] = [];
    const agent = new Agent({
      provider: new ScriptedProvider([script]),
      kernel: port(new Kernel()),
      exec: async (name) => {
        calls.push(name);
        return { content: '', images: [{ data: 'iVBOR', mimeType: 'image/png' }], isError: false, label: 'schematic image', detail: '1400px' };
      },
    });
    const ev = await turn(agent, 'look at it');
    expect(calls).toEqual(['get_schematic_image']);
    expect(ev).toContainEqual(expect.objectContaining({ type: 'tool', label: 'schematic image', ok: true }));
    const result = agent.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result');
    expect(result).toMatchObject({ images: [{ data: 'iVBOR', mimeType: 'image/png' }] });
  });
});

describe('calc', () => {
  it('divider finds the optimal E96 pair', () => {
    // 3.3/0.8 − 1 = 3.125 sits exactly between two E96 ratio steps; 35.7k/11.5k (−0.5 %) is the
    // best achievable pair (verified by brute force over all E96 values).
    const r = runCalc({ fn: 'divider', args: { vout: 3.3, vref: 0.8 } });
    expect([r.r_top, r.r_bottom]).toEqual(['35.7k', '11.5k']);
    expect(Number(r.error_pct)).toBeLessThan(0.51);
    const five = runCalc({ fn: 'divider', args: { vout: 5, vref: 0.8 } });
    expect(Math.abs(Number(five.vout_actual) - 5)).toBeLessThan(0.01);
  });

  it('buck inductor rounds up to a standard value', () => {
    const r = runCalc({ fn: 'buck', args: { vin: 12, vout: 3.3, iout: 2, fsw: '570kHz' } });
    expect(r.l_suggested).toBe('10µH');
    expect(r.duty).toBeCloseTo(0.275, 3);
  });

  it('nearest E-series values', () => {
    expect(nearestE(4.6e3, 'E12')).toBe(4700);
    expect(nearestE(101, 'E24', 'up')).toBe(110);
    expect(runCalc({ fn: 'led_resistor', args: { vsupply: 5, vf: 2, i: '10mA' } }).r).toBe('300Ω');
  });

  it('every IEC series, and the design series as the default', () => {
    expect(nearestE(3.4e3, 'E3')).toBe(4700);
    expect(nearestE(1.22e3, 'E48')).toBe(1210);
    expect(nearestE(9.25e3, 'E192')).toBe(9200);
    expect(() => nearestE(1, 'E7')).toThrow(/E3, E6, E12, E24, E48, E96, E192/);
    // the design's resistor series replaces each calculator's own default; an explicit series wins
    const divider = runCalc({ fn: 'divider', args: { vout: 3.3, vref: 0.8 } }, { resistor: 'E12' });
    expect(divider.series).toBe('E12');
    expect(nearestE(Number(String(divider.r_top).replace('k', 'e3')), 'E12')).toBe(Number(String(divider.r_top).replace('k', 'e3')));
    expect(runCalc({ fn: 'led_resistor', args: { vsupply: 5, vf: 2, i: '10mA' } }, { resistor: 'E6' }).r).toBe('330Ω');
    expect(runCalc({ fn: 'rc', args: { r: '10k', f: '1kHz' } }, { capacitor: 'E6' }).c).toBe('15nF');
    expect(runCalc({ fn: 'nearest_e', args: { value: 5300, kind: 'resistor' } }, { resistor: 'E12' }).value).toBe('5.6k');
    expect(runCalc({ fn: 'nearest_e', args: { value: 5300, kind: 'resistor', series: 'E24' } }, { resistor: 'E12' }).value).toBe('5.1k');
    expect(runCalc({ fn: 'nearest_e', args: { value: 5300, kind: 'resistor', round: 'down' } }, { resistor: 'E6' }).value).toBe('4.7k');
  });
});
