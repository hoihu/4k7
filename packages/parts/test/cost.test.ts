import { describe, expect, it } from 'vitest';
import { JLCPCB_ASSEMBLY, type BoardPad, type PartQuery, type SupplierPart } from '@4k7/schema';
import { assemblyFacts, checkCost, costReportText, estimateLine, estimateOrder, lineBuy, type AssemblyFacts, type PartSource, type SourcedComponent, type StockLine } from '../src/index.ts';

const H = JLCPCB_ASSEMBLY;
const part = (sku: string, o: Partial<SupplierPart> = {}): SupplierPart => ({ sku, mpn: 'X', package: '0603', description: '', stock: 1_000_000, tier: 'Basic', fee: false, price: [{ qty: 1, usd: 0.01 }], attributes: {}, url: '', live: true, ...o });
const ext = { tier: 'Extended', fee: true };
const line = (sku: string, refs: string[], need: number, p: SupplierPart | null): StockLine => ({ sku, refs, need, part: p, state: p ? 'ok' : 'missing', mismatch: [], replacements: [] });
const facts = (o: Partial<AssemblyFacts> = {}): AssemblyFacts => ({ smtJoints: 20, handJoints: 4, handRefs: ['J1'], bottomRefs: [], layers: 2, size: [80, 80], chips: ['0603'], ...o });

describe('what the house buys', () => {
  it('buys the need and its losses, at least the fewest it assembles from, at their price break', () => {
    expect(lineBuy(part('C1', { attrition: 10, minQty: 20 }), 20)).toEqual({ pieces: 30, usd: 30 * 0.01 });
    expect(lineBuy(part('C1', { attrition: 0, minQty: 20 }), 10)).toEqual({ pieces: 20, usd: 20 * 0.01 });
    expect(lineBuy(part('C1', { price: [{ qty: 1, usd: 1 }, { qty: 10, usd: 0.8 }] }), 10)).toEqual({ pieces: 10, usd: 8 });
    expect(lineBuy(part('C1', { price: [] }), 10)).toBeNull();
  });
});

describe('the board', () => {
  const pad = (o: Partial<BoardPad> = {}): BoardPad => ({ number: '1', x: 0, y: 0, w: 1, h: 1, shape: 'rect', layers: ['F.Cu'], ...o });
  const board = (panel?: unknown) => ({
    layers: ['F.Cu', 'B.Cu'],
    outline: { w: 50, h: 40 },
    ...(panel ? { panel } : {}),
    parts: [
      { refdes: 'R1', side: 'top' as const, pkg: '0603', pads: [pad(), pad()] },
      { refdes: 'J1', side: 'top' as const, pkg: 'PinHeader_1x02', pads: [pad({ drill: 1 }), pad({ drill: 1 }), pad({ drill: 3, npth: true })] },
      { refdes: 'C9', side: 'bottom' as const, pkg: '0402', pads: [pad(), pad()] },
      { refdes: 'U9', side: 'bottom' as const, pkg: 'SOIC-8', pads: Array.from({ length: 8 }, () => pad()) },
    ],
  });

  it('counts the joints of the parts the house assembles, by machine and by hand, and finds those on the bottom', () => {
    expect(assemblyFacts(board(), new Set(['R1', 'J1', 'C9']))).toEqual({ smtJoints: 4, handJoints: 2, handRefs: ['J1'], bottomRefs: ['C9'], layers: 2, size: [50, 40], chips: ['0603', '0402'] });
    // in a panel the board's own size does not decide
    expect(assemblyFacts(board({ w: 100 }), new Set(['R1'])).size).toBeUndefined();
  });
});

