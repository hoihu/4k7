import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EUROCIRCUITS_ASSEMBLY, PCBWAY_ASSEMBLY, type SupplierPart } from '@4k7/schema';
import type { CostReport, StockReport, ValuesReport } from '@4k7/parts';

/** The local server's catalogue (disk is a Svelte module; the tests only need its two calls). */
const server = vi.hoisted(() => ({ search: vi.fn(), lookup: vi.fn(), quote: vi.fn() }));
vi.mock('../src/lib/disk.svelte.ts', () => ({ disk: { sourcingSearch: server.search, sourcingLookup: server.lookup, sourcingQuote: server.quote } }));

const { catalogue, setCatalogue, sourcingTool } = await import('../src/lib/sourcing.ts');

const r10k: SupplierPart = { sku: 'C25804', mpn: '0603WAF1002T5E', package: '0603', description: '', stock: 37165617, tier: 'Basic', fee: false, price: [{ qty: 1, each: 0.0017 }, { qty: 1000, each: 0.0013 }], attributes: { Resistance: '10kΩ' }, url: 'https://jlcpcb.com/partdetail/C25804', datasheet: 'https://x/ds.pdf', live: true };
const fails = () => Promise.reject(new Error('not this one'));
const noCheck = { stock: fails, cost: fails, values: fails };

/** The mirror the browser falls back to answers through fetch. */
function mirror(routes: Record<string, unknown>) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    asked.push(url);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    return { ok: !!hit, status: hit ? 200 : 404, json: async () => hit?.[1] };
  });
  return asked;
}

beforeEach(() => {
  server.search.mockReset();
  server.lookup.mockReset();
  setCatalogue();
});
afterEach(() => vi.unstubAllGlobals());

