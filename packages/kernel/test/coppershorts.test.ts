import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '@4k7/schema';
import { Kernel } from '../src/index.ts';
import { buckTransaction } from './fixtures.ts';

// Copper of two nets that touches is in get_diagnostics, as the board DRC finds it: in 0.6.x a
// board read back from its Gerbers had two shorts (two parts' pads touching; a GND track over a
// module's unconnected pad that a land pattern edit moved under it) while get_diagnostics was clean.

function buck(drawn: boolean) {
  const k = new Kernel();
  k.transact(buckTransaction());
  k.accept();
  if (drawn) ok(k, [{ op: 'set_copper_mode', mode: 'drawn', keep: false }]);
  return k;
}
const ok = (k: Kernel, ops: unknown[]) => {
  const r = k.transact({ summary: 'test', ops });
  if (r.status !== 'ok') throw new Error(JSON.stringify(r));
};
const copper = (k: Kernel) => (k.query({ op: 'get_diagnostics' }) as Diagnostic[]).filter((x) => x.code === 'DRC.SHORT' || x.code === 'DRC.CLEARANCE');

// The buck's U1 is an SO-8 at 13.85, 11.005; its pad 3 (not connected) at 11.2, 11.64.
const so8 = [1, 2, 3, 4].map((n) => ({ number: String(n), x: -2.65, y: -1.905 + (n - 1) * 1.27, w: 1.4, h: 0.52 })).concat([5, 6, 7, 8].map((n) => ({ number: String(n), x: 2.65, y: 1.905 - (n - 5) * 1.27, w: 1.4, h: 0.52 })));
// a GND track left of U1, clear of everything
const gndTrack = { op: 'draw_track', net: 'GND', from: [7.6, 12.3], to: [9.7, 12.3] };

describe('copper shorts in get_diagnostics', () => {
  it('pads of two parts on different nets that touch are a short, routed or not', () => {
    for (const drawn of [false, true]) {
      const k = buck(drawn);
      // R1.1 (+3V3) onto R2.2 (GND), both held where they are put
      ok(k, [
        { op: 'place', ref: 'R2', x_mm: 16.8, y_mm: 15.486, rot: 90, lock: true },
        { op: 'place', ref: 'R1', x_mm: 16.3, y_mm: 15.486, rot: 270, lock: true },
      ]);
      const d = copper(k);
      expect(d).toHaveLength(1);
      expect(d[0]!.code).toBe('DRC.SHORT');
      expect(d[0]!.message).toMatch(/R1\.1 \(\+3V3\) touches R2\.2 \(GND\)|R2\.2 \(GND\) touches R1\.1 \(\+3V3\)/);
      expect(d[0]!.message).toContain('Move R');
      expect(d[0]!.entities).toEqual(expect.arrayContaining(['R1', 'R2']));
    }
  });

  it('a track across a pad on no net is a short', () => {
    const k = buck(true);
    ok(k, [{ op: 'draw_track', net: 'GND', from: [9.6, 11.64], to: [11.4, 11.64] }]);
    const d = copper(k).filter((x) => x.code === 'DRC.SHORT');
    expect(d).toHaveLength(1);
    expect(d[0]!.message).toBe('track t1 (GND) touches U1.3 (not connected) on F.Cu (short). Move t1 clear (edit_copper move or via), or erase_copper t1 and draw it again round it.');
    expect(d[0]!.entities).toEqual(['U1', 't1']);
  });

  it('a land pattern edit that moves a pad under copper is flagged next time', () => {
    const k = buck(true);
    ok(k, [gndTrack]);
    expect(copper(k)).toEqual([]);
    // pad 3 out to the left, under the track (pads re-centred, as an edit of the part's pads does)
    ok(k, [{ op: 'set_footprint', ref: 'U1', name: 'SO8_EDITED', pads: so8.map((p) => (p.number === '3' ? { ...p, x: -3.9, y: 1.3 } : p)) }]);
    const d = copper(k);
    expect(d.map((x) => x.code)).toEqual(['DRC.SHORT']);
    expect(d[0]!.message).toMatch(/^track t1 \(GND\) touches U1\.3 \(not connected\) on F\.Cu/);
  });

  it('finds nothing where the copper is clear', () => {
    const k = buck(true);
    ok(k, [gndTrack, { op: 'set_footprint', ref: 'U1', name: 'SO8_SAME', pads: so8 }]);
    expect(copper(k)).toEqual([]);
    const routed = buck(false);
    ok(routed, [{ op: 'route' }]);
    expect(routed.board().routing).toBe('done');
    expect(copper(routed)).toEqual([]);
  });
});