describe('the estimate', () => {
  // parts: C1 30 × $0.01 (need 20 + losses 10) + C2 20 × $0.10 (its minimum) + C3 10 × $0.80 = $10.30; C4 has no record
  const lines = [
    line('C1', ['R1', 'R2'], 20, part('C1', { attrition: 10, minQty: 20 })),
    line('C2', ['C1'], 10, part('C2', { ...ext, price: [{ qty: 1, usd: 0.1 }], minQty: 20 })),
    line('C3', ['U1'], 10, part('C3', { tier: 'Preferred', price: [{ qty: 1, usd: 1 }, { qty: 10, usd: 0.8 }] })),
    line('C4', ['R9'], 10, null),
  ];

  it("prices the order at each service with every fee: setup, stencil, loading, joints, soldering by hand", () => {
    const [eco, std] = estimateOrder(lines, facts(), 10, H);
    // 200 joints × $0.0016 = $0.32; 40 by hand × $0.0164 + $3.58 labour = $4.24
    expect(eco).toEqual({
      service: 'Economic',
      parts: 10.3,
      fees: [
        { name: 'setup', usd: 8.18 },
        { name: 'stencil', usd: 1.53 },
        { name: 'loading 1 part number × $3.07', usd: 3.07 },
        { name: '200 joints placed', usd: 0.32 },
        { name: '40 joints soldered by hand', usd: 4.24 },
      ],
      total: 27.64,
    });
    // Standard loads every part number: 3 × $1.53
    expect(std).toMatchObject({ service: 'Standard', total: 53.22, notCounted: expect.stringMatching(/packing/) });
    expect(std!.fees.slice(0, 3)).toEqual([{ name: 'setup', usd: 25.56 }, { name: 'stencil', usd: 8.21 }, { name: 'loading 3 part numbers × $1.53', usd: 4.59 }]);
    expect(estimateLine([eco!, std!], 10)).toBe('≈ $27.64–$53.22 for 10 boards ($2.76–$5.32 a board, Economic to Standard)');
  });

  it('says why a service cannot take the order: both sides, too many boards, chips too small, a board too small without a panel', () => {
    const [eco, std] = estimateOrder(lines, facts({ bottomRefs: ['C9'] }), 10, H);
    expect(eco).toMatchObject({ unavailable: 'it assembles one side only (on the bottom: C9)' });
    expect(std!.fees.slice(0, 2)).toEqual([{ name: 'setup, both sides', usd: 51.12 }, { name: 'stencils, both sides', usd: 16.42 }]);
    expect(estimateOrder(lines, facts(), 60, H)[0]).toMatchObject({ unavailable: 'it takes 2 to 50 boards an order' });
    expect(estimateOrder(lines, facts({ chips: ['0603', '0201'] }), 10, H)[0]).toMatchObject({ unavailable: 'its smallest chip is 0402 (the board has 0201)' });
    // below the smallest single board it takes the order in a panel; above the largest, not at all
    expect(estimateOrder(lines, facts({ size: [80, 60] }), 10, H)[1]).toMatchObject({ total: 53.22, needs: 'a panel (as a single board it takes 70 × 70 mm and more; this one is 80 × 60 mm)' });
    expect(estimateOrder(lines, facts({ size: undefined }), 10, H)[1]!.needs).toBeUndefined();
    expect(estimateOrder(lines, facts({ size: [480, 300] }), 10, H)[1]!.unavailable).toBeUndefined(); // turned, it fits 460 × 500
    expect(estimateOrder(lines, facts({ size: [520, 300] }), 10, H)[1]).toMatchObject({ unavailable: 'it takes boards up to 460 × 500 mm (this one is 520 × 300 mm)' });
    // one service left: no range
    expect(estimateLine(estimateOrder(lines, facts({ bottomRefs: ['C9'] }), 10, H), 10)).toMatch(/^≈ \$\d+\.\d\d for 10 boards \(\$\d+\.\d\d a board, Standard\)$/);
  });

  it('prices many joints at their tier', () => {
    const std = estimateOrder(lines, facts({ smtJoints: 600, handJoints: 0 }), 100, H)[1]!;
    expect(std.fees.find((f) => f.name.endsWith('placed'))).toEqual({ name: '60,000 joints placed', usd: 78 });
  });
});

/* ------------------------------------ the cost check ------------------------------------ */

function catalogue(parts: SupplierPart[], search: (q: PartQuery) => SupplierPart[]): PartSource {
  return { lookup: async (sku) => parts.find((p) => p.sku === sku) ?? null, search: async (q) => search(q) };
}
const r10k = (sku: string, o: Partial<SupplierPart> = {}) => part(sku, { attributes: { Resistance: '10kΩ', Tolerance: '±1%' }, ...o });
const c100n = (sku: string, o: Partial<SupplierPart> = {}) => part(sku, { attributes: { Capacitance: '100nF', 'Voltage Rated': '50V', 'Temperature Coefficient': 'X7R' }, ...o });
const res = (refdes: string, lcsc?: string): SourcedComponent => ({ refdes, category: 'resistor', params: { resistance: '10k', ...(lcsc ? { lcsc } : {}) }, pkg: '0603' });

