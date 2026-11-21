import { describe, expect, it } from 'vitest';
import { Kernel } from '@4k7/kernel';
import { bom, bomLines, fabFiles, pickAndPlace } from '../src/index.ts';
import { boardBodies } from '@4k7/parts';
import { buckTransaction } from '../../kernel/test/fixtures.ts';

const placed = (csv: string, ref: string) => csv.split('\n').some((l) => l.startsWith(`${ref},`));

describe('do-not-populate parts in the production files', () => {
  it('a DNP capacitor is out of the BOM and the pick-and-place but keeps its pads and copper; cleared, it is back', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    k.transact({ summary: 'route', ops: [{ op: 'route' }] });
    k.transact({ summary: 'dnp', ops: [{ op: 'set_dnp', refs: ['C4'], dnp: true }] });
    const b = k.board();
    const c4 = b.parts.find((p) => p.refdes === 'C4')!;
    // still on the board: its pads on their nets, its copper routed and not made stale by the flag
    expect(b.routing).toBe('done');
    expect(c4.pads.map((p) => p.netId).every(Boolean)).toBe(true);
    for (const pad of c4.pads) expect(b.tracks.some((t) => t.netId === pad.netId)).toBe(true);
    // ... but not bought nor placed
    expect(bomLines(b).flatMap((l) => l.refs)).not.toContain('C4');
    for (const house of ['jlcpcb', 'eurocircuits', 'pcbway']) expect(bom(b, house)).not.toMatch(/\bC4\b/);
    expect(placed(pickAndPlace(b), 'C4')).toBe(false);
    expect(placed(pickAndPlace(b), 'C1')).toBe(true);
    expect(fabFiles(b, 'buck').find((f) => f.name === 'buck-PnP.csv')!.content).not.toMatch(/^C4,/m);

    k.transact({ summary: 'fit', ops: [{ op: 'set_dnp', refs: ['C4'], dnp: false }] });
    const again = k.board();
    expect(bomLines(again).flatMap((l) => l.refs)).toContain('C4');
    expect(placed(pickAndPlace(again), 'C4')).toBe(true);
  });

  it('the 3D view of the assembled board draws no body for a DNP part; fitted parts are drawn as before', () => {
    const k = new Kernel();
    k.transact(buckTransaction());
    const before = boardBodies(k.board(), { fitted: true });
    const id = (b: ReturnType<Kernel['board']>, ref: string) => b.parts.find((p) => p.refdes === ref)!.componentId;
    expect(before.has(id(k.board(), 'C4'))).toBe(true);
    k.transact({ summary: 'dnp', ops: [{ op: 'set_dnp', refs: ['C4'], dnp: true }] });
    const b = k.board();
    const fitted = boardBodies(b, { fitted: true });
    expect(fitted.has(id(b, 'C4'))).toBe(false);
    // its pads stay on the board; every other part keeps the very same body
    expect(b.parts.find((p) => p.refdes === 'C4')!.pads.length).toBeGreaterThan(0);
    expect([...fitted.keys()].sort()).toEqual([...before.keys()].filter((k) => k !== id(b, 'C4')).sort());
    for (const [k, body] of fitted) expect(body).toEqual(before.get(k));
    // the STEP export and the enclosure still see every part
    expect(boardBodies(b).has(id(b, 'C4'))).toBe(true);
  });
});