describe('sourcing tool', () => {
  it("searches the house's own catalogue through the server and lists what the agent can act on", async () => {
    server.search.mockResolvedValue([r10k]);
    expect((await sourcingTool({ action: 'search', limit: 0 }, noCheck)).isError).toBe(true);
    const out = await sourcingTool({ action: 'search', kind: 'resistor', value: '10k', package: '0603', no_fee: true }, noCheck);
    expect(server.search).toHaveBeenCalledWith('jlcpcb', { kind: 'resistor', value: '10k', package: '0603', noFee: true, limit: 8 });
    expect(out.isError).toBe(false);
    expect(out.content).toContain('1 JLCPCB part(s) for resistor 10k 0603 (Basic and Preferred first, then by stock');
    expect(out.content).toContain('- C25804 · 0603WAF1002T5E · 0603 · Basic · stock 37,165,617 · $0.0017@1 · Resistance 10kΩ');
    expect(out.content).toContain('set_param lcsc');
    expect(out.content).not.toContain('Not live');
    expect(out.detail).toBe('1 result(s)');
  });

  it("falls back to the mirror when the server cannot read the house's catalogue, and says the stock may lag", async () => {
    server.search.mockRejectedValue(new Error('jlcpcb.com answered HTTP 403'));
    const asked = mirror({ '/components/list.json': { components: [{ lcsc: 96256, mfr: 'QMB-09B-03', package: 'D9mm', description: 'Passive Buzzer', stock: 152815, is_basic: false }] } });
    const out = await sourcingTool({ action: 'search', text: 'passive buzzer' }, noCheck);
    expect(asked[0]).toBe('https://jlcsearch.tscircuit.com/components/list.json?search=passive%20buzzer');
    expect(out.content).toContain('- C96256 · QMB-09B-03 · D9mm · Extended · stock 152,815 (mirror)');
    expect(out.content).toContain("(Not live: JLCPCB's own catalogue could not be read (jlcpcb.com answered HTTP 403); these come from a mirror");
  });

  it('looks a number up with its price breaks and datasheet, and says when it is not listed', async () => {
    server.lookup.mockImplementation(async (_house: string, sku: string) => ({ part: sku === 'C25804' ? r10k : null }));
    const hit = await sourcingTool({ action: 'lookup', part: 'C25804' }, noCheck);
    expect(hit.content).toContain('price breaks (USD per piece): 1+ $0.0017, 1000+ $0.0013');
    expect(hit.content).toContain('datasheet: https://x/ds.pdf');
    expect(hit.content).toContain('part page: https://jlcpcb.com/partdetail/C25804');
    const miss = await sourcingTool({ action: 'lookup', part: 'C1' }, noCheck);
    expect(miss).toMatchObject({ isError: true, content: "C1 is not in JLCPCB's catalogue (or the number is wrong)." });
  });

  it('remembers live answers, but a mirror answer only for a minute', async () => {
    vi.useFakeTimers();
    try {
      server.lookup.mockResolvedValue({ part: r10k });
      await catalogue.lookup('C25804');
      await catalogue.lookup('c25804');
      expect(server.lookup).toHaveBeenCalledTimes(1);
      server.search.mockRejectedValue(new Error('offline'));
      mirror({ '/components/list.json': { components: [{ lcsc: 1, mfr: 'A', stock: 5 }] } });
      await catalogue.search({ text: 'a' });
      await catalogue.search({ text: 'a' });
      expect(server.search).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(61_000);
      await catalogue.search({ text: 'a' });
      expect(server.search).toHaveBeenCalledTimes(2);
      await catalogue.lookup('C25804');
      expect(server.lookup).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  const estimates = [
    { service: 'Economic', parts: 2, fees: [{ name: 'setup', amount: 8.18 }], total: 10.18 },
    { service: 'Standard', parts: 2, fees: [{ name: 'setup', amount: 25.56 }], total: 27.56 },
  ];
  const report: StockReport = { house: 'JLCPCB', boards: 25, at: '2026-10-24T12:00:00.000Z', lines: [{ sku: 'C25804', refs: ['R1'], need: 25, part: { ...r10k, stock: 0 }, state: 'out', mismatch: [], replacements: [] }], unsourced: [], live: true, unpriced: [], estimates };

  it('runs the check with the boards asked for and reports it with the order estimate; failures become tool errors', async () => {
    const asked: (number | undefined)[] = [];
    const out = await sourcingTool({ action: 'check', boards: 25 }, { stock: async (b) => (asked.push(b), report), cost: fails, values: fails });
    expect(asked).toEqual([25]);
    expect(out).toMatchObject({ isError: false, label: 'stock check · JLCPCB · 25 boards', detail: '1 part(s) stop the order' });
    expect(out.content).toContain('- R1 · C25804 0603WAF1002T5E (Basic, stock 0): out of stock (25 needed). No like-for-like replacement found');
    expect(out.content).toContain('The order: ≈ $10.18–$27.56 for 25 boards ($0.41–$1.10 a board, Economic to Standard), fees included');
    const failed = await sourcingTool({ action: 'check' }, noCheck);
    expect(failed).toMatchObject({ isError: true, content: 'JLCPCB stock check failed: not this one' });
  });

  it('runs the values check and lists the cheaper ways to make each value', async () => {
    const odd = { ...r10k, sku: 'C25967', attributes: { Resistance: '31.6kΩ' } };
    const values: ValuesReport = {
      house: 'JLCPCB', boards: 10, at: report.at, service: 'Economic', live: true, onOrder: [],
      lines: [{ refs: ['R1'], sku: 'C25967', kind: 'resistor', wanted: 31600, what: '31.6kΩ 0603', now: 3.11, options: [{ how: 'single', parts: [{ ...r10k, sku: 'C4216', attributes: { Resistance: '33kΩ' } }], value: 33000, deviation: 33000 / 31600 - 1, cost: 0.04, saves: 3.07, onOrder: false }] }],
    };
    void odd;
    const out = await sourcingTool({ action: 'values', boards: 10 }, { stock: fails, cost: fails, values: async () => values });
    expect(out).toMatchObject({ isError: false, label: 'values check · JLCPCB · 10 boards', detail: '1 value(s) cheaper, up to $3.07' });
    expect(out.content).toContain('- R1 31.6kΩ 0603 (C25967, $3.11 on the order now):\n    · one 33kΩ (+4.4%): C4216, Basic: saves $3.07');
  });

  it('runs the cost check and says the range and what could be saved', async () => {
    const cost: CostReport = {
      house: 'JLCPCB', boards: 25, at: report.at, live: true, estimates, service: 'Economic', unsourced: [], unmatched: [], unpriced: [], stock: report,
      savings: [{ kind: 'cheaper', refs: ['C3'], from: 'C1590', to: { ...r10k, sku: 'C14663' }, saves: 3.05, what: 'C3: C14663 instead of C1590 (Basic: no loading fee)' }],
      board: [],
    };
    const out = await sourcingTool({ action: 'cost', boards: 25 }, { stock: fails, cost: async () => cost, values: fails });
    expect(out).toMatchObject({ isError: false, label: 'cost check · JLCPCB · 25 boards', detail: '≈ $10.18–$27.56, up to $3.05 less' });
    expect(out.content).toContain('- C3: C14663 instead of C1590 (Basic: no loading fee): saves $3.05');
    expect(out.content).toContain('Not included: the bare boards');
  });
});

describe('sourcing at another house', () => {
  const gpr: SupplierPart = { sku: 'GPR060310K', mpn: 'GPR060310K', package: '0603', description: 'SMD Chip Resistor, 10 kohm', stock: null, supply: 'stock', tier: 'Generic', fee: false, price: [{ qty: 1, each: 0 }], attributes: { Resistance: '10kΩ' }, url: 'https://be.eurocircuits.com/shop/assembly/partdetail.aspx?mpn=GPR060310K', live: true };

  it('searches the house named, else the one the user chose, and prices in its currency', async () => {
    server.search.mockResolvedValue([gpr]);
    const named = await sourcingTool({ action: 'search', house: 'Eurocircuits', kind: 'resistor', value: '10k', package: '0603' }, noCheck);
    expect(server.search).toHaveBeenCalledWith('eurocircuits', { kind: 'resistor', value: '10k', package: '0603', limit: 8 });
    expect(named.content).toContain('1 Eurocircuits part(s) for resistor 10k 0603 (Generic and eC-stock first');
    expect(named.content).toContain('- GPR060310K · 0603 · Generic · kept in stock · free · SMD Chip Resistor, 10 kohm');
    expect(named.content).toContain('set_param eurocircuits');
    await sourcingTool({ action: 'search', text: 'buzzer' }, noCheck, EUROCIRCUITS_ASSEMBLY);
    expect(server.search).toHaveBeenLastCalledWith('eurocircuits', { text: 'buzzer', limit: 8 });
    expect(await sourcingTool({ action: 'search', house: 'acme', text: 'x' }, noCheck)).toMatchObject({ isError: true, content: 'No assembly house "acme": jlcpcb, eurocircuits, pcbway.' });
  });

  it('runs the checks for the house asked, and says at a house without a catalogue what there is to do', async () => {
    const houses: string[] = [];
    const record = (h: { id: string }) => (houses.push(h.id), Promise.reject(new Error('checked')));
    await sourcingTool({ action: 'cost', house: 'pcbway' }, { stock: (_b, h) => record(h), cost: (_b, h) => record(h), values: (_b, h) => record(h) });
    await sourcingTool({ action: 'check' }, { stock: (_b, h) => record(h), cost: fails, values: fails }, EUROCIRCUITS_ASSEMBLY);
    expect(houses).toEqual(['pcbway', 'eurocircuits']);
    const none = await sourcingTool({ action: 'lookup', part: 'AMS1117-3.3' }, noCheck, PCBWAY_ASSEMBLY);
    expect(none).toMatchObject({ isError: false, label: 'PCBWay · no catalogue' });
    expect(none.content).toMatch(/^PCBWay keeps no parts catalogue the app can read: .* run sourcing check .* and sourcing cost \(the assembly, from PCBWay's online quote\) with house "pcbway"\.$/);
    expect(server.lookup).not.toHaveBeenCalled();
  });
});
