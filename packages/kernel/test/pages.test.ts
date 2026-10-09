import { describe, expect, it } from 'vitest';
import { PAGE, type Rect, type SheetView, type Transaction } from '@tracewise/schema';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

const sheetOf = (k: Kernel): SheetView => k.state().view.sheets[0]!;
const DRAW_W = PAGE.w - 2 * PAGE.margin;
const DRAW_H = PAGE.h - 2 * PAGE.margin - PAGE.title;

/** The drawing area of a page: inside the margins, above the title strip. */
function drawArea(p: { rect: Rect }): Rect {
  return { x: p.rect.x + PAGE.margin, y: p.rect.y + PAGE.margin, w: p.rect.w - 2 * PAGE.margin, h: p.rect.h - 2 * PAGE.margin - PAGE.title };
}
const inside = (r: Rect, a: Rect) => r.x >= a.x && r.y >= a.y && r.x + r.w <= a.x + a.w && r.y + r.h <= a.y + a.h;
const pageOf = (s: SheetView, r: Rect) => s.pages.find((p) => inside(r, drawArea(p)));

/** `n` bucks (J1/U1…, J2/U2…), each a block of its own, so the sheet needs several pages. */
function bucks(n: number): Transaction {
  const base = buckTransaction();
  const ops: Transaction['ops'] = [];
  for (let i = 0; i < n; i++) {
    const re = (ref: string) => ref.replace(/^([A-Z]+)(\d+)/, (_, p, d) => `${p}${Number(d) + i * 10}`);
    const pin = (p: string) => re(p);
    for (const op of base.ops) {
      if (op.op === 'add_part') ops.push({ ...op, refdes: re(op.refdes!) });
      else if (op.op === 'connect') ops.push({ ...op, pins: op.pins.map(pin), ...(op.net ? { net: op.net === 'GND' ? 'GND' : `${op.net}_${i}` } : {}) });
      else if (op.op === 'set_net') ops.push({ ...op, net: `${op.net}_${i}` });
      else if (op.op === 'no_connect') ops.push({ ...op, pins: op.pins.map(pin) });
    }
  }
  return { summary: `${n} bucks`, ops };
}

