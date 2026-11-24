import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

// get_diagnostics on a big or badly broken design: through 0.7.x it answered with every finding at
// once, an answer that filled the agent's context, with no way to ask for one code or the next
// page. Now it pages and counts them as get_board's drc does. See docs/design/ops-api.md.

const ok = (k: Kernel, ops: unknown[]) => {
  const r = k.transact({ summary: 'test', ops });
  if (r.status !== 'ok') throw new Error(JSON.stringify(r));
};

interface Found {
  total: number;
  open: number;
  waived: number;
  matching?: number;
  listed: string;
  by_code: Record<string, { severity: string; count: number; nets?: Record<string, number>; at?: Record<string, number> }>;
  more: string;
}
type Answer = { diagnostics: Diagnostic[]; found?: Found };

/** `n` drawn tracks of +12V and GND in turn, 0.25 mm apart: too close at a clearance of 0.6 mm (as drcpage.test.ts). */
const tracks = (n: number, board?: string) =>
  Array.from({ length: n }, (_, i) => ({ op: 'draw_track', ...(board ? { board } : {}), net: i % 2 ? 'GND' : '+12V', from: [30, 2 + i * 0.45], to: [55, 2 + i * 0.45], width_mm: 0.2 }));

/** The buck with 80 tracks too close together and 10 resistors connected to nothing: about 100 findings. */
function crowded() {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  ok(k, [{ op: 'set_copper_mode', mode: 'drawn', keep: false }, { op: 'set_board', width_mm: 60, height_mm: 40 }]);
  ok(k, tracks(80));
  ok(k, [{ op: 'set_board', clearance_mm: 0.6 }]);
  ok(k, Array.from({ length: 10 }, (_, i) => ({ op: 'add_part', part: 'generic:R', refdes: `R${10 + i}`, params: { resistance: '1k' } })));
  return k;
}
const diags = (k: Kernel, args: object = {}) => k.query({ op: 'get_diagnostics', ...args }) as Answer;
const rank = (x: Diagnostic) => (x.waivedBy ? 3 : 0) + { error: 0, warning: 1, info: 2 }[x.severity];

