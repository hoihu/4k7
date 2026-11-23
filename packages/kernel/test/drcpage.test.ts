import { describe, expect, it } from 'vitest';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

// get_board with many DRC findings: in 0.7.0 a stricter clearance (0.6 mm, to find the spacing of a
// high-voltage net) made get_board list every finding after everything else, and the answer was cut
// off before the agent saw them. Now it lists a page early on, counts all of them by code, and pages
// and filters the rest. See docs/design/ops-api.md.

const ok = (k: Kernel, ops: unknown[]) => {
  const r = k.transact({ summary: 'test', ops });
  if (r.status !== 'ok') throw new Error(JSON.stringify(r));
};

interface Found {
  open: number;
  matching?: number;
  listed: string;
  by_code: Record<string, { severity: string; count: number; nets?: Record<string, number>; at?: Record<string, number> }>;
  more: string;
}
type Answer = { drc: string[]; drc_found?: Found };

/** The buck with 40 drawn tracks, +12V and GND in turn, 0.3 mm apart (0.2 mm wide, so +12V also has necks): fine at 0.15 mm, too close at 0.6 mm. */
function crowded() {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  ok(k, [{ op: 'set_copper_mode', mode: 'drawn', keep: false }, { op: 'set_board', width_mm: 60, height_mm: 40 }]);
  ok(k, Array.from({ length: 40 }, (_, i) => ({ op: 'draw_track', net: i % 2 ? 'GND' : '+12V', from: [30, 5 + i * 0.5], to: [55, 5 + i * 0.5], width_mm: 0.2 })));
  ok(k, [{ op: 'set_board', clearance_mm: 0.6 }]);
  return k;
}
const board = (k: Kernel, drc?: object) => k.query({ op: 'get_board', ...(drc ? { drc } : {}) }) as Answer;

describe('get_board with many DRC findings', () => {
  const k = crowded();
  const all = k.board().diagnostics.filter((x) => !x.waivedBy);
  const clearance = all.filter((x) => x.code === 'DRC.CLEARANCE');

  it('lists 20 early in the answer, counts all by code and says how to get the rest', () => {
    expect(clearance.length).toBeGreaterThanOrEqual(20);
    expect(all.length).toBeGreaterThan(30);
    const out = board(k);
    const text = JSON.stringify(out);
    expect(out.drc).toHaveLength(20);
    // the findings come before the parts, so an answer cut at 16000 characters still has them
    expect(text.indexOf('"drc_found"')).toBeLessThan(text.indexOf('"parts"'));
    expect(text.indexOf('"parts"')).toBeLessThan(16000);
    expect(JSON.stringify({ drc: out.drc, drc_found: out.drc_found }).length).toBeLessThan(8000);
    const f = out.drc_found!;
    expect(f.open).toBe(all.length);
    expect(f.listed).toBe(`1–20 of ${all.length}`);
    expect(Object.values(f.by_code).reduce((s, c) => s + c.count, 0)).toBe(all.length);
    expect(f.by_code['DRC.CLEARANCE']).toMatchObject({ severity: 'error', count: clearance.length, nets: { '+12V / GND': clearance.length } });
    expect(f.more).toContain(`${all.length - 20} finding(s) not listed`);
    expect(f.more).toContain('get_board drc: { offset: 20 }');
    // errors first
    expect(out.drc[0]).toMatch(/^error /);
  });

  it('pages through every finding with offset, none twice or left out', () => {
    const seen: string[] = [];
    for (let offset = 0; offset < all.length; offset += 50) seen.push(...board(k, { offset, limit: 50 }).drc);
    expect(seen).toHaveLength(all.length);
    expect(new Set(seen).size).toBe(all.length);
    const past = board(k, { offset: all.length });
    expect(past.drc).toEqual([]);
    expect(past.drc_found!.listed).toBe(`none (offset ${all.length} of ${all.length})`);
  });

  it('filters by code, net and track or part', () => {
    const byCode = board(k, { code: 'DRC.CLEARANCE', limit: 200 });
    expect(byCode.drc).toHaveLength(clearance.length);
    expect(byCode.drc.every((x) => x.includes('DRC.CLEARANCE'))).toBe(true);
    expect(byCode.drc_found!.matching).toBe(clearance.length);
    expect(byCode.drc_found!.more).toContain('0 matching finding(s) not listed');
    const t2 = board(k, { code: 'DRC.CLEARANCE', ref: 't2' });
    expect(t2.drc).toHaveLength(2);
    expect(t2.drc.every((x) => /\bt2\b/.test(x))).toBe(true);
    const gnd = board(k, { net: 'GND', limit: 200 });
    expect(gnd.drc.length).toBeGreaterThanOrEqual(clearance.length);
    expect(gnd.drc.every((x) => x.includes('GND'))).toBe(true);
    const page2 = board(k, { code: 'DRC.CLEARANCE', offset: 10, limit: 5 });
    expect(page2.drc_found!.more).toContain('get_board drc: { offset: 15, code: "DRC.CLEARANCE" } lists the next 5');
  });

  it('a board with few findings lists them all, as before', () => {
    const few = new Kernel();
    few.transact(buckTransaction());
    few.accept();
    ok(few, [{ op: 'set_copper_mode', mode: 'drawn', keep: false }]);
    const out = board(few);
    expect(out.drc.length).toBeLessThanOrEqual(20);
    expect(out.drc_found).toBeUndefined();
  });

  it('refuses a limit out of range', () => {
    expect(k.query({ op: 'get_board', drc: { limit: 0 } })).toHaveProperty('error');
  });
});
