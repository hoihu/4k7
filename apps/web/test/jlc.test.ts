import { describe, expect, it } from 'vitest';
import type { JlcPart } from '@tracewise/parts';
import { jlcTool, setJlcSource } from '../src/lib/jlc.ts';

const r10k: JlcPart = { lcsc: 'C25804', mpn: '0603WAF1002T5E', package: '0603', description: '', stock: 37165617, tier: 'basic', price: [{ qty: 1, usd: 0.0017 }], attributes: { Resistance: '10kΩ' }, url: 'https://jlcpcb.com/partdetail/C25804', datasheet: 'https://x/ds.pdf' };

describe('jlc_search tool', () => {
  it('rejects bad input and reports a parametric search as a list the agent can act on', async () => {
    const asked: unknown[] = [];
    setJlcSource({ search: async (q) => (asked.push(q), [r10k]), lookup: async () => null });
    expect((await jlcTool({ limit: 0 })).isError).toBe(true);
    const out = await jlcTool({ kind: 'resistor', value: '10k', package: '0603', basic_only: true });
    expect(asked[0]).toEqual({ kind: 'resistor', value: '10k', package: '0603', basicOnly: true, limit: 8 });
    expect(out.isError).toBe(false);
    expect(out.content).toContain('- C25804 · 0603WAF1002T5E · 0603 · Basic · stock 37,165,617 · $0.0017@1 · Resistance 10kΩ');
    expect(out.content).toContain('set_param lcsc');
    expect(out.detail).toBe('1 result(s)');
  });

  it('says so when nothing matches, and looks a number up with its datasheet', async () => {
    setJlcSource({ search: async () => [], lookup: async (id) => (id === 'C25804' ? r10k : null) });
    const none = await jlcTool({ text: 'flux capacitor' });
    expect(none.isError).toBe(false);
    expect(none.content).toMatch(/No JLCPCB parts for "flux capacitor"/);
    const hit = await jlcTool({ lcsc: 'C25804' });
    expect(hit.content).toContain('datasheet: https://x/ds.pdf');
    expect(hit.content).toContain('part page: https://jlcpcb.com/partdetail/C25804');
    expect((await jlcTool({ lcsc: 'C1' })).isError).toBe(true);
  });

  it('remembers answers for the session and turns source failures into tool errors', async () => {
    let n = 0;
    setJlcSource({ search: async () => (n++, [r10k]), lookup: async () => { throw new Error('offline'); } });
    await jlcTool({ text: 'buzzer' });
    await jlcTool({ text: 'buzzer' });
    expect(n).toBe(1);
    const err = await jlcTool({ lcsc: 'C25804' });
    expect(err).toMatchObject({ isError: true, content: 'JLCPCB search failed: offline' });
  });
});
