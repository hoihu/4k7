import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { draftToCard, registerUserParts, unregisterUserPart } from '@4k7/parts';
import type { Design, PartDraft, SheetView } from '@4k7/schema';
import { Kernel } from '../src/index.ts';

/** A 20-pin buck controller plus exposed pad, as imported: the generated layout puts nearly every pin on the left. */
const NAMES: [string, PartDraft['pins'][number]['type']][] = [
  ['VIN', 'pwr_in'], ['VIN', 'pwr_in'], ['UVLO', 'in'], ['RT', 'in'], ['EN', 'in'], ['RAMP', 'passive'], ['AGND', 'pwr_in'],
  ['SS', 'passive'], ['FB', 'in'], ['COMP', 'out'], ['VOUT', 'in'], ['SYNC', 'in'], ['NC', 'nc'], ['NC', 'nc'], ['PGND', 'pwr_in'],
  ['PGND', 'pwr_in'], ['SW', 'pwr_out'], ['SW', 'pwr_out'], ['BST', 'passive'], ['VCC', 'pwr_out'], ['EP', 'pwr_in'],
];
const { card: buck } = draftToCard({
  mpn: 'BUCK20TEST',
  manufacturer: 'Test',
  description: 'test buck controller',
  package: { name: 'TSSOP20-EP', family: 'TSSOP', pins: 20, pitch_mm: 0.65, body_mm: [4.4, 6.5], exposed_pad_mm: [3, 4] },
  pins: NAMES.map(([name, type], i) => ({ number: i < 20 ? String(i + 1) : 'EP', name, type })),
});
registerUserParts([buck!]);
afterAll(() => unregisterUserPart(buck!.id));

/** Where the reference drawing has the pins. */
const REFERENCE = {
  left: ['VIN', 'UVLO', 'EN', 'SYNC', 'RT', null, 'RAMP', 'SS'],
  right: ['BST', 'SW', 'VCC', null, 'VOUT', 'FB', 'COMP'],
  bottom: ['AGND', 'PGND', 'EP', ['13', '14']],
};

function withBuck(): Kernel {
  const k = new Kernel();
  const r = k.transact({
    summary: 'buck',
    ops: [
      { op: 'add_part', part: buck!.id, refdes: 'U1' },
      { op: 'add_part', part: 'generic:C', refdes: 'C1', params: { capacitance: '100nF', voltage: '25V' } },
      { op: 'connect', pins: ['U1.BST', 'C1.1'], net: 'BST' },
      { op: 'connect', pins: ['U1.SW', 'C1.2'], net: 'SW' },
      { op: 'connect', pins: ['U1.AGND', 'U1.PGND', 'U1.EP'], net: 'GND' },
      { op: 'connect', pins: ['U1.VIN'], net: 'VIN' },
    ],
  });
  expect(r.status, JSON.stringify(r).slice(0, 400)).toBe('ok');
  k.accept();
  return k;
}

const u1 = (s: SheetView) => s.symbols.find((x) => x.refdes === 'U1')!;
const sideOf = (s: SheetView, name: string) => [...new Set(u1(s).pins.filter((p) => p.name === name).map((p) => p.side))];

