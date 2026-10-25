import { describe, expect, it } from 'vitest';
import { PCBWAY_QUOTE, pcbwayQuoteForm, pcbwaySource, quoteOf } from '../src/index.ts';

const ORDER = { boards: 10, sides: 2 as const, uniqueParts: 20, smdParts: 100, largeParts: 2, thParts: 10 };

describe('PCBWay quote', () => {
  it("fills its quote form: turnkey, single boards, the sides, the boards and the parts", () => {
    expect(Object.fromEntries(pcbwayQuoteForm(ORDER))).toEqual({
      pagetype: '3',
      partVias: '1',
      boardType: '1',
      hidAssemblySide: '5',
      txtBoardNum: '10',
      txtICType: '20',
      txtPadsNum: '100',
      txtBGA: '2',
      txtHolesNum: '10',
    });
    expect(pcbwayQuoteForm({ ...ORDER, sides: 1 }).get('hidAssemblySide')).toBe('3');
  });

  it('reads the price it charges, the price before its special price, and the lead time', () => {
    // as pcbway.com answered on 2026-10-25 (10 boards, 5 unique parts …)
    expect(quoteOf([{ OrderType: 3, Data: '5-6 days', Price: '29.00', PriceOriginal: '107.26', CurrencySymbol: '$', ListQty: [10, 20, 50, 200], IsSmtTejia: true }])).toEqual({ price: 29, list: 107.26, days: '5-6 days' });
    expect(quoteOf([{ Data: '5-6 days', Price: '177.50', PriceOriginal: '177.50', CurrencySymbol: '$' }])).toEqual({ price: 177.5, days: '5-6 days' });
    for (const bad of [null, [], [{ Price: 'x', CurrencySymbol: '$' }], [{ Price: '10', CurrencySymbol: '€' }], { Price: '10' }]) expect(() => quoteOf(bad)).toThrow(/does not read/);
  });

  it('posts the form to its quote, and has no catalogue to search', async () => {
    const asked: { url: string; body: string; headers: Record<string, string> }[] = [];
    const src = pcbwaySource(async (url, init) => {
      asked.push({ url, body: init.body, headers: init.headers });
      return { ok: true, status: 200, json: async () => [{ Price: '88.00', PriceOriginal: '112.33', CurrencySymbol: '$', Data: '5-6 days' }] };
    });
    expect(await src.quote!(ORDER)).toEqual({ price: 88, list: 112.33, days: '5-6 days' });
    expect(asked[0]!.url).toBe(`https://www.pcbway.com${PCBWAY_QUOTE}`);
    expect(asked[0]!.headers).toMatchObject({ 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' });
    expect(asked[0]!.body).toContain('txtBoardNum=10');
    await expect(src.search({ text: 'buzzer' })).rejects.toThrow(/no parts catalogue/);
    await expect(src.lookup('AMS1117')).rejects.toThrow(/no parts catalogue/);
    const down = pcbwaySource(async () => ({ ok: false, status: 502, json: async () => null }));
    await expect(down.quote!(ORDER)).rejects.toThrow('pcbway.com answered HTTP 502');
  });
});
