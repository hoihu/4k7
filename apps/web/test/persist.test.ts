import { describe, expect, it } from 'vitest';
import { readStored } from '../src/lib/persist.ts';

interface Rec {
  id: string;
  n?: number;
}

describe('readStored', () => {
  it('reads current and unstamped records, without the stamp', () => {
    const r = readStored<Rec>([{ id: 'a' }, { id: 'b', format: 1 }], 1);
    expect(r).toEqual({ items: [{ id: 'a' }, { id: 'b' }], newer: 0 });
  });

  it('leaves out records written by a newer version and counts them', () => {
    const r = readStored<Rec>([{ id: 'a', format: 1 }, { id: 'b', format: 2 }], 1);
    expect(r).toEqual({ items: [{ id: 'a' }], newer: 1 });
  });

  it('upgrades older records, unstamped ones from format 1', () => {
    const r = readStored<Rec>([{ id: 'a' }, { id: 'b', format: 2 }, { id: 'c', format: 3 }], 3, (rec, from) => ({ ...rec, n: from }));
    expect(r.items).toEqual([{ id: 'a', n: 1 }, { id: 'b', n: 2 }, { id: 'c' }]);
  });
});
