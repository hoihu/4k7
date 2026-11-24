import { describe, expect, it } from 'vitest';
import { buck, twoBoards } from './fixtures.ts';
import type { Kernel } from '../src/index.ts';

/**
 * get_fab_profiles and the summary's stack-up on a design of several boards: each board answers
 * for its own layers, fab profile and stack-up, not the first board's. See docs/design/multi-board.md.
 */

/** Two boards that differ: the main board 4 layers at JLCPCB, the LED board 2 layers on JLCPCB's 2 oz tier with 20 °C heating. */
function differentBoards(): Kernel {
  const k = twoBoards();
  const r = k.transact({
    summary: 'profiles',
    ops: [
      { op: 'set_board', board: 'Main', layers: 4 },
      { op: 'set_fab_profile', board: 'Main', preset: 'jlcpcb/4l-1oz' },
      { op: 'set_fab_profile', board: 'LED board', preset: 'jlcpcb/2l-2oz' },
      { op: 'set_board', board: 'LED board', current_rise_c: 20 },
    ],
  });
  expect(r.status, JSON.stringify(r.rejection)).toBe('ok');
  k.accept();
  return k;
}

type Profiles = { board?: string; layers?: number; current: 'none' | { id: string }; presets: unknown[]; how: string; boards?: { board: string; layers: number; current: 'none' | { id: string }; how: string }[] };

describe('get_fab_profiles on several boards', () => {
  it('a named board answers with its own layers and profile', () => {
    const k = differentBoards();
    const led = k.query({ op: 'get_fab_profiles', board: 'LED board' }) as Profiles;
    expect(led.board).toBe('LED board');
    expect(led.layers).toBe(2);
    expect(led.current).toMatchObject({ id: 'jlcpcb/2l-2oz' });
    expect(led.how).toMatch(/2 layers/);
    expect(led.presets.length).toBeGreaterThan(0);
    const main = k.query({ op: 'get_fab_profiles', board: 'Main' }) as Profiles;
    expect(main.layers).toBe(4);
    expect(main.current).toMatchObject({ id: 'jlcpcb/4l-1oz' });
  });

  it('without a board answers for every board, in board order', () => {
    const k = differentBoards();
    const all = k.query({ op: 'get_fab_profiles' }) as Profiles;
    expect(all.boards?.map((b) => [b.board, b.layers])).toEqual([['Main', 4], ['LED board', 2]]);
    expect(all.boards![0]!.current).toMatchObject({ id: 'jlcpcb/4l-1oz' });
    expect(all.boards![1]!.current).toMatchObject({ id: 'jlcpcb/2l-2oz' });
    expect(all.presets.length).toBeGreaterThan(0);
    expect(all).not.toHaveProperty('current');
  });

  it('an unknown board is refused with the boards there are', () => {
    const k = differentBoards();
    const bad = k.query({ op: 'get_fab_profiles', board: 'Nope' }) as { error?: string; boards?: string[] };
    expect(bad.error).toBe('No board "Nope".');
    expect(bad.boards).toHaveLength(2);
  });

  it('one board answers as before, without a board name', () => {
    const k = buck();
    const one = k.query({ op: 'get_fab_profiles' }) as Profiles;
    expect(one.current).toBe('none');
    expect(one).not.toHaveProperty('boards');
    expect(one).not.toHaveProperty('board');
    expect(one.how).toMatch(/2 layers/);
  });
});

type Summary = { stackup?: { name: string; copper: number[] }; currentRise?: number; boards?: { name: string; stackup: { copper: number[] }; currentRise?: number }[] };

describe('the summary\'s stack-up on several boards', () => {
  it('gives each board its own stack-up and heating, and no design-wide one', () => {
    const s = differentBoards().summary() as Summary;
    expect(s.stackup).toBeUndefined();
    expect(s.currentRise).toBeUndefined();
    expect(s.boards!.map((b) => b.stackup.copper.length)).toEqual([4, 2]);
    expect(s.boards![0]!.currentRise).toBeUndefined();
    expect(s.boards![1]!.currentRise).toBe(20);
  });

  it('one board keeps the design-wide stack-up', () => {
    const s = buck().summary() as Summary;
    expect(s.stackup?.copper).toHaveLength(2);
    expect(s.boards).toBeUndefined();
  });
});
