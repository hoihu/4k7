/**
 * Rooms: a functional block keeps its parts inside a rectangle of the board (constrain kind room).
 * See docs/design/layout.md §14.
 */
import { describe, expect, it } from 'vitest';
import type { BoardPart, BoardView } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

const ROOM = { x: 2, y: 2, w: 12, h: 8 };

/** The buck on a 40 × 30 mm board, its feedback divider and compensation as one block. */
function buck() {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  const r = k.transact({
    summary: 'blocks',
    ops: [
      { op: 'set_board', width_mm: 40, height_mm: 30 },
      {
        op: 'describe',
        blocks: [
          { title: 'Regulator', refs: ['J1', 'U1', 'C1', 'C2', 'C3', 'C4', 'L1', 'D1'] },
          { title: 'Feedback', refs: ['R1', 'R2', 'R3', 'C5'] },
        ],
      },
    ],
  } as never);
  expect(r.rejection).toBeUndefined();
  return k;
}

const FEEDBACK = ['R1', 'R2', 'R3', 'C5'];
const part = (b: BoardView, ref: string): BoardPart => b.parts.find((p) => p.refdes === ref)!;
const inside = (p: BoardPart, r = ROOM) => {
  const c = p.courtyard;
  return c.x >= r.x - 1e-6 && c.y >= r.y - 1e-6 && c.x + c.w <= r.x + r.w + 1e-6 && c.y + c.h <= r.y + r.h + 1e-6;
};
const room = (rect = ROOM, block = 'Feedback') => ({ op: 'constrain', kind: 'room', block, rect }) as never;
const where = (b: BoardView) => b.parts.map((p) => `${p.refdes}@${p.x},${p.y},${p.rot}`).join(' ');

describe('rooms (constrain kind room)', () => {
  it('keeps every part of the block inside its room, courtyards included', () => {
    const k = buck();
    const r = k.transact({ summary: 'room', ops: [room(), { op: 'propose_placement' }] } as never);
    expect(r.rejection).toBeUndefined();
    expect(r.results[0]!.effect).toMatch(/room\("Feedback"\)/);
    const b = k.board();
    for (const ref of FEEDBACK) expect(inside(part(b, ref)), ref).toBe(true);
    expect(b.diagnostics.filter((x) => x.code === 'DRC.ROOM')).toEqual([]);
    expect(b.diagnostics.filter((x) => x.severity === 'error' && x.code !== 'DRC.UNROUTED' && x.code !== 'DRC.ROUTING_INCOMPLETE')).toEqual([]);
  });

  it('moves the block into its room on a placed board; the parts outside the block stay where they were', () => {
    const k = buck();
    const before = k.board();
    const r = k.transact({ summary: 'room', ops: [room()] } as never);
    expect(r.rejection).toBeUndefined();
    const b = k.board();
    for (const ref of FEEDBACK) expect(inside(part(b, ref)), ref).toBe(true);
    // the regulator's parts stay exactly where they were
    for (const p of before.parts.filter((x) => !FEEDBACK.includes(x.refdes))) expect([part(b, p.refdes).x, part(b, p.refdes).y], p.refdes).toEqual([p.x, p.y]);
  });

  it('removing the room frees the block: placed afresh as if there had never been one', () => {
    const plain = buck();
    plain.transact({ summary: 'again', ops: [{ op: 'propose_placement' }] } as never);
    const k = buck();
    const r = k.transact({ summary: 'room', ops: [room()] } as never);
    const id = r.results[0]!.ids![0]!;
    k.transact({ summary: 'free', ops: [{ op: 'remove_constraint', id }, { op: 'propose_placement' }] } as never);
    expect(where(k.board())).toBe(where(plain.board()));
  });

  it('a new room for the block replaces the old one', () => {
    const k = buck();
    k.transact({ summary: 'room', ops: [room()] } as never);
    const other = { x: 24, y: 18, w: 14, h: 10 };
    const r = k.transact({ summary: 'move it', ops: [room(other), { op: 'propose_placement' }] } as never);
    expect(r.results[0]!.effect).toMatch(/replaces/);
    expect(Object.values(k.draftDesign().ledger).filter((c) => c.kind === 'room')).toHaveLength(1);
    const b = k.board();
    for (const ref of FEEDBACK) expect(inside(part(b, ref), other), ref).toBe(true);
  });

  it('a room too small for its parts: no crash, the placer does its best and DRC.ROOM names the block and the parts left out', () => {
    const k = buck();
    const tiny = { x: 2, y: 2, w: 3, h: 3 };
    const r = k.transact({ summary: 'room', ops: [room(tiny), { op: 'propose_placement' }] } as never);
    expect(r.rejection).toBeUndefined();
    const b = k.board();
    const w = b.diagnostics.filter((x) => x.code === 'DRC.ROOM');
    expect(w).toHaveLength(1);
    expect(w[0]!.severity).toBe('warning');
    expect(w[0]!.message).toMatch(/Feedback/);
    const out = FEEDBACK.filter((ref) => !inside(part(b, ref), tiny));
    expect(out.length).toBeGreaterThan(0);
    expect([...w[0]!.entities!].sort()).toEqual(out.sort());
    for (const ref of out) expect(w[0]!.message).toContain(ref);
    // the parts that did not fit stand somewhere clear of the others
    expect(b.diagnostics.filter((x) => x.code === 'DRC.COURTYARD_OVERLAP')).toEqual([]);
    // and stay there: a later change elsewhere does not shuffle them
    k.transact({ summary: 'note', ops: [{ op: 'constrain', kind: 'note', value: 'feedback by the FB pin' }] } as never);
    expect(where(k.board())).toBe(where(b));
  });

  it('refuses an unknown block, a missing rect, and a design without blocks', () => {
    const k = buck();
    const r = k.transact({ summary: 'room', ops: [room(ROOM, 'Feedbak')] } as never);
    expect(r.rejection?.code).toBe('REF_UNKNOWN');
    expect(r.rejection?.message).toMatch(/no block "Feedbak"/);
    expect(r.rejection?.candidates).toContain('Feedback');
    const r2 = k.transact({ summary: 'room', ops: [{ op: 'constrain', kind: 'room', block: 'Feedback' }] } as never);
    expect(r2.rejection?.code).toBe('CONSTRAINT_INVALID');
    const bare = new Kernel();
    bare.transact(buckTransaction());
    const r3 = bare.transact({ summary: 'room', ops: [room()] } as never);
    expect(r3.rejection?.message).toMatch(/no functional blocks yet/);
  });
});
