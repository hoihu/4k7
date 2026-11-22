import { describe, expect, it } from 'vitest';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

/**
 * Parts the agent placed stay where it put them when it moves another part: a place is in board
 * coordinates, not kept relative to the part the placer guesses it belongs with (docs/design/layout.md §12).
 */
describe('parts drift when a reference part moves', () => {
  const at = (k: Kernel, ref: string) => k.board().parts.find((p) => p.refdes === ref)!;
  const spot = (k: Kernel, ref: string) => [at(k, ref).x, at(k, ref).y, at(k, ref).rot];
  const placed: Record<string, [number, number]> = { J1: [3.5, 8.3], C4: [10.6, 6.8], L1: [17.8, 5.2], R3: [19.2, 11.1] };

  function board() {
    const k = new Kernel();
    k.transact(buckTransaction());
    k.accept();
    const ops = Object.entries(placed).map(([ref, [x, y]]) => ({ op: 'place' as const, ref, x_mm: x, y_mm: y }));
    expect(k.transact({ summary: 'place', ops }).status).toBe('ok');
    return k;
  }

  it('moving U1 leaves the parts the agent placed exactly where they were', () => {
    const k = board();
    // they are guessed to belong with U1 …
    for (const ref of Object.keys(placed)) expect(at(k, ref).follows).toBe('U1');
    const before = Object.fromEntries(Object.keys(placed).map((ref) => [ref, spot(k, ref)]));
    const u1 = at(k, 'U1');
    const r = k.transact({ summary: 'u1', ops: [{ op: 'place', ref: 'U1', x_mm: u1.x, y_mm: u1.y + 2 }] });
    expect(r.status).toBe('ok');
    expect([at(k, 'U1').x, at(k, 'U1').y]).toEqual([u1.x, u1.y + 2]);
    // … but stay put, with no lock
    for (const ref of Object.keys(placed)) expect([ref, ...spot(k, ref)]).toEqual([ref, ...before[ref]!]);
    expect(k.board().parts.filter((p) => p.locked)).toEqual([]);
  });

  it('a part declared to belong with U1 (attach) and placed follows it, as asked', () => {
    const k = board();
    k.transact({ summary: 'c4', ops: [{ op: 'attach', ref: 'C4', to: 'U1' }, { op: 'place', ref: 'C4', x_mm: 10.6, y_mm: 6.8 }] });
    const c4 = at(k, 'C4');
    const u1 = at(k, 'U1');
    k.transact({ summary: 'u1', ops: [{ op: 'place', ref: 'U1', x_mm: u1.x, y_mm: u1.y + 2 }] });
    expect([at(k, 'C4').x - c4.x, at(k, 'C4').y - c4.y].map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 2]);
  });

  it('a choice saved relative to its guessed parent (before this fix) stays where it stands when the parent moves', () => {
    const k = board();
    k.accept();
    // as saved before: J1's choice kept relative to U1, with no attach
    const design = structuredClone(k.committedDesign());
    const u1 = at(k, 'U1');
    const j1 = Object.values(design.ledger).find((c) => c.kind === 'position' && design.components[c.a!]!.refdes === 'J1')!;
    const u1id = Object.values(design.components).find((c) => c.refdes === 'U1')!.id;
    Object.assign(j1, { rel: u1id, xMm: j1.xMm! - u1.x, yMm: j1.yMm! - u1.y });
    const old = new Kernel(design);
    const before = spot(old, 'J1');
    expect(at(old, 'J1').intent).toEqual({ anchor: 'U1' });
    old.transact({ summary: 'u1', ops: [{ op: 'place', ref: 'U1', x_mm: u1.x, y_mm: u1.y + 2 }] });
    expect(spot(old, 'J1')).toEqual(before);
    expect(at(old, 'J1').intent).toEqual({});
  });
});