describe('pages', () => {
  it('fits a small design on one A4 page, inside the drawing area', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    const s = sheetOf(k);
    expect(s.pages).toHaveLength(1);
    const p = s.pages[0]!;
    expect(p.number).toBe(1);
    expect(p.rect).toEqual({ x: 0, y: 0, w: PAGE.w, h: PAGE.h });
    expect(p.oversized).toBeUndefined();
    expect(p.name).toBe('U1 TPS54331DR, J1');
    for (const sym of s.symbols) expect(inside(sym.bbox, drawArea(p)), `${sym.refdes} on the page`).toBe(true);
    expect(k.summary().pages).toBe(1);
  });

  it('centres the drawing in the drawing area of its page', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    const s = sheetOf(k);
    const area = drawArea(s.pages[0]!);
    const xs = s.symbols.map((x) => x.bbox);
    const left = Math.min(...xs.map((b) => b.x)) - area.x;
    const right = area.x + area.w - Math.max(...xs.map((b) => b.x + b.w));
    const top = Math.min(...xs.map((b) => b.y)) - area.y;
    const bottom = area.y + area.h - Math.max(...xs.map((b) => b.y + b.h));
    // within a grid step or two of dead centre (wires and labels stick out past the symbols)
    expect(Math.abs(left - right)).toBeLessThan(600);
    expect(Math.abs(top - bottom)).toBeLessThan(600);
  });

  it('shows the paper of an empty sheet', () => {
    const s = sheetOf(new Kernel());
    expect(s.pages).toHaveLength(1);
    expect(s.pages[0]!.name).toBe('empty');
    expect(s.bbox.w).toBeGreaterThanOrEqual(PAGE.w);
  });

  it('flows blocks onto further pages without splitting one, and numbers them', () => {
    const k = new Kernel();
    k.transact(bucks(6));
    const s = sheetOf(k);
    expect(s.pages.length).toBeGreaterThan(1);
    expect(s.pages.map((p) => p.number)).toEqual(s.pages.map((_, i) => i + 1));
    for (const p of s.pages) {
      expect(p.rect.w).toBe(PAGE.w);
      expect(p.rect.h).toBe(PAGE.h);
      expect(p.oversized).toBeUndefined();
    }
    // every symbol lies on exactly one page, and a block (a buck and its parts) is never cut
    const where = new Map<string, number>();
    for (const sym of s.symbols) {
      const p = pageOf(s, sym.bbox);
      expect(p, `${sym.refdes} inside a page`).toBeDefined();
      where.set(sym.refdes, p!.number);
    }
    // (the input connectors form one column of their own, so they are not part of the blocks)
    for (let i = 0; i < 6; i++) {
      const parts = [...where.keys()].filter((r) => !r.startsWith('J') && Number(r.replace(/^[A-Z]+/, '')) >= i * 10 + 1 && Number(r.replace(/^[A-Z]+/, '')) <= i * 10 + 9);
      expect(parts.length).toBe(11);
      expect(new Set(parts.map((r) => where.get(r))).size, `buck ${i} on one page`).toBe(1);
    }
    // the blocks keep their order: U1 before U11 before U21…
    expect([0, 1, 2, 3, 4, 5].map((i) => where.get(`U${i * 10 + 1}`)!)).toEqual([...[0, 1, 2, 3, 4, 5].map((i) => where.get(`U${i * 10 + 1}`)!)].sort((a, b) => a - b));
    // wires stay on the page of their parts
    for (const w of s.wires) {
      const pages = new Set<number>();
      for (let i = 0; i < w.pts.length; i += 2) pages.add(s.pages.find((p) => inside({ x: w.pts[i]!, y: w.pts[i + 1]!, w: 0, h: 0 }, p.rect))!.number);
      expect(pages.size).toBe(1);
    }
    // pages are named after the blocks on them and sit in a near-square grid with a gap,
    // read left to right and top to bottom
    expect(s.pages[0]!.name).toMatch(/^U1 TPS54331DR, /);
    expect(s.pages[1]!.rect.x).toBeGreaterThan(PAGE.w);
    const cols = Math.ceil(Math.sqrt(s.pages.length));
    s.pages.forEach((p, i) => {
      expect(p.rect.x).toBe((i % cols) * (PAGE.w + 600));
      expect(p.rect.y).toBe(Math.floor(i / cols) * (PAGE.h + 600));
    });
    if (s.pages.length > 2) expect(s.bbox.h).toBeGreaterThan(PAGE.h);
    expect(k.summary().pages).toBe(s.pages.length);
  });

  it('wraps a row that is wider than the page instead of running off it', () => {
    const k = new Kernel();
    const tx = bucks(4);
    // all four regulators on one row
    tx.ops.push({ op: 'constrain', kind: 'left_of', strength: 'hard', a: 'U1', b: 'U11' }, { op: 'constrain', kind: 'left_of', strength: 'hard', a: 'U11', b: 'U21' }, { op: 'constrain', kind: 'left_of', strength: 'hard', a: 'U21', b: 'U31' });
    k.transact(tx);
    const s = sheetOf(k);
    for (const sym of s.symbols) expect(pageOf(s, sym.bbox), `${sym.refdes} inside a page`).toBeDefined();
    expect(Math.max(...s.symbols.map((x) => x.bbox.x + x.bbox.w)) - Math.min(...s.symbols.map((x) => x.bbox.x))).toBeLessThanOrEqual(s.pages.length * (PAGE.w + 600));
    for (const p of s.pages) expect(p.rect.w).toBe(PAGE.w);
    expect(DRAW_W).toBeGreaterThan(0);
    expect(DRAW_H).toBeGreaterThan(0);
  });

  it('judges a placement constraint across pages by page order', () => {
    const k = new Kernel();
    const tx = bucks(6);
    // U51 gets the first row and U1 a row of its own after everything else: U1 lands on a later page
    tx.ops.push({ op: 'constrain', kind: 'above', strength: 'hard', a: 'U51', b: 'U1' }, { op: 'constrain', kind: 'left_of', strength: 'hard', a: 'U1', b: 'U51' });
    k.transact(tx);
    const st = k.state();
    const s = st.view.sheets[0]!;
    expect(s.symbols).toHaveLength(6 * 12);
    const page = (r: string) => pageOf(s, s.symbols.find((x) => x.refdes === r)!.bbox)!.number;
    expect(page('U51')).toBeLessThan(page('U1'));
    const by = (a: string, b: string, kind: string) => st.ledger.find((l) => l.text === `${kind}(${a}, ${b})`)!.status;
    expect(by('U51', 'U1', 'above')).toBe('ok');
    expect(by('U1', 'U51', 'left_of')).toBe('violated');
  });
});
