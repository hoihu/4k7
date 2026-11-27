/**
 * get_scorecard: the design in a few numbers, the same text for the same design, never routing.
 * See docs/design/scorecard.md §5.
 */
import { describe, expect, it } from 'vitest';
import type { Scorecard } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { buck, twoBoards } from './fixtures.ts';

const card = (k: Kernel) => k.query({ op: 'get_scorecard' }) as Scorecard;

/** Route a board (the route op asks for it, the kernel routes it as the board worker would) and keep its copper. */
function route(k: Kernel, board?: string) {
  expect(k.transact({ summary: 'route', ops: [{ op: 'route', ...(board ? { board } : {}) }] }).status).toBe('ok');
  k.accept();
  const id = board ? k.boardList().find((b) => b.name === board)!.id : undefined;
  const b = k.board({}, id);
  expect(b.routing).toBe('done');
  k.keepCopper(b.newCopper!);
  return b;
}

describe('get_scorecard', () => {
  it('answers an empty design with zeros and its one empty board, not routed', () => {
    expect(card(new Kernel())).toEqual({
      findings: {},
      waived: 0,
      unknown: {},
      ledger: { hard: 0, soft: 0, violated: 0 },
      parts: { fitted: 0, dnp: 0, cards: 0 },
      power: { rails: 0, over: 0, unknown: 0, hot: { count: 0 } },
      boards: [{ id: 'b_1', name: 'Main', width_mm: 20, height_mm: 20, size_by: 'proposal', layers: 2, parts: { top: 0, bottom: 0 }, routing: 'none' }],
    });
  });

  it('counts a waived finding as waived, not open, and a violated constraint in the ledger', () => {
    const k = buck();
    const before = card(k);
    expect(before.findings.SCH).toEqual({ errors: 0, warnings: 1, infos: 0 });
    expect(before.parts).toEqual({ fitted: 12, dnp: 0, cards: 6 });
    expect(before.power).toMatchObject({ rails: 2, over: 0 });
    const w = k.transact({ summary: 'waive', ops: [{ op: 'add_waiver', code: 'SCH.JOG', entities: ['net:SW', 'L1.1', 'U1.PH'], reason: 'the SW pin sits where the symbol puts it' }] });
    expect(w.status, JSON.stringify(w.rejection)).toBe('ok');
    expect(card(k)).toMatchObject({ waived: 1, findings: {} });
    // U1 left of J1 and above it, on the buck's drawing: the layout does not get both
    const r = k.transact({
      summary: 'arrange',
      ops: [
        { op: 'constrain', kind: 'left_of', strength: 'hard', a: 'U1', b: 'J1' },
        { op: 'constrain', kind: 'above', strength: 'hard', a: 'U1', b: 'J1' },
        { op: 'constrain', kind: 'below', strength: 'soft', a: 'C1', b: 'J1' },
      ],
    });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const c = card(k);
    expect(c.ledger).toEqual({ hard: 2, soft: 1, violated: 2 });
    // the same count as the ledger the app shows
    expect(c.ledger.violated).toBe(k.state().ledger.filter((l) => l.status === 'violated').length);
    expect(c.findings.LEDGER?.errors ?? 0).toBe(k.diagnostics().filter((x) => x.code.startsWith('LEDGER.') && x.severity === 'error' && !x.waivedBy).length);
  });

  it('says what could not be judged, by code', () => {
    const k = buck();
    // a supply coming in without a voltage: the ratings on it cannot be checked
    const r = k.transact({ summary: 'input', ops: [{ op: 'add_part', part: 'generic:CONN_1x2', refdes: 'J9' }, { op: 'connect', pins: ['J9.1'], net: 'VAUX' }, { op: 'connect', pins: ['J9.2'], net: 'GND' }, { op: 'set_net', net: 'VAUX', external: true }] });
    expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
    const c = card(k);
    const open = k.diagnostics().filter((x) => !x.waivedBy);
    expect(c.unknown['SEM.VOLTAGE_UNKNOWN']).toBe(1);
    for (const [code, n] of Object.entries(c.unknown)) expect(open.filter((x) => x.code === code).length).toBe(n);
    expect(Object.keys(c.unknown)).toEqual([...Object.keys(c.unknown)].sort());
  });

  it('reads a board not routed, routed and out of date, and routes nothing itself', () => {
    const k = buck();
    const none = card(k).boards[0]!;
    expect(none.routing).toBe('none');
    expect(none.connections).toBeUndefined();
    // the route op asks for routing; until the copper is there the card has none to judge
    expect(k.transact({ summary: 'route', ops: [{ op: 'route' }] }).status).toBe('ok');
    expect(card(k).boards[0]!.routing).toBe('none');
    k.reject();

    const b = route(k);
    const done = card(k).boards[0]!;
    expect(done).toMatchObject({ routing: 'done', connections: { nets: b.stats.nets, routed: b.stats.routed, open: b.stats.unrouted }, vias: b.stats.vias });
    expect(done.track_mm).toBeCloseTo(b.stats.trackLength, 2);
    expect(done.current).toBeDefined();
    const nets = b.current!.nets;
    expect(done.current!.ok + done.current!.over + done.current!.unverified + done.current!.unknown).toBe(nets.length);
    // the routed board's own findings count, its copper shorts once (diagnostics() has them from the same copper)
    const drcErrors = b.diagnostics.filter((x) => !x.waivedBy && x.code.startsWith('DRC.') && x.severity === 'error').length;
    expect(card(k).findings.DRC?.errors ?? 0).toBe(drcErrors);

    // a part moved: the copper is for the placement before
    const r1 = b.parts.find((p) => p.refdes === 'R1')!;
    expect(k.transact({ summary: 'move', ops: [{ op: 'place', ref: 'R1', x_mm: r1.x + 2, y_mm: r1.y }] }).status).toBe('ok');
    const stale = card(k).boards[0]!;
    expect(stale.routing).toBe('stale');
    expect(stale.connections).toBeUndefined();
    expect(stale.track_mm).toBeUndefined();
    expect(stale.current).toBeUndefined();
  });

  it('scores each board of a design of several, in board order', () => {
    const k = twoBoards();
    route(k, 'LED board');
    const c = card(k);
    expect(c.boards.map((b) => [b.name, b.routing])).toEqual([['Main', 'none'], ['LED board', 'done']]);
    expect(c.boards[1]!.parts).toEqual({ top: 3, bottom: 0 });
    expect(c.boards[0]!.parts.top + c.boards[0]!.parts.bottom).toBe(13);
    expect(c.parts.fitted).toBe(16);
  });

  it('gives the same text for the same design, in another kernel too', () => {
    const k = twoBoards();
    route(k, 'LED board');
    const text = JSON.stringify(card(k));
    expect(JSON.stringify(card(k))).toBe(text);
    const again = new Kernel(JSON.parse(k.exportDesign()));
    expect(JSON.stringify(card(again))).toBe(text);
  });
});