describe('cost check', () => {
  it('finds a fee-free equivalent, one part number for parts that are the same, and what hand soldering costs', async () => {
    const parts = [r10k('C1', { price: [{ qty: 1, usd: 0.002 }] }), r10k('C2', { ...ext, price: [{ qty: 1, usd: 0.003 }] }), c100n('C3', { ...ext }), part('C5', { mpn: 'AMS1117-3.3', package: 'SOT-223', price: [{ qty: 1, usd: 0.2 }] }), part('C7', { mpn: 'HDR-2', package: 'HDR' })];
    const found = (q: PartQuery) =>
      q.kind === 'capacitor'
        ? [c100n('C3', { ...ext }), c100n('C4', { price: [{ qty: 1, usd: 0.012 }] }), c100n('C44', { price: [{ qty: 1, usd: 0.001 }], stock: 40 })]
        : q.text === 'AMS1117-3.3'
          ? [part('C6', { ...ext, mpn: 'AMS1117-3.3', package: 'SOT-223', price: [{ qty: 1, usd: 0.05 }] })]
          : [];
    const comps: SourcedComponent[] = [
      res('R1', 'C1'),
      res('R2', 'C1'),
      res('R3', 'C2'),
      { refdes: 'C1', category: 'capacitor', params: { capacitance: '100nF', voltage: '25V', lcsc: 'C3' }, pkg: '0603' },
      { refdes: 'U1', category: 'ic', params: { lcsc: 'C5' }, mpn: 'AMS1117-3.3', pkg: 'SOT-223' },
      { refdes: 'J1', category: 'connector', params: { lcsc: 'C7' }, mpn: 'HDR-2', pkg: 'HDR' },
    ];
    const r = await checkCost(comps, catalogue(parts, found), { house: H, boards: 10, facts: () => facts({ handJoints: 2, handRefs: ['J1'] }) });
    expect(r.service).toBe('Economic');
    expect(r.savings.map((s) => [s.kind, s.refs.join(' '), s.from, s.to?.sku, s.usd])).toEqual([
      // the loading fee and the labour are what count at 10 boards: $3.07 + 10 × ($0.003 − $0.002)
      ['merge', 'R3', 'C2', 'C1', 3.08],
      ['hand', 'J1', undefined, undefined, 3.91],
      ['cheaper', 'C1', 'C3', 'C4', 3.05],
    ].sort((a, b) => (b[4] as number) - (a[4] as number)));
    // the clone is cheaper a piece, but not with its loading fee at 10 boards; the cheap capacitor has too little stock
    expect(r.savings.some((s) => s.refs.includes('U1') || s.to?.sku === 'C44')).toBe(false);
    expect(r.savings.find((s) => s.kind === 'merge')!.what).toBe('R3: C1 X instead of C2 (the part R1, R2 already have: one part number less to load)');
    expect(r.savings.find((s) => s.kind === 'hand')!.what).toBe('J1 is soldered by hand: leave it off the order (no LCSC number) and solder it yourself');
  });

  it('prices moving the bottom parts up when a one-sided service would take the order', async () => {
    const { savings, service } = await checkCost([res('R1', 'C1'), res('C9', 'C1')], catalogue([r10k('C1')], () => []), { house: H, boards: 10, facts: () => facts({ bottomRefs: ['C9'], handJoints: 0, handRefs: [] }) });
    expect(service).toBe('Standard');
    const side = savings.find((s) => s.kind === 'side')!;
    // Standard on both sides: $51.12 + $16.42 + 1 × $1.53; Economic: $8.18 + $1.53
    expect(side.usd).toBe(59.36);
    expect(side.what).toBe('C9 on the top side: every part on one side, and Economic assembly takes the order');
  });

  it('matches the components without a number to parts, cheapest for the order first (fees counted), once for those that need the same part', async () => {
    const found = (q: PartQuery) =>
      q.kind === 'resistor'
        ? [r10k('C9', { ...ext, price: [{ qty: 1, usd: 0.001 }] }), r10k('C25804'), r10k('C8', { attributes: { Resistance: '10kΩ', Tolerance: '±5%' }, price: [{ qty: 1, usd: 0.02 }] })]
        : q.kind === 'capacitor'
          ? [c100n('C13585', { price: [{ qty: 1, usd: 0.24 }] }), c100n('C9807', { ...ext, price: [{ qty: 1, usd: 0.056 }] })]
          : [];
    const cap = (refdes: string): SourcedComponent => ({ refdes, category: 'capacitor', params: { capacitance: '100nF' }, pkg: '0603' });
    const comps: SourcedComponent[] = [res('R1'), res('R2'), { ...res('R3'), params: { resistance: '10k', tolerance: '1%' } }, cap('C2'), cap('C3'), { refdes: 'J1', category: 'connector', params: {} }];
    const r = await checkCost(comps, catalogue([r10k('C1')], found), { house: H, boards: 10, facts: () => facts({ handJoints: 0, handRefs: [] }) });
    expect(r.unsourced.map((g) => [g.refs, g.what, g.candidates.map((p) => p.sku), g.adds])).toEqual([
      // 20 × $0.24 = $4.80 against 20 × $0.056 + the $3.07 loading fee = $4.19: the Extended part is cheaper for the order
      [['C2', 'C3'], '100nF 0603', ['C9807', 'C13585'], { C9807: 4.19, C13585: 4.8 }],
      [['R1', 'R2'], '10k 0603', ['C25804', 'C8', 'C9'], { C25804: 0.2, C8: 0.4, C9: 3.09 }],
      // held to its 1 %: the 5 % part does not qualify
      [['R3'], '10k 0603', ['C25804', 'C9'], { C25804: 0.1, C9: 3.08 }],
    ]);
    expect(r.unmatched).toEqual(['J1']);
  });

  it('takes the deeper stock among candidates that add about the same to the order', async () => {
    const r = await checkCost([res('R1')], catalogue([], () => [r10k('C1', { stock: 900, price: [{ qty: 1, usd: 0.0014 }] }), r10k('C2', { stock: 129_674, price: [{ qty: 1, usd: 0.002 }] })]), { house: H, boards: 10, facts: () => facts({ handJoints: 0, handRefs: [] }) });
    expect(r.unsourced[0]!.candidates.map((p) => p.sku)).toEqual(['C2', 'C1']);
  });

  it('offers one way round of two lines that could share a part number', async () => {
    const r = await checkCost([res('R1', 'C1'), res('R2', 'C2')], catalogue([r10k('C1'), r10k('C2', { ...ext })], () => []), { house: H, boards: 10, facts: () => facts({ handJoints: 0, handRefs: [] }) });
    expect(r.savings.map((s) => [s.refs.join(' '), s.from, s.to?.sku])).toEqual([['R2', 'C2', 'C1']]);
  });

  it('writes the report for the agent', async () => {
    const r = await checkCost([res('R1', 'C2'), { refdes: 'J9', category: 'connector', params: {} }], catalogue([r10k('C2', { ...ext })], () => [r10k('C1')]), { house: H, boards: 10, facts: () => facts({ handJoints: 0, handRefs: [] }), now: () => new Date('2026-10-24T12:00:00Z') });
    const text = costReportText(r, H);
    expect(text).toMatch(/^Cost of 10 boards at JLCPCB \(2026-10-24 12:00 UTC, prices read just now\): ≈ \$\d+\.\d\d–\$\d+\.\d\d for 10 boards/);
    expect(text).toContain('- Economic: $');
    expect(text).toContain('+ loading 1 part number × $3.07 $3.07');
    expect(text).toContain('Not included: the bare boards (JLCPCB quotes them by size, layers and options');
    expect(text).toContain('Cheaper (counted for Economic; up to $3.07 in all');
    expect(text).toContain('- R1: C1 X instead of C2 (Basic: no loading fee): saves $3.07');
    expect(text).toContain('No LCSC number (not on the order; JLCPCB does not assemble them from its stock):\n- J9: nothing to search by');
    expect(text).toContain('To take a part: design_edit set_param lcsc on the components named.');
  });
});