describe('set_symbol layout: the agent arranges a symbol\'s pins', () => {
  it('puts every pin on the side and in the order given, keeping the circuit', () => {
    const k = withBuck();
    expect(sideOf(k.state().view.sheets[0]!, 'SW')).toEqual(['left']); // generated: all down one side
    const nets = JSON.stringify(k.committedDesign().components);

    const r = k.transact({ summary: 'like the reference', ops: [{ op: 'set_symbol', ref: 'U1', layout: REFERENCE }] });
    expect(r.status, JSON.stringify(r).slice(0, 600)).toBe('ok');
    expect(r.status === 'ok' && r.results[0]!.effect).toContain('left: VIN ×2, UVLO, EN, SYNC, RT, RAMP, SS; right: BST, SW ×2, VCC, VOUT, FB, COMP; bottom: AGND, PGND ×2, EP, NC ×2');
    const p = k.proposal()!;
    expect(p.hunks.map((h) => h.title)).toEqual(['U1 symbol: pins arranged']);
    k.accept();

    const s = k.state().view.sheets[0]!;
    const sym = u1(s);
    expect(sideOf(s, 'SW')).toEqual(['right']);
    expect(sideOf(s, 'VIN')).toEqual(['left']);
    expect(sideOf(s, 'EP')).toEqual(['bottom']);
    // a shared name stacks at one position; the left side keeps the order given, with the gap
    const at = (name: string) => sym.pins.find((pin) => pin.name === name)!;
    expect(new Set(sym.pins.filter((pin) => pin.name === 'SW').map((pin) => `${pin.x},${pin.y}`)).size).toBe(1);
    expect(at('UVLO').y - at('VIN').y).toBe(100);
    expect(at('RAMP').y - at('RT').y).toBe(200);
    expect(at('BST').y).toBe(at('VIN').y);
    expect(JSON.stringify(k.committedDesign().components)).toBe(nets);
    expect(k.committedDesign().parts[buck!.id]!.customSymbol).toBe(true);

    // back to the generated arrangement
    k.transact({ summary: 'generated', ops: [{ op: 'set_symbol', ref: 'U1', layout: null }] });
    k.accept();
    expect(sideOf(k.state().view.sheets[0]!, 'SW')).toEqual(['left']);
    expect(k.committedDesign().parts[buck!.id]!.customSymbol).toBeUndefined();
  });

  it('refuses a layout that leaves out, repeats, invents or wrongly stacks pins', () => {
    const k = withBuck();
    const tryLayout = (layout: object) => JSON.stringify(k.transact({ summary: 'x', ops: [{ op: 'set_symbol', ref: 'U1', layout }] }));
    const missing = tryLayout({ ...REFERENCE, bottom: ['AGND', 'PGND', 'EP'] });
    expect(missing).toContain('SYMBOL_LAYOUT');
    expect(missing).toContain('missing 13 NC, 14 NC');
    expect(tryLayout({ ...REFERENCE, right: [...REFERENCE.right, '17'] })).toContain('pin 17 SW is given twice');
    expect(tryLayout({ ...REFERENCE, left: [...REFERENCE.left, 'BOOT'] })).toContain('no pin \\"BOOT\\"');
    expect(tryLayout({ ...REFERENCE, right: ['BST', ['SW', 'VCC'], null, 'VOUT', 'FB', 'COMP'] })).toContain('cannot share one position');
    expect(JSON.stringify(k.transact({ summary: 'x', ops: [{ op: 'set_symbol', ref: 'C1', layout: { left: ['1'], right: ['2'] } }] }))).toContain('SYMBOL_STYLE');
    expect(JSON.stringify(k.transact({ summary: 'x', ops: [{ op: 'set_symbol', ref: 'U1' }] }))).toContain('needs style');
    expect(k.proposal()).toBeNull();
  });

  it('redraws the symbol where it stood on a stored drawing; connections whose pins moved show as labels', () => {
    const k = new Kernel();
    k.load(JSON.parse(readFileSync(new URL('./tps40222.json', import.meta.url), 'utf8')) as Design);
    k.transact({ summary: 'arrange', ops: [{ op: 'place_symbol', ref: 'U1', page: 1, x: 4000, y: 4000 }] });
    k.accept();
    const before = u1(k.state().view.sheets[0]!);
    const centre = (b: typeof before.bbox): [number, number] => [b.x + b.w / 2, b.y + b.h / 2];

    const r = k.transact({ summary: 'swap sides', ops: [{ op: 'set_symbol', ref: 'U1', layout: { left: ['SW', 'BOOST'], right: ['PVIN', 'AVIN', 'FB'], bottom: ['GND'] } }] });
    expect(r.status, JSON.stringify(r).slice(0, 600)).toBe('ok');
    expect(r.status === 'ok' && r.results[0]!.effect).toContain('Redrawn where it stood');
    k.accept();
    const s = k.state().view.sheets[0]!;
    const after = u1(s);
    expect(k.committedDesign().drawing?.s_1).toBeDefined();
    expect(after.pins.find((p) => p.name === 'SW')!.side).toBe('left');
    const [bx, by] = centre(before.bbox);
    const [ax, ay] = centre(after.bbox);
    expect(Math.abs(ax - bx)).toBeLessThanOrEqual(100);
    expect(Math.abs(ay - by)).toBeLessThanOrEqual(100);
    // every connected pin of U1 still shows its net: a wire or a label at the pin
    const d = k.committedDesign();
    const comp = Object.values(d.components).find((c) => c.refdes === 'U1')!;
    for (const p of after.pins) {
      if (!comp.pins[p.number]) continue;
      const shown = s.labels.some((l) => l.x === p.x && l.y === p.y) || s.wires.some((w) => (w.pts[0] === p.x && w.pts[1] === p.y) || (w.pts.at(-2) === p.x && w.pts.at(-1) === p.y));
      expect(shown, `U1.${p.name}`).toBe(true);
    }
    expect(k.state().diagnostics.filter((x) => x.code === 'SCH.DANGLING')).toEqual([]);
  });
});