describe('get_diagnostics with many findings', () => {
  const k = crowded();
  const all = k.diagnostics();
  const clearance = all.filter((x) => x.code === 'DRC.CLEARANCE');
  const warnings = all.filter((x) => x.severity === 'warning');

  it('lists 20, errors first, counts all by code and says the call for the next page', () => {
    expect(all.length).toBeGreaterThan(80);
    expect(warnings.length).toBeGreaterThan(0);
    const out = diags(k);
    expect(out.diagnostics).toHaveLength(20);
    expect(JSON.stringify(out).length).toBeLessThan(8000);
    // the whole list in one answer would not have been
    expect(JSON.stringify(all).length).toBeGreaterThan(8000);
    expect(out.diagnostics.every((x) => x.severity === 'error')).toBe(true);
    const f = out.found!;
    expect(f.total).toBe(all.length);
    expect(f.open + f.waived).toBe(all.length);
    expect(f.listed).toBe(`1–20 of ${all.length}`);
    expect(Object.values(f.by_code).reduce((s, c) => s + c.count, 0)).toBe(all.length);
    expect(f.by_code['DRC.CLEARANCE']).toMatchObject({ severity: 'error', count: clearance.length });
    expect(f.more).toContain(`${all.length - 20} finding(s) not listed; get_diagnostics { offset: 20 } lists the next 20`);
  });

  it('pages through every finding, errors before warnings, none twice or left out', () => {
    const seen: Diagnostic[] = [];
    for (let offset = 0; offset < all.length; offset += 30) seen.push(...diags(k, { offset, limit: 30 }).diagnostics);
    expect(seen).toHaveLength(all.length);
    expect(new Set(seen.map((x) => JSON.stringify(x))).size).toBe(new Set(all.map((x) => JSON.stringify(x))).size);
    for (let i = 1; i < seen.length; i++) expect(rank(seen[i - 1]!)).toBeLessThanOrEqual(rank(seen[i]!));
    const past = diags(k, { offset: all.length });
    expect(past.diagnostics).toEqual([]);
    expect(past.found!.listed).toBe(`none (offset ${all.length} of ${all.length})`);
  });

  it('filters by code and severity, and the next call keeps the filter', () => {
    const byCode = diags(k, { code: 'DRC.CLEARANCE', limit: 200 });
    expect(byCode.diagnostics).toHaveLength(clearance.length);
    expect(byCode.diagnostics.every((x) => x.code === 'DRC.CLEARANCE')).toBe(true);
    expect(byCode.found!.matching).toBe(clearance.length);
    expect(byCode.found!.more).toContain('0 matching finding(s) not listed');
    expect(byCode.found!.more).toContain('get_diagnostics without them lists all');
    const page2 = diags(k, { code: 'DRC.CLEARANCE', offset: 10, limit: 5 });
    expect(page2.found!.more).toContain('get_diagnostics { offset: 15, code: "DRC.CLEARANCE" } lists the next 5');
    const warn = diags(k, { severity: 'warning', limit: 200 });
    expect(warn.diagnostics).toHaveLength(warnings.length);
    expect(warn.diagnostics.every((x) => x.severity === 'warning')).toBe(true);
    // the code is exact: a prefix matches nothing
    expect(diags(k, { code: 'DRC.' }).diagnostics).toEqual([]);
  });

  it('refuses a limit out of range', () => {
    expect(k.query({ op: 'get_diagnostics', limit: 0 })).toHaveProperty('error');
    expect(k.query({ op: 'get_diagnostics', limit: 201 })).toHaveProperty('error');
    expect(k.query({ op: 'get_diagnostics', severity: 'fatal' })).toHaveProperty('error');
  });
});

describe('get_diagnostics with few findings', () => {
  it('lists them all, with no counts, the waived ones marked and last', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    k.accept();
    const all = k.diagnostics();
    expect(all.length).toBeLessThanOrEqual(20);
    const w = all.find((x) => x.severity === 'warning' || x.severity === 'info')!;
    expect(w).toBeDefined();
    ok(k, [{ op: 'add_waiver', code: w.code, entities: w.entities, reason: 'kept on purpose' }]);
    const out = diags(k);
    expect(out.found).toBeUndefined();
    expect(out.diagnostics).toHaveLength(k.diagnostics().length);
    expect(out.diagnostics.at(-1)!.waivedBy).toBeDefined();
    expect(out.diagnostics.filter((x) => x.waivedBy)).toHaveLength(k.diagnostics().filter((x) => x.waivedBy).length);
  });
});

describe('get_diagnostics on a design of several boards', () => {
  it('lists and counts the findings of every board', () => {
    const k = crowded();
    ok(k, [{ op: 'add_board', name: 'Spare' }, { op: 'assign_board', board: 'Spare', refs: ['C1'] }]);
    ok(k, [{ op: 'set_copper_mode', board: 'Spare', mode: 'drawn', keep: false }, { op: 'set_board', board: 'Spare', width_mm: 60, height_mm: 40, clearance_mm: 0.6 }]);
    ok(k, tracks(10, 'Spare'));
    const on = (board: string) => k.board({}, k.boardId(board)).diagnostics.filter((x) => x.code === 'DRC.CLEARANCE').length;
    const main = on('Main');
    const spare = on('Spare');
    expect(main).toBeGreaterThan(0);
    expect(spare).toBeGreaterThan(0);
    const out = diags(k);
    expect(out.found!.by_code['DRC.CLEARANCE']!.count).toBe(main + spare);
    expect(diags(k, { code: 'DRC.CLEARANCE', limit: 200 }).diagnostics).toHaveLength(main + spare);
  });
});
